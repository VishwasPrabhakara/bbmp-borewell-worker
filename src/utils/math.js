import { CRITICAL_GW_DECLINE_FT_PER_WEEK, TREND_SIGNIFICANCE_ALPHA } from "../config/constants.js";

export function median(values) {
  const sorted = values.filter(value => Number.isFinite(value)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function percentile(values, probability) {
  const sorted = values.filter(value => Number.isFinite(value)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

export function roundNumber(value, decimals = 4) {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return null;
  const factor = 10 ** decimals;
  return Math.round(numberValue * factor) / factor;
}

export function criticalDirection(changeFtPerWeek) {
  if (!Number.isFinite(changeFtPerWeek)) return "Not computed";
  if (changeFtPerWeek > CRITICAL_GW_DECLINE_FT_PER_WEEK) return "Declining";
  if (changeFtPerWeek < -CRITICAL_GW_DECLINE_FT_PER_WEEK) return "Improving";
  return "Mostly stable";
}

export function normalCdf(value) {
  const sign = value < 0 ? -1 : 1;
  const x = Math.abs(value) / Math.sqrt(2);
  const t = 1 / (1 + 0.3275911 * x);
  const erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return 0.5 * (1 + sign * erf);
}

export function trendMethods(points, comparisons = [], options = {}) {
  const keepZeroLevels = Boolean(options.keepZeroLevels);
  const compressIndex = Boolean(options.compressIndex);
  const usablePoints = (points || [])
    .filter(point => (
      keepZeroLevels
        ? Number.isFinite(Number(point.level))
        : (point.level !== null && point.level !== undefined && point.level !== "" && Number.isFinite(Number(point.level)) && Number(point.level) > 0)
    ) && Number.isFinite(Number(point.index)))
    .sort((a, b) => a.index - b.index)
    .map((point, index) => ({
      ...point,
      fitIndex: compressIndex ? index : point.index
    }));
  const n = usablePoints.length;
  if (n < 2) {
    return {
      linearSlopeFtPerWeek: null,
      linearSlopeFtPerDay: null,
      linearR2: null,
      senSlopeFtPerWeek: null,
      senSlopeFtPerDay: null,
      mannKendallS: null,
      mannKendallZ: null,
      mannKendallPValue: null,
      mannKendallTrend: "Not computed"
    };
  }

  const meanX = usablePoints.reduce((sum, point) => sum + point.fitIndex, 0) / n;
  const meanY = usablePoints.reduce((sum, point) => sum + point.level, 0) / n;
  const denominator = usablePoints.reduce((sum, point) => sum + ((point.fitIndex - meanX) ** 2), 0);
  const linearSlope = denominator
    ? usablePoints.reduce((sum, point) => sum + ((point.fitIndex - meanX) * (point.level - meanY)), 0) / denominator
    : null;
  const intercept = Number.isFinite(linearSlope) ? meanY - linearSlope * meanX : null;
  const totalSquares = usablePoints.reduce((sum, point) => sum + ((point.level - meanY) ** 2), 0);
  const residualSquares = Number.isFinite(intercept)
    ? usablePoints.reduce((sum, point) => {
      const expected = intercept + linearSlope * point.fitIndex;
      return sum + ((point.level - expected) ** 2);
    }, 0)
    : null;

  const pairSlopes = [];
  for (let i = 0; i < usablePoints.length - 1; i += 1) {
    for (let j = i + 1; j < usablePoints.length; j += 1) {
      const dx = usablePoints[j].fitIndex - usablePoints[i].fitIndex;
      if (dx > 0) pairSlopes.push((usablePoints[j].level - usablePoints[i].level) / dx);
    }
  }
  const senSlope = median(pairSlopes);

  let s = 0;
  for (let i = 0; i < usablePoints.length - 1; i += 1) {
    for (let j = i + 1; j < usablePoints.length; j += 1) {
      const diff = usablePoints[j].level - usablePoints[i].level;
      s += diff > 0 ? 1 : diff < 0 ? -1 : 0;
    }
  }
  const tieCounts = new Map();
  for (const point of usablePoints) {
    const key = String(roundNumber(point.level, 6));
    tieCounts.set(key, (tieCounts.get(key) || 0) + 1);
  }
  const tieAdjustment = Array.from(tieCounts.values())
    .filter(count => count > 1)
    .reduce((sum, count) => sum + count * (count - 1) * (2 * count + 5), 0);
  const variance = (n * (n - 1) * (2 * n + 5) - tieAdjustment) / 18;
  const z = variance > 0
    ? s > 0 ? (s - 1) / Math.sqrt(variance) : s < 0 ? (s + 1) / Math.sqrt(variance) : 0
    : null;
  const pValue = Number.isFinite(z) ? 2 * (1 - normalCdf(Math.abs(z))) : null;

  return {
    linearSlopeFtPerWeek: roundNumber(linearSlope, 4),
    linearSlopeFtPerDay: roundNumber(Number.isFinite(linearSlope) ? linearSlope / 7 : null, 4),
    linearR2: roundNumber(totalSquares > 0 && Number.isFinite(residualSquares) ? 1 - residualSquares / totalSquares : null, 4),
    senSlopeFtPerWeek: roundNumber(senSlope, 4),
    senSlopeFtPerDay: roundNumber(Number.isFinite(senSlope) ? senSlope / 7 : null, 4),
    mannKendallS: s,
    mannKendallZ: roundNumber(z, 4),
    mannKendallPValue: roundNumber(pValue, 4),
    mannKendallTrend: s > 0 ? "Increasing depth / declining groundwater" : s < 0 ? "Decreasing depth / improving groundwater" : "No monotonic trend"
  };
}

export function combinedGroundwaterStatus(methods, hasEnough) {
  if (!hasEnough) return { status: "Insufficient data", direction: "Not computed", evidence: "insufficient", votes: 0 };
  const linear = Number(methods.linearSlopeFtPerWeek);
  const mkS = Number(methods.mannKendallS);
  const mkP = Number(methods.mannKendallPValue);
  const significant = Number.isFinite(mkP) && mkP <= TREND_SIGNIFICANCE_ALPHA;
  const decliningMagnitude = Number.isFinite(linear) && linear > CRITICAL_GW_DECLINE_FT_PER_WEEK;
  const improvingMagnitude = Number.isFinite(linear) && linear < -CRITICAL_GW_DECLINE_FT_PER_WEEK;
  if (decliningMagnitude && mkS > 0 && significant) {
    return { status: "Critical", direction: "Declining", evidence: "confirmed", votes: 2 };
  }
  if (improvingMagnitude && mkS < 0 && significant) {
    return { status: "Normal", direction: "Improving", evidence: "confirmed", votes: -2 };
  }
  if (decliningMagnitude && mkS > 0) {
    return { status: "Watch", direction: "Possible decline", evidence: "emerging", votes: 1 };
  }
  if (improvingMagnitude && mkS < 0) {
    return { status: "Normal", direction: "Possible improvement", evidence: "emerging", votes: -1 };
  }
  return { status: "Normal", direction: "Mostly stable", evidence: "stable", votes: 0 };
}
