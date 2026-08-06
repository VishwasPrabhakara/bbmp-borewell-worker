import {
  CRITICAL_GW_MIN_WEEKS,
  CRITICAL_GW_MIN_COMPARISONS,
  CRITICAL_GW_MAX_WEEK_GAP,
  CRITICAL_GW_RELATIVE_JUMP_RATIO,
  CRITICAL_GW_MIN_LARGE_JUMP_FT,
  PREVIOUS_CRITICAL_WARDS
} from "../config/constants.js";
import { median, roundNumber, trendMethods, combinedGroundwaterStatus } from "./math.js";
import { weeklyLabel, weekNumberForDate } from "./date.js";

export function normalizeWardNoValue(value) {
  const numberValue = Number(value);
  if (Number.isFinite(numberValue)) return String(Math.trunc(numberValue));
  return String(value ?? "").trim().replace(/\.0+$/, "");
}

export function isValidWaterLevel(value) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) && numberValue > 0;
}

export function primaryLevel(point) {
  if (isValidWaterLevel(point.onLevel)) return Number(point.onLevel);
  if (isValidWaterLevel(point.waterLevel)) return Number(point.waterLevel);
  if (isValidWaterLevel(point.offLevel)) return Number(point.offLevel);
  return null;
}

export function localMedian(points, index, radius, key) {
  const start = Math.max(0, index - radius);
  const end = Math.min(points.length, index + radius + 1);
  return median(points.slice(start, end).map(point => Number(point[key])));
}

export function localMad(points, index, radius, key, center) {
  const start = Math.max(0, index - radius);
  const end = Math.min(points.length, index + radius + 1);
  return median(points.slice(start, end).map(point => Math.abs(Number(point[key]) - center)));
}

export function smoothExpected(points, index, radius, key) {
  const previous = [];
  const next = [];
  for (let cursor = index - 1; cursor >= 0 && previous.length < radius; cursor -= 1) previous.push(points[cursor]);
  for (let cursor = index + 1; cursor < points.length && next.length < radius; cursor += 1) next.push(points[cursor]);
  const neighbours = previous.concat(next).map(point => Number(point[key])).filter(Number.isFinite);
  return median(neighbours);
}

export function cleanShortLevelSeries(points, key) {
  if (points.length < 2) return points;
  const jumpLimit = 80;
  if (points.length === 2) {
    return Math.abs(Number(points[1][key]) - Number(points[0][key])) > jumpLimit ? [] : points;
  }

  let cleaned = points.slice();
  let changed = true;
  while (changed && cleaned.length >= 3) {
    changed = false;
    const firstJump = Math.abs(Number(cleaned[1][key]) - Number(cleaned[0][key]));
    const secondJump = Math.abs(Number(cleaned[2][key]) - Number(cleaned[1][key]));
    const firstToThird = Math.abs(Number(cleaned[2][key]) - Number(cleaned[0][key]));
    if (firstJump > jumpLimit && secondJump <= jumpLimit) {
      cleaned = cleaned.slice(1);
      changed = true;
      continue;
    }
    if (firstJump > jumpLimit && firstToThird <= jumpLimit) {
      cleaned.splice(1, 1);
      changed = true;
      continue;
    }

    const last = cleaned.length - 1;
    const lastJump = Math.abs(Number(cleaned[last][key]) - Number(cleaned[last - 1][key]));
    const previousJump = Math.abs(Number(cleaned[last - 1][key]) - Number(cleaned[last - 2][key]));
    const lastToPreviousPrevious = Math.abs(Number(cleaned[last][key]) - Number(cleaned[last - 2][key]));
    if (lastJump > jumpLimit && previousJump <= jumpLimit) {
      cleaned = cleaned.slice(0, last);
      changed = true;
      continue;
    }
    if (lastJump > jumpLimit && lastToPreviousPrevious <= jumpLimit) {
      cleaned.splice(last - 1, 1);
      changed = true;
    }
  }

  if (cleaned.length === 2 && Math.abs(Number(cleaned[1][key]) - Number(cleaned[0][key])) > jumpLimit) return [];
  return cleaned;
}

export function dominantContinuousSegment(points, key) {
  if (points.length < 3) return [];
  const jumpLimit = 80;
  const segments = [];
  let current = [points[0]];
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const point = points[index];
    if (Math.abs(Number(point[key]) - Number(previous[key])) > jumpLimit) {
      segments.push(current);
      current = [point];
    } else {
      current.push(point);
    }
  }
  segments.push(current);
  if (segments.length === 1) return points;

  segments.sort((a, b) => {
    if (b.length !== a.length) return b.length - a.length;
    return new Date(b[b.length - 1].time) - new Date(a[a.length - 1].time);
  });
  return segments[0].length >= 3 ? segments[0] : [];
}

export function cleanLevelPoints(points) {
  const sorted = points
    .map(point => ({ ...point, level: primaryLevel(point) }))
    .filter(point => isValidWaterLevel(point.level) && point.time)
    .sort((a, b) => new Date(a.time) - new Date(b.time));

  const uniqueLevels = new Set(sorted.map(point => roundNumber(point.level, 2)));
  if (sorted.length >= 2 && uniqueLevels.size <= 1) return [];

  if (sorted.length < 5) return dominantContinuousSegment(cleanShortLevelSeries(sorted, "level"), "level");

  const values = sorted.map(point => point.level);
  const center = median(values);
  const deviations = values.map(value => Math.abs(value - center));
  const mad = median(deviations);
  const globalMad = Number.isFinite(mad) && mad > 0 ? mad : median(values.slice(1).map((value, index) => Math.abs(value - values[index]))) || 10;
  const localRadius = sorted.length >= 9 ? 3 : 2;

  const cleaned = sorted.filter((point, index) => {
    const localCenter = localMedian(sorted, index, localRadius, "level");
    const localDeviation = localMad(sorted, index, localRadius, "level", localCenter);
    const localLimit = Math.max(25, (Number.isFinite(localDeviation) && localDeviation > 0 ? localDeviation : globalMad) * 4);
    const failsRollingMedian = Number.isFinite(localCenter) && Math.abs(point.level - localCenter) > localLimit;

    const smoothCenter = smoothExpected(sorted, index, localRadius, "level");
    const smoothLimit = Math.max(35, globalMad * 5);
    const failsSmoothTrend = Number.isFinite(smoothCenter) && Math.abs(point.level - smoothCenter) > smoothLimit;

    let failsSlopeReversal = false;
    if (index > 0 && index < sorted.length - 1) {
      const previous = sorted[index - 1];
      const next = sorted[index + 1];
      const previousJump = Math.abs(point.level - previous.level);
      const nextJump = Math.abs(point.level - next.level);
      const neighbourJump = Math.abs(next.level - previous.level);
      const jumpLimit = Math.max(40, globalMad * 5);
      const neighbourLimit = Math.max(25, globalMad * 3);
      failsSlopeReversal = previousJump > jumpLimit && nextJump > jumpLimit && neighbourJump <= neighbourLimit;
    }

    const residualLimit = Math.max(50, globalMad * 6);
    const failsHampel = Number.isFinite(center) && Math.abs(point.level - center) > residualLimit;

    return !(failsRollingMedian || failsSmoothTrend || failsSlopeReversal || failsHampel);
  });
  return dominantContinuousSegment(cleaned, "level");
}

export function rollingWeeklyPointsFromCleaned(cleaned) {
  const selected = [];
  let previousTime = null;
  for (const point of cleaned) {
    const time = new Date(point.time);
    if (!previousTime || (time - previousTime) / 86400000 >= 7) {
      previousTime = time;
      selected.push({
        label: weeklyLabel(time.getUTCFullYear(), time.getUTCMonth() + 1, weekNumberForDate(time)),
        time: point.time,
        level: roundNumber(point.level, 2)
      });
    }
  }
  return selected;
}

export function rollingWeeklyPoints(points) {
  return rollingWeeklyPointsFromCleaned(cleanLevelPoints(points));
}

export function dropPerDay(points) {
  const available = points
    .filter(point => Number.isFinite(point.level) && point.time)
    .sort((a, b) => new Date(a.time) - new Date(b.time));
  const drops = [];
  for (let index = 0; index < available.length - 1; index += 1) {
    const current = available[index];
    const next = available[index + 1];
    const days = (new Date(next.time) - new Date(current.time)) / 86400000;
    if (days > 0) drops.push((next.level - current.level) / days);
  }
  return drops.length ? roundNumber(drops.reduce((sum, value) => sum + value, 0) / drops.length, 4) : null;
}

export function consecutiveDrops(points) {
  const drops = [];
  for (let index = 0; index < points.length - 1; index += 1) {
    const current = points[index];
    const next = points[index + 1];
    const days = (new Date(next.time) - new Date(current.time)) / 86400000;
    if (days <= 0) continue;
    const drop = next.level - current.level;
    drops.push({
      label: next.label || new Date(next.time).toISOString().slice(0, 10),
      time: next.time,
      dropFt: roundNumber(drop, 3),
      dropFtPerDay: roundNumber(drop / days, 4),
      dropFtPerHour: roundNumber(drop / (days * 24), 5)
    });
  }
  return drops;
}

export function sessionDrawdowns(points) {
  return points
    .filter(point => isValidWaterLevel(point.onLevel)
      && isValidWaterLevel(point.offLevel)
      && Number(point.onLevel) > Number(point.offLevel)
      && Number(point.runtimeHours) > 0)
    .map(point => {
      const drop = Number(point.onLevel) - Number(point.offLevel);
      return {
        label: new Date(point.time).toISOString().slice(0, 10),
        time: point.time,
        dropFt: roundNumber(drop, 3),
        dropFtPerHour: roundNumber(drop / Number(point.runtimeHours), 5)
      };
    });
}

export function weekIndexMap(weeks) {
  return new Map((weeks || []).map((label, index) => [label, index]));
}

export function isUsableCriticalLevel(value) {
  return value !== null
    && value !== undefined
    && value !== ""
    && Number.isFinite(Number(value))
    && Number(value) > 0;
}

export function validCriticalComparisons(weekly, weeks, options = {}) {
  const keepBlankAsZero = Boolean(options.keepBlankAsZero);
  const positions = weekIndexMap(weeks);
  const points = (weekly || [])
    .filter(point => keepBlankAsZero ? Number.isFinite(Number(point.averageLevel)) : isUsableCriticalLevel(point.averageLevel))
    .map(point => ({
      label: point.label,
      level: Number(point.averageLevel),
      index: positions.has(point.label) ? positions.get(point.label) : null,
      sensorCount: Number(point.sensorCount || 0)
    }))
    .filter(point => point.index !== null)
    .sort((a, b) => a.index - b.index);

  const comparisons = [];
  const skipped = [];
  for (let index = 0; index < points.length - 1; index += 1) {
    const current = points[index];
    const next = points[index + 1];
    const gap = next.index - current.index;
    if (gap <= 0 || gap > CRITICAL_GW_MAX_WEEK_GAP) {
      skipped.push(`${current.label} to ${next.label}: skipped because weekly gap is ${gap} week positions`);
      continue;
    }
    const delta = next.level - current.level;
    const smaller = Math.max(Math.min(Math.abs(current.level), Math.abs(next.level)), 1);
    const ratio = Math.max(Math.abs(current.level), Math.abs(next.level)) / smaller;
    if (Math.abs(delta) >= CRITICAL_GW_MIN_LARGE_JUMP_FT && ratio >= CRITICAL_GW_RELATIVE_JUMP_RATIO) {
      skipped.push(`${current.label} to ${next.label}: skipped as likely sensor/data jump (${roundNumber(current.level, 2)} ft to ${roundNumber(next.level, 2)} ft)`);
      continue;
    }
    comparisons.push({
      fromLabel: current.label,
      toLabel: next.label,
      gap,
      startLevel: current.level,
      endLevel: next.level,
      changeFt: delta,
      changeFtPerWeek: delta / gap,
      changeFtPerDay: delta / (gap * 7),
      sensorCount: Math.min(current.sensorCount, next.sensorCount)
    });
  }
  const comparisonLabels = new Set(comparisons.flatMap(item => [item.fromLabel, item.toLabel]));
  const trendPoints = points.filter(point => comparisonLabels.has(point.label));
  return { points: trendPoints, comparisons, skipped };
}

export function notUsableReason(row) {
  const flags = (Array.isArray(row.flags) ? row.flags : []).filter(flag => flag !== "NO_DISCHARGE");
  const rangeDetails = [];
  if (Number(row.water_negative_count) > 0) {
    rangeDetails.push(`${row.water_negative_count} water-level values are negative`);
  }
  if (Number(row.water_too_deep_count) > 0) {
    rangeDetails.push(`${row.water_too_deep_count} water-level/on/off values exceed 1500 ft`);
  }
  if (Number(row.discharge_negative_count) > 0) {
    rangeDetails.push(`${row.discharge_negative_count} discharge values are negative`);
  }
  if (Number(row.discharge_too_high_count) > 0) {
    rangeDetails.push(`${row.discharge_too_high_count} discharge values exceed 20000 LPM`);
  }
  if (Number(row.on_off_logic_error_count) > 0) {
    rangeDetails.push(`${row.on_off_logic_error_count} readings have ON level less than or equal to OFF level`);
  }
  const descriptions = {
    NO_DATA: "No sensor readings are available.",
    TOO_FEW_READINGS: `Only ${row.total_readings || 0} readings are available, so the sensor does not have enough observations for reliable trend analysis.`,
    NO_WATER_LEVEL: "No water-level readings are available from this sensor.",
    STALE_DATA: `Latest reading is old${row.stale_data_days != null ? ` (${Math.round(Number(row.stale_data_days))} days stale)` : ""}.`,
    RANGE_ERRORS: rangeDetails.length
      ? `Invalid value details: ${rangeDetails.join("; ")}.`
      : `${row.range_error_count || 0} values failed range checks. Detailed subtype counts will appear after rerunning sensor QC.`,
    LONG_GAPS: `${row.gap_count || 0} long gaps found in the time series${row.max_gap_hours ? `; maximum gap is ${roundNumber(row.max_gap_hours, 1)} hours` : ""}.`,
    SPIKES: `${row.spike_count || 0} sudden spike/drop events detected between consecutive readings.`,
    FLATLINES: `${row.flatline_count || 0} flatline stretches detected, suggesting the sensor may be stuck or not updating.`,
    DUPLICATE_TIMESTAMPS: "Duplicate timestamps were found in the raw readings.",
    OUTSIDE_BBMP_BOUNDARY: "Sensor location falls outside the BBMP ward boundary layer."
  };

  const reasons = flags.map(flag => descriptions[flag] || flag.replace(/_/g, " ").toLowerCase());
  if (!reasons.length) {
    return "Sensor has data but did not meet GOOD quality criteria. Review water-level continuity and recent data availability.";
  }
  return reasons.join(" ");
}

export function weeklyWardPayload(rows, qcRows, includeSensorDetails = false) {
  const weekMap = new Map();
  const sensorMap = new Map();
  const wardMap = new Map();

  for (const row of rows) {
    const wardKey = String(row.ward_no);
    if (!wardMap.has(wardKey)) {
      wardMap.set(wardKey, {
        wardNo: row.ward_no,
        wardName: row.ward_name,
        totalSensors: 0,
        goodSensors: 0,
        qcGoodSensorCount: 0,
        notUsableSensors: 0,
        goodPercent: 0,
        avgDropPerDay: null,
        medianDropPerDay: null,
        maxDropPerDay: null,
        dropAllPositive: false,
        dropSensorCount: 0,
        plottedGoodSensorCount: 0,
        goodSensorUids: [],
        noWeeklyDataUids: [],
        uidCount: 0,
        weekly: [],
        sensors: []
      });
    }

    const sensorKey = String(row.uid);
    if (!sensorMap.has(sensorKey)) {
      sensorMap.set(sensorKey, {
        uid: sensorKey,
        wardNo: row.ward_no,
        wardName: row.ward_name,
        dropPerDay: null,
        isQcGood: false,
        rawPoints: []
      });
    }
    sensorMap.get(sensorKey).rawPoints.push({
      time: row.reading_time,
      waterLevel: row.water_level_ft,
      onLevel: row.on_level,
      offLevel: row.off_level,
      runtimeHours: row.runtime_hours
    });
  }

  for (const row of qcRows) {
    const wardKey = String(row.ward_no);
    if (!wardMap.has(wardKey)) {
      wardMap.set(wardKey, {
        wardNo: row.ward_no,
        wardName: row.ward_name,
        totalSensors: 0,
        goodSensors: 0,
        qcGoodSensorCount: 0,
        notUsableSensors: 0,
        goodPercent: 0,
        avgDropPerDay: null,
        medianDropPerDay: null,
        maxDropPerDay: null,
        dropAllPositive: false,
        dropSensorCount: 0,
        plottedGoodSensorCount: 0,
        goodSensorUids: [],
        noWeeklyDataUids: [],
        uidCount: 0,
        weekly: [],
        sensors: []
      });
    }
    const ward = wardMap.get(wardKey);
    ward.totalSensors += 1;
    if (row.qc_status === "GOOD") {
      ward.qcGoodSensorCount += 1;
      ward.goodSensorUids.push(String(row.uid));
      if (!sensorMap.has(String(row.uid))) {
        sensorMap.set(String(row.uid), {
          uid: String(row.uid),
          wardNo: row.ward_no,
          wardName: row.ward_name,
          dropPerDay: null,
          isQcGood: true,
          rawPoints: []
        });
      } else {
        sensorMap.get(String(row.uid)).isQcGood = true;
      }
    }
  }

  const sensors = Array.from(sensorMap.values()).map(sensor => {
    const cleanedDaily = cleanLevelPoints(sensor.rawPoints);
    const weeklyPoints = rollingWeeklyPointsFromCleaned(cleanedDaily);
    const dailyDrops = includeSensorDetails ? consecutiveDrops(cleanedDaily.map(point => ({
      label: new Date(point.time).toISOString().slice(0, 10),
      time: point.time,
      level: point.level
    }))) : [];
    const weeklyDrops = includeSensorDetails ? consecutiveDrops(weeklyPoints) : [];
    const drawdowns = includeSensorDetails ? sessionDrawdowns(cleanedDaily) : [];
    return {
      uid: sensor.uid,
      wardNo: sensor.wardNo,
      wardName: sensor.wardName,
      isQcGood: Boolean(sensor.isQcGood),
      dropPerDay: dropPerDay(weeklyPoints),
      points: weeklyPoints.map(({ label, time, level }) => ({ label, time, level })),
      ...(includeSensorDetails ? {
        dailyLevels: cleanedDaily.map(point => ({
          label: new Date(point.time).toISOString().slice(0, 10),
          time: point.time,
          waterLevel: roundNumber(point.waterLevel, 2),
          onLevel: isValidWaterLevel(point.onLevel) ? roundNumber(point.onLevel, 2) : null,
          offLevel: isValidWaterLevel(point.offLevel) ? roundNumber(point.offLevel, 2) : null,
          primaryLevel: roundNumber(point.level, 2)
        })),
        dailyDrops,
        sessionDrawdowns: drawdowns,
        weeklyDrops
      } : {})
    };
  });

  const allWeekLabels = [];
  const weekTimes = new Map();
  for (const sensor of sensors.filter(sensor => sensor.isQcGood && sensor.points.length > 0)) {
    for (const point of sensor.points) {
      if (!allWeekLabels.includes(point.label)) allWeekLabels.push(point.label);
      const timeValue = new Date(point.time).getTime();
      if (!weekTimes.has(point.label) || timeValue < weekTimes.get(point.label)) {
        weekTimes.set(point.label, timeValue);
      }
    }
  }
  allWeekLabels.sort((a, b) => (weekTimes.get(a) || 0) - (weekTimes.get(b) || 0));

  for (const sensor of sensors) {
    const weekly = sensor.points.map(point => ({
      label: point.label,
      averageLevel: point.level,
      sensorCount: 1
    }));
    const { points, comparisons } = validCriticalComparisons(weekly, allWeekLabels);
    const hasEnough = points.length >= CRITICAL_GW_MIN_WEEKS
      && comparisons.length >= CRITICAL_GW_MIN_COMPARISONS;
    const methods = trendMethods(points, comparisons);
    const classification = combinedGroundwaterStatus(methods, hasEnough);
    sensor.groundwaterTrend = {
      classification: classification.direction,
      status: classification.status,
      evidence: classification.evidence,
      usableWeeklyValues: points.length,
      validWeeklyComparisons: comparisons.length,
      theilSenSlopeFtPerWeek: methods.senSlopeFtPerWeek,
      theilSenSlopeFtPerDay: methods.senSlopeFtPerDay,
      mannKendallS: methods.mannKendallS,
      mannKendallPValue: methods.mannKendallPValue,
      linearSlopeFtPerWeek: methods.linearSlopeFtPerWeek,
      linearR2: methods.linearR2
    };
  }

  for (const sensor of sensors) {
    const ward = wardMap.get(String(sensor.wardNo));
    if (ward && sensor.isQcGood) ward.sensors.push(sensor);
  }

  for (const ward of wardMap.values()) {
    const plottableSensors = ward.sensors.filter(sensor => sensor.points.length > 0);
    const plottableUidSet = new Set(plottableSensors.map(sensor => String(sensor.uid)));
    ward.noWeeklyDataUids = ward.goodSensorUids.filter(uid => !plottableUidSet.has(String(uid)));
    ward.plottedGoodSensorCount = plottableSensors.length;
    ward.goodSensors = plottableSensors.length;
    ward.notUsableSensors = Math.max(ward.totalSensors - ward.goodSensors, 0);
    ward.goodPercent = ward.totalSensors ? roundNumber((ward.goodSensors / ward.totalSensors) * 100, 1) : 0;
    ward.uidCount = plottableSensors.length;
    ward.sensors = plottableSensors;
    const wardDrops = ward.sensors.map(sensor => sensor.dropPerDay).filter(value => Number.isFinite(value));
    ward.dropSensorCount = wardDrops.length;
    ward.avgDropPerDay = wardDrops.length ? roundNumber(wardDrops.reduce((sum, value) => sum + value, 0) / wardDrops.length, 4) : null;
    ward.medianDropPerDay = wardDrops.length ? roundNumber(median(wardDrops), 4) : null;
    ward.maxDropPerDay = wardDrops.length ? roundNumber(Math.max(...wardDrops), 4) : null;
    ward.dropAllPositive = wardDrops.length ? wardDrops.every(value => value > 0) : false;
    const classifiedSensors = ward.sensors.filter(sensor => sensor.groundwaterTrend?.evidence !== "insufficient");
    const confirmedDecliningSensors = classifiedSensors.filter(sensor => sensor.groundwaterTrend?.evidence === "confirmed"
      && sensor.groundwaterTrend?.classification === "Declining");
    const possibleDecliningSensors = classifiedSensors.filter(sensor => ["Declining", "Possible decline"]
      .includes(sensor.groundwaterTrend?.classification));
    const improvingSensors = classifiedSensors.filter(sensor => ["Improving", "Possible improvement"]
      .includes(sensor.groundwaterTrend?.classification));
    const sensorSlopes = classifiedSensors
      .map(sensor => Number(sensor.groundwaterTrend?.theilSenSlopeFtPerWeek))
      .filter(Number.isFinite);
    ward.trendSensorSummary = {
      classifiedSensorCount: classifiedSensors.length,
      confirmedDecliningSensorCount: confirmedDecliningSensors.length,
      decliningSensorCount: possibleDecliningSensors.length,
      improvingSensorCount: improvingSensors.length,
      medianTheilSenSlopeFtPerWeek: roundNumber(median(sensorSlopes), 4),
      decliningSensorPercent: classifiedSensors.length
        ? roundNumber((possibleDecliningSensors.length / classifiedSensors.length) * 100, 1)
        : null,
      confirmedDecliningSensorPercent: classifiedSensors.length
        ? roundNumber((confirmedDecliningSensors.length / classifiedSensors.length) * 100, 1)
        : null
    };
    ward.weekly = allWeekLabels.map(label => {
      const values = ward.sensors
        .map(sensor => sensor.points.find(point => point.label === label)?.level)
        .filter(value => Number.isFinite(value));
      return {
        label,
        averageLevel: values.length ? roundNumber(values.reduce((sum, value) => sum + value, 0) / values.length, 2) : null,
        medianLevel: median(values),
        sensorCount: values.length
      };
    });
    ward.sensors.sort((a, b) => String(a.uid).localeCompare(String(b.uid)));
  }

  return {
    weeks: allWeekLabels,
    wards: Array.from(wardMap.values()).sort((a, b) => Number(a.wardNo) - Number(b.wardNo))
  };
}

export function criticalWardMap() {
  return new Map(PREVIOUS_CRITICAL_WARDS.map(([wardNo, wardName]) => [normalizeWardNoValue(wardNo), wardName]));
}
