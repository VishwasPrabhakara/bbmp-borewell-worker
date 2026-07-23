import { neon } from "@neondatabase/serverless";

const FRESHNESS_HOURS = 6;
const RUNNING_TIMEOUT_MINUTES = 30;
const FT_TO_M = 0.3048;
const LPM_TO_M3_PER_SEC = 1 / 60000;
const TRANSMISSIVITY_SCALE = 1000000;
const MIN_MONTHLY_DRAWDOWN_M = 0.3;
const CRITICAL_GW_MIN_WEEKS = 4;
const CRITICAL_GW_MIN_COMPARISONS = 3;
const CRITICAL_GW_MAX_WEEK_GAP = 2;
const CRITICAL_GW_RELATIVE_JUMP_RATIO = 10;
const CRITICAL_GW_MIN_LARGE_JUMP_FT = 50;
const CRITICAL_GW_DECLINE_FT_PER_WEEK = 0.1;
const TREND_SIGNIFICANCE_ALPHA = 0.05;
const WARD_MIN_CLASSIFIED_SENSORS = 2;
const WARD_DECLINING_SENSOR_FRACTION = 0.5;
const API_CACHE_SECONDS = 60 * 60;
const CACHEABLE_GET_PATHS = new Set([
  "/api/sensors",
  "/api/qc/sensors",
  "/api/qc/wards",
  "/api/ward-weekly-levels",
  "/api/critical-wards-groundwater",
  "/api/population/wards",
  "/api/water-level",
  "/api/specific-capacity/ward"
]);
const PREVIOUS_CRITICAL_WARDS = [
  ["48", "Muneshwaranagar"],
  ["33", "Manorayanapalya"],
  ["13", "Mallasandra"],
  ["122", "Kempapura Agrahara"],
  ["102", "Vrishabhavathi"],
  ["161", "Hosakerehalli"],
  ["22", "Vishwanatha Nagenahalli"],
  ["195", "Konanakunte"],
  ["127", "Moodalapalya"],
  ["116", "Neelasandra"],
  ["15", "T. Dasarahalli"],
  ["183", "Chikkalasandra"],
  ["74", "Shakthiganapathinagar"],
  ["37", "Yeshwanthpura"],
  ["68", "Mahalakshmipuram"],
  ["31", "Kushalnagar"],
  ["19", "Sanjaynagar"],
  ["187", "Puttenahalli"],
  ["43", "Nandini Layout"],
  ["28", "Kammanahalli"],
  ["123", "Vijaynagar"],
  ["134", "Bapujinagar"],
  ["14", "Bagalagunte"],
  ["130", "Ullalu"],
  ["69", "Laggere"],
  ["32", "Kavalbyrasandra"],
  ["57", "C. V. Raman Nagar"],
  ["186", "Jaraganahalli"],
  ["189", "Hongasandra"],
  ["190", "Mangammanapalya"],
  ["163", "Kathriguppe"],
  ["39", "Chokkasandra"],
  ["185", "Yelachenahalli"],
  ["124", "Hosahalli"],
  ["10", "Doddabommasandra"],
  ["156", "Srinagar"],
  ["103", "Kaveripura"],
  ["71", "Hegganahalli"],
  ["148", "Ejipura"],
  ["128", "Nagarabhavi"],
  ["81", "Vignananagar"],
  ["21", "Hebbala"],
  ["6", "Thanisandra"],
  ["75", "Shankara Matha"],
  ["49", "Lingarajapuram"],
  ["171", "Gurappanapalya"],
  ["30", "Kadugondanahalli"],
  ["70", "Rajagopalanagar"],
  ["126", "Maruthi Mandira"],
  ["36", "Mathikere"],
  ["8", "Kodigehalli"],
  ["133", "Hampinagar"],
  ["131", "Nayandahalli"],
  ["97", "Dayanandanagar"],
  ["121", "Binnipete"],
  ["101", "Kamakshipalya"],
  ["164", "Vidyapeetha"],
  ["18", "Radhakrishna Temple"],
  ["144", "Siddapura"],
  ["40", "Dodda Bidarkallu"]
];

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-allow-headers": "content-type,x-admin-password"
    }
  });
}

function cacheKey(request) {
  const url = new URL(request.url);
  url.searchParams.sort();
  return new Request(url.toString(), { method: "GET" });
}

async function cachedJson(request, data, seconds = API_CACHE_SECONDS) {
  const response = json(data);
  if (request.method === "GET" && CACHEABLE_GET_PATHS.has(new URL(request.url).pathname)) {
    response.headers.set("cache-control", `public, max-age=${seconds}, s-maxage=${seconds}`);
    await caches.default.put(cacheKey(request), response.clone()).catch(() => {});
  }
  return response;
}

async function cachedFallback(request) {
  if (request.method !== "GET" || !CACHEABLE_GET_PATHS.has(new URL(request.url).pathname)) return null;
  const cached = await caches.default.match(cacheKey(request)).catch(() => null);
  if (!cached) return null;
  const response = new Response(cached.body, cached);
  response.headers.set("access-control-allow-origin", "*");
  response.headers.set("x-dashboard-cache-fallback", "true");
  return response;
}

function isNeonQuotaError(error) {
  const message = String(error?.message || error || "").toLowerCase();
  return message.includes("exceeded the data transfer quota") || message.includes("http status 402");
}

function html(body, status = 200) {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}

function csvEscape(value) {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function csvResponse(headers, rows, filename) {
  const body = [headers, ...rows].map(row => row.map(csvEscape).join(",")).join("\n");
  return new Response(body, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
      "access-control-allow-origin": "*"
    }
  });
}

function htmlEscape(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function xmlEscape(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function monthLabel(year, monthNumber) {
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[Number(monthNumber) - 1]}-${String(year).slice(-2)}`;
}

function waterLevelCell(value) {
  if (value === null || value === undefined || value === "") return "";
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? Math.round(numberValue * 100) / 100 : value;
}

function formatExcelDateTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(date).reduce((acc, part) => {
    acc[part.type] = part.value;
    return acc;
  }, {});
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

function notUsableReason(row) {
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

function median(values) {
  const sorted = values.filter(value => Number.isFinite(value)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function percentile(values, probability) {
  const sorted = values.filter(value => Number.isFinite(value)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function roundNumber(value, decimals = 4) {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return null;
  const factor = 10 ** decimals;
  return Math.round(numberValue * factor) / factor;
}

function weeklyLabel(year, monthNumber, weekNumber) {
  return `${monthLabel(year, monthNumber)} W${weekNumber}`;
}

function normalizeWardNoValue(value) {
  const numberValue = Number(value);
  if (Number.isFinite(numberValue)) return String(Math.trunc(numberValue));
  return String(value ?? "").trim().replace(/\.0+$/, "");
}

function isValidWaterLevel(value) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) && numberValue > 0;
}

function primaryLevel(point) {
  if (isValidWaterLevel(point.onLevel)) return Number(point.onLevel);
  if (isValidWaterLevel(point.waterLevel)) return Number(point.waterLevel);
  if (isValidWaterLevel(point.offLevel)) return Number(point.offLevel);
  return null;
}

function localMedian(points, index, radius, key) {
  const start = Math.max(0, index - radius);
  const end = Math.min(points.length, index + radius + 1);
  return median(points.slice(start, end).map(point => Number(point[key])));
}

function localMad(points, index, radius, key, center) {
  const start = Math.max(0, index - radius);
  const end = Math.min(points.length, index + radius + 1);
  return median(points.slice(start, end).map(point => Math.abs(Number(point[key]) - center)));
}

function smoothExpected(points, index, radius, key) {
  const previous = [];
  const next = [];
  for (let cursor = index - 1; cursor >= 0 && previous.length < radius; cursor -= 1) previous.push(points[cursor]);
  for (let cursor = index + 1; cursor < points.length && next.length < radius; cursor += 1) next.push(points[cursor]);
  const neighbours = previous.concat(next).map(point => Number(point[key])).filter(Number.isFinite);
  return median(neighbours);
}

function cleanShortLevelSeries(points, key) {
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

function dominantContinuousSegment(points, key) {
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

function cleanLevelPoints(points) {
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

function weekNumberForDate(date) {
  return Math.min(Math.floor((date.getUTCDate() - 1) / 7) + 1, 4);
}

function rollingWeeklyPoints(points) {
  return rollingWeeklyPointsFromCleaned(cleanLevelPoints(points));
}

function rollingWeeklyPointsFromCleaned(cleaned) {
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

function dropPerDay(points) {
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

function consecutiveDrops(points) {
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

function sessionDrawdowns(points) {
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

function weeklyWardPayload(rows, qcRows, includeSensorDetails = false) {
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

function criticalWardMap() {
  return new Map(PREVIOUS_CRITICAL_WARDS.map(([wardNo, wardName]) => [normalizeWardNoValue(wardNo), wardName]));
}

function weekIndexMap(weeks) {
  return new Map((weeks || []).map((label, index) => [label, index]));
}

function isUsableCriticalLevel(value) {
  return value !== null
    && value !== undefined
    && value !== ""
    && Number.isFinite(Number(value))
    && Number(value) > 0;
}

function validCriticalComparisons(weekly, weeks, options = {}) {
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

function criticalDirection(changeFtPerWeek) {
  if (!Number.isFinite(changeFtPerWeek)) return "Not computed";
  if (changeFtPerWeek > CRITICAL_GW_DECLINE_FT_PER_WEEK) return "Declining";
  if (changeFtPerWeek < -CRITICAL_GW_DECLINE_FT_PER_WEEK) return "Improving";
  return "Mostly stable";
}

function normalCdf(value) {
  const sign = value < 0 ? -1 : 1;
  const x = Math.abs(value) / Math.sqrt(2);
  const t = 1 / (1 + 0.3275911 * x);
  const erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return 0.5 * (1 + sign * erf);
}

function trendMethods(points, comparisons = [], options = {}) {
  const keepZeroLevels = Boolean(options.keepZeroLevels);
  const compressIndex = Boolean(options.compressIndex);
  const usablePoints = (points || [])
    .filter(point => (
      keepZeroLevels
        ? Number.isFinite(Number(point.level))
        : isUsableCriticalLevel(point.level)
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
  // Theil-Sen is the median of every valid pairwise slope, not only adjacent weeks.
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

function combinedGroundwaterStatus(methods, hasEnough) {
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

function criticalGroundwaterRows(payload, options = {}) {
  const includeWeeklyColumns = options.includeWeeklyColumns !== false;
  const includePairRows = options.includePairRows !== false;
  const critical = criticalWardMap();
  const rowsByWard = new Map();
  const pairRows = [];

  for (const ward of payload.wards || []) {
    const wardNo = normalizeWardNoValue(ward.wardNo);
    const previousCritical = critical.has(wardNo);
    const cleanResult = validCriticalComparisons(ward.weekly, payload.weeks);
    const legacyResult = validCriticalComparisons(ward.weekly, payload.weeks, { keepBlankAsZero: true });
    const { points, comparisons, skipped } = cleanResult;
    const legacyPoints = legacyResult.points;
    const legacyComparisons = legacyResult.comparisons;
    const hasEnough = points.length >= CRITICAL_GW_MIN_WEEKS && comparisons.length >= CRITICAL_GW_MIN_COMPARISONS;
    const legacyHasEnough = legacyPoints.length >= CRITICAL_GW_MIN_WEEKS && legacyComparisons.length >= CRITICAL_GW_MIN_COMPARISONS;
    const averageChange = hasEnough
      ? comparisons.reduce((sum, item) => sum + item.changeFtPerWeek, 0) / comparisons.length
      : null;
    const methods = trendMethods(points, comparisons, { compressIndex: true });
    const legacyMethods = trendMethods(legacyPoints, legacyComparisons, { keepZeroLevels: true });
    const wardTrend = combinedGroundwaterStatus(methods, hasEnough);
    const cleanRiseOverride =
      wardTrend.direction === "Improving"
      || wardTrend.direction === "Possible improvement"
      || Number(methods.linearSlopeFtPerWeek) < -CRITICAL_GW_DECLINE_FT_PER_WEEK
      || Number(methods.senSlopeFtPerWeek) < -CRITICAL_GW_DECLINE_FT_PER_WEEK;
    const linearMethodCritical = legacyHasEnough
      && Number(legacyMethods.linearSlopeFtPerWeek) > CRITICAL_GW_DECLINE_FT_PER_WEEK;
    const mannKendallMethodCritical = legacyHasEnough
      && Number(legacyMethods.mannKendallS) > 0
      && Number(legacyMethods.mannKendallPValue) <= TREND_SIGNIFICANCE_ALPHA;
    const theilSenMethodCritical = legacyHasEnough
      && Number(legacyMethods.senSlopeFtPerWeek) > CRITICAL_GW_DECLINE_FT_PER_WEEK;
    const linearMannKendallCritical = linearMethodCritical && mannKendallMethodCritical;
    const theilSenMannKendallCritical = theilSenMethodCritical && mannKendallMethodCritical;
    const sensorSummary = ward.trendSensorSummary || {};

    const classifiedSensorCount = Number(
      sensorSummary.classifiedSensorCount || 0
    );

    const decliningSensorCount = Number(
      sensorSummary.decliningSensorCount || 0
    );

    const confirmedDecliningSensorCount = Number(
      sensorSummary.confirmedDecliningSensorCount || 0
    );

    const improvingSensorCount = Number(
      sensorSummary.improvingSensorCount || 0
    );

    const medianSensorSlopeRaw =
      sensorSummary.medianTheilSenSlopeFtPerWeek;

    const medianSensorSlope =
      medianSensorSlopeRaw !== null &&
      medianSensorSlopeRaw !== undefined &&
      Number.isFinite(Number(medianSensorSlopeRaw))
        ? Number(medianSensorSlopeRaw)
        : null;

    const decliningSensorFraction =
      classifiedSensorCount > 0
        ? confirmedDecliningSensorCount / classifiedSensorCount
        : 0;

    /*
    * Individual-borewell agreement is retained as supporting evidence.
    * It no longer controls the map classification.
    */
    const hasSensorAgreement =
      classifiedSensorCount >= WARD_MIN_CLASSIFIED_SENSORS &&
      decliningSensorFraction >= WARD_DECLINING_SENSOR_FRACTION &&
      medianSensorSlope !== null &&
      medianSensorSlope > CRITICAL_GW_DECLINE_FT_PER_WEEK;

    /*
    * Primary ward classification:
    * Uses only the cleaned ward-average weekly groundwater trend.
    */
    const groundwaterCritical = linearMannKendallCritical && !cleanRiseOverride;

    const groundwaterWatch =
      hasEnough &&
      !cleanRiseOverride &&
      !groundwaterCritical &&
      (
        wardTrend.status === "Watch" ||
        confirmedDecliningSensorCount > 0
      );

    const dashboardAction =
      groundwaterCritical || groundwaterWatch;

    const direction = wardTrend.direction;
    const supportingSensorText = classifiedSensorCount > 0
  ? `${confirmedDecliningSensorCount}/${classifiedSensorCount} classifiable borewells show confirmed decline, ${decliningSensorCount}/${classifiedSensorCount} show decline-support evidence, and ${improvingSensorCount}/${classifiedSensorCount} show improvement.`
  : "No individual borewells had enough data for separate trend classification.";

    const reason = !ward.goodSensors
      ? "No GOOD sensors with cleaned weekly groundwater levels are available."

      : points.length < CRITICAL_GW_MIN_WEEKS
        ? `Not computed because only ${points.length} cleaned weekly ward-average values are available; minimum required is ${CRITICAL_GW_MIN_WEEKS}.`

      : comparisons.length < CRITICAL_GW_MIN_COMPARISONS
        ? `Not computed because only ${comparisons.length} valid ward-average week-to-week comparisons remain after gap and jump cleaning; minimum required is ${CRITICAL_GW_MIN_COMPARISONS}.`

      : groundwaterCritical
        ? `Critical groundwater decline: the cleaned ward-average weekly graph has a linear slope of ${roundNumber(methods.linearSlopeFtPerWeek, 2)} ft/week and a statistically significant increasing-depth Mann-Kendall trend (p=${roundNumber(methods.mannKendallPValue, 4)}). Theil-Sen slope is reported separately as a robustness check (${roundNumber(methods.senSlopeFtPerWeek, 2)} ft/week), but it does not decide the map colour. ${supportingSensorText}`

      : groundwaterWatch
        ? `Groundwater decline review: the ward-average graph is not confirmed critical, but either the ward-average linear trend shows a decline signal or at least one classifiable borewell inside the ward shows confirmed decline. ${supportingSensorText}`

      : wardTrend.direction === "Improving"
        ? `Groundwater rise: the cleaned ward-average weekly graph has a negative linear slope of ${roundNumber(methods.linearSlopeFtPerWeek, 2)} ft/week and a statistically significant decreasing-depth Mann-Kendall trend (p=${roundNumber(methods.mannKendallPValue, 4)}). ${supportingSensorText}`

      : wardTrend.direction === "Possible improvement"
        ? `Possible groundwater rise: the cleaned ward-average weekly graph has a negative linear slope of ${roundNumber(methods.linearSlopeFtPerWeek, 2)} ft/week, but the Mann-Kendall trend is not statistically significant at p <= ${TREND_SIGNIFICANCE_ALPHA}. ${supportingSensorText}`

      : `Stable or mixed groundwater trend: the cleaned ward-average observations do not show a consistent groundwater decline or rise. ${supportingSensorText}`;

    const row = {
      wardNo,
      wardName: ward.wardName || critical.get(wardNo) || "",
      previousCriticalWard: previousCritical ? "Yes" : "No",
      previousCriticalWardName: critical.get(wardNo) || "",
      groundwaterStatus:
        groundwaterCritical
          ? "Critical"
          : groundwaterWatch
            ? "Watch"
            : wardTrend.evidence === "insufficient"
              ? "Insufficient data"
              : "Normal",

      dashboardAction: dashboardAction ? "Yes" : "No",
      linearMethodCritical: linearMethodCritical ? "Yes" : "No",
      mannKendallMethodCritical: mannKendallMethodCritical ? "Yes" : "No",
      theilSenMethodCritical: theilSenMethodCritical ? "Yes" : "No",
      linearMannKendallCritical: linearMannKendallCritical ? "Yes" : "No",
      theilSenMannKendallCritical: theilSenMannKendallCritical ? "Yes" : "No",
      groundwaterRiseOverride: cleanRiseOverride ? "Yes" : "No",
      oldConsumptionNoGroundwaterData: "No",
      dashboardMapCategory:
        groundwaterCritical
          ? "Critical: Ward-average groundwater decline"
          : groundwaterWatch
            ? "Groundwater decline review"
            : wardTrend.direction === "Improving"
              ? "Confirmed groundwater rise"
              : wardTrend.direction === "Possible improvement"
                ? "Possible groundwater rise"
                : wardTrend.evidence === "insufficient"
                  ? "Insufficient groundwater data"
                  : "Stable / mixed groundwater trend",
      groundwaterDirection: direction,
      computed: hasEnough ? "Yes" : "No",
      totalSensors: ward.totalSensors || 0,
      goodSensors: ward.goodSensors || 0,
      usableWeeklyValues: points.length,
      validWeeklyComparisons: comparisons.length,
      skippedComparisons: skipped.length,
      averageChangeFtPerWeek: roundNumber(averageChange, 4),
      averageChangeFtPerDay: roundNumber(Number.isFinite(averageChange) ? averageChange / 7 : null, 4),
      declineMethodVotes: wardTrend.votes,
      trendEvidence: wardTrend.evidence,
      classifiedSensorCount,
      decliningSensorCount,
      confirmedDecliningSensorCount,
      improvingSensorCount,
      decliningSensorPercent: Number.isFinite(Number(sensorSummary.decliningSensorPercent)) ? Number(sensorSummary.decliningSensorPercent) : null,
      confirmedDecliningSensorPercent: Number.isFinite(Number(sensorSummary.confirmedDecliningSensorPercent)) ? Number(sensorSummary.confirmedDecliningSensorPercent) : null,
      medianSensorTheilSenSlopeFtPerWeek: Number.isFinite(medianSensorSlope) ? medianSensorSlope : null,
      declineStrengthFtPerWeek: methods.linearSlopeFtPerWeek,
      topDeclineRank: null,
      linearSlopeFtPerWeek: methods.linearSlopeFtPerWeek,
      linearSlopeFtPerDay: methods.linearSlopeFtPerDay,
      linearR2: methods.linearR2,
      senSlopeFtPerWeek: methods.senSlopeFtPerWeek,
      senSlopeFtPerDay: methods.senSlopeFtPerDay,
      mannKendallS: methods.mannKendallS,
      mannKendallZ: methods.mannKendallZ,
      mannKendallPValue: methods.mannKendallPValue,
      mannKendallTrend: methods.mannKendallTrend,
      uidList: (ward.sensors || []).map(sensor => sensor.uid).join(", "),
      noWeeklyDataUids: (ward.noWeeklyDataUids || []).join(", "),
      updateReason: reason,
      skippedReasonDetails: skipped.join(" | ")
    };
    if (includeWeeklyColumns) {
      for (const point of ward.weekly || []) {
        row[`${point.label} average_level_ft`] = point.averageLevel;
        row[`${point.label} sensor_count`] = point.sensorCount;
      }
    }
    rowsByWard.set(wardNo, row);

    if (includePairRows) {
      for (const item of comparisons) {
        pairRows.push([
          wardNo,
          row.wardName,
          previousCritical ? "Yes" : "No",
          item.fromLabel,
          item.toLabel,
          roundNumber(item.startLevel, 2),
          roundNumber(item.endLevel, 2),
          roundNumber(item.changeFt, 2),
          roundNumber(item.changeFtPerWeek, 4),
          roundNumber(item.changeFtPerDay, 4),
          item.gap,
          item.sensorCount
        ]);
      }
    }
  }

  for (const [wardNo, wardName] of critical.entries()) {
    if (!rowsByWard.has(wardNo)) {
      rowsByWard.set(wardNo, {
        wardNo,
        wardName,
        previousCriticalWard: "Yes",
        previousCriticalWardName: wardName,
        groundwaterStatus: "Normal",
        dashboardAction: "No",
        linearMethodCritical: "No",
        mannKendallMethodCritical: "No",
        theilSenMethodCritical: "No",
        linearMannKendallCritical: "No",
        theilSenMannKendallCritical: "No",
        oldConsumptionNoGroundwaterData: "Yes",
        dashboardMapCategory: "Old consumption-critical, no groundwater data",
        groundwaterDirection: "No sensors available",
        computed: "No",
        totalSensors: 0,
        goodSensors: 0,
        usableWeeklyValues: 0,
        validWeeklyComparisons: 0,
        skippedComparisons: 0,
        averageChangeFtPerWeek: null,
        averageChangeFtPerDay: null,
        declineMethodVotes: 0,
        declineStrengthFtPerWeek: null,
        topDeclineRank: null,
        linearSlopeFtPerWeek: null,
        linearSlopeFtPerDay: null,
        linearR2: null,
        senSlopeFtPerWeek: null,
        senSlopeFtPerDay: null,
        mannKendallS: null,
        mannKendallZ: null,
        mannKendallPValue: null,
        mannKendallTrend: "Not computed",
        uidList: "",
        noWeeklyDataUids: "",
        updateReason: "No sensors available in the dashboard weekly groundwater dataset.",
        skippedReasonDetails: ""
      });
    }
  }

  const allRows = Array.from(rowsByWard.values());
  const declineCandidates = allRows
    .filter(row => row.groundwaterStatus === "Critical" || row.groundwaterStatus === "Watch")
    .sort((a, b) => {
      const aStrength = Number.isFinite(Number(a.declineStrengthFtPerWeek)) ? Number(a.declineStrengthFtPerWeek) : -999999;
      const bStrength = Number.isFinite(Number(b.declineStrengthFtPerWeek)) ? Number(b.declineStrengthFtPerWeek) : -999999;
      if (bStrength !== aStrength) return bStrength - aStrength;
      return Number(a.wardNo) - Number(b.wardNo);
    });
  declineCandidates.forEach((row, index) => {
    row.topDeclineRank = index + 1;
  });

  const rows = allRows.sort((a, b) => {
    const statusSort = (b.groundwaterStatus === "Critical") - (a.groundwaterStatus === "Critical");
    if (statusSort) return statusSort;
    const aRate = Number.isFinite(Number(a.averageChangeFtPerWeek)) ? Number(a.averageChangeFtPerWeek) : -999999;
    const bRate = Number.isFinite(Number(b.averageChangeFtPerWeek)) ? Number(b.averageChangeFtPerWeek) : -999999;
    if (bRate !== aRate) return bRate - aRate;
    return Number(a.wardNo) - Number(b.wardNo);
  });
  rows.forEach((row, index) => {
    row.groundwaterDeclineRank = row.computed === "Yes" ? index + 1 : "";
  });
  return { rows, pairRows };
}

async function khWeeklyPayload(sql, includeSensorDetails = false) {
  const qcRows = await sql`
    SELECT uid, ward_no, ward_name, qc_status
    FROM sensor_qc_summary
    WHERE ward_no IS NOT NULL
      AND ward_no <> ''
  `;
  const uploadedSessionCount = await sql`
    SELECT COUNT(*)::integer AS count
    FROM uploaded_type_b_sessions
  `;
  const hasUploadedSessions = Number(uploadedSessionCount?.[0]?.count || 0) > 0;
  const rows = hasUploadedSessions ? await sql`
    WITH good_sensors AS (
      SELECT uid, ward_no, ward_name
      FROM sensor_qc_summary
      WHERE qc_status = 'GOOD'
        AND ward_no IS NOT NULL
        AND ward_no <> ''
    )
    SELECT
      q.ward_no,
      q.ward_name,
      q.uid,
      b.stop_time AS reading_time,
      b.water_level_stop_ft AS water_level_ft,
      b.water_level_stop_ft AS on_level,
      b.water_level_start_ft AS off_level,
      COALESCE(b.session_duration_min, EXTRACT(EPOCH FROM (b.stop_time - b.start_time)) / 60) / 60 AS runtime_hours
    FROM uploaded_type_b_sessions b
    JOIN good_sensors q ON q.uid = b.uid
    WHERE b.water_level_stop_ft IS NOT NULL
    ORDER BY q.ward_no, q.uid, b.stop_time
  ` : await sql`
    WITH good_sensors AS (
      SELECT uid, ward_no, ward_name
      FROM sensor_qc_summary
      WHERE qc_status = 'GOOD'
        AND ward_no IS NOT NULL
        AND ward_no <> ''
    )
    SELECT
      q.ward_no,
      q.ward_name,
      q.uid,
      w.time AS reading_time,
      COALESCE(w.water_level, w.on_level, w.off_level) AS water_level_ft,
      w.on_level,
      w.off_level,
      NULL::double precision AS runtime_hours
    FROM water_levels w
    JOIN good_sensors q ON q.uid = w.uid
    WHERE COALESCE(w.water_level, w.on_level, w.off_level) IS NOT NULL
    ORDER BY q.ward_no, q.uid, w.time
  `;
  return weeklyWardPayload(rows, qcRows, includeSensorDetails);
}

async function specificCapacityWardSummaries(sql) {
  const rows = await sql`
    WITH warded_sessions AS (
      SELECT
        COALESCE(NULLIF(q.ward_no, ''), NULLIF(a.ward_no, '')) AS ward_no,
        COALESCE(NULLIF(q.ward_name, ''), NULLIF(a.ward_name, '')) AS ward_name,
        b.uid,
        b.min_discharge_lpm,
        b.water_level_stop_ft - b.water_level_start_ft AS drawdown_ft,
        COALESCE(b.session_duration_min, EXTRACT(EPOCH FROM (b.stop_time - b.start_time)) / 60.0) AS duration_min
      FROM uploaded_type_b_sessions b
      LEFT JOIN sensor_qc_summary q ON q.uid = b.uid
      LEFT JOIN sensor_ward_assignments a ON a.uid = b.uid
      WHERE b.min_discharge_lpm IS NOT NULL
        AND b.min_discharge_lpm > 0
        AND b.water_level_start_ft IS NOT NULL
        AND b.water_level_stop_ft IS NOT NULL
        AND b.water_level_stop_ft > b.water_level_start_ft
        AND COALESCE(b.session_duration_min, EXTRACT(EPOCH FROM (b.stop_time - b.start_time)) / 60.0) >= 0.5
    ),
    valid_sessions AS (
      SELECT
        ward_no,
        ward_name,
        uid,
        (min_discharge_lpm * ${LPM_TO_M3_PER_SEC}) / (drawdown_ft * ${FT_TO_M}) AS specific_capacity_m2s,
        (drawdown_ft * ${FT_TO_M}) / (min_discharge_lpm * ${LPM_TO_M3_PER_SEC}) AS inverse_specific_capacity_s_per_m2
      FROM warded_sessions
      WHERE ward_no IS NOT NULL
        AND ward_no <> ''
        AND drawdown_ft * ${FT_TO_M} >= ${MIN_MONTHLY_DRAWDOWN_M}
    ),
    uid_summary AS (
      SELECT
        ward_no,
        ward_name,
        uid,
        COUNT(*)::integer AS valid_sessions,
        AVG(specific_capacity_m2s) AS avg_specific_capacity_m2s,
        MAX(specific_capacity_m2s) AS max_specific_capacity_m2s,
        AVG(inverse_specific_capacity_s_per_m2) AS avg_inverse_specific_capacity_s_per_m2,
        MAX(inverse_specific_capacity_s_per_m2) AS max_inverse_specific_capacity_s_per_m2
      FROM valid_sessions
      GROUP BY ward_no, ward_name, uid
    )
    SELECT
      ward_no,
      MAX(ward_name) AS ward_name,
      COUNT(*)::integer AS uid_count,
      SUM(valid_sessions)::integer AS valid_sessions,
      AVG(avg_specific_capacity_m2s) AS average_specific_capacity_m2s,
      MAX(max_specific_capacity_m2s) AS max_specific_capacity_m2s,
      AVG(avg_inverse_specific_capacity_s_per_m2) AS average_inverse_specific_capacity_s_per_m2,
      MAX(max_inverse_specific_capacity_s_per_m2) AS max_inverse_specific_capacity_s_per_m2,
      STRING_AGG(uid, ', ' ORDER BY avg_specific_capacity_m2s DESC) AS uid_list
    FROM uid_summary
    GROUP BY ward_no
  `;
  const result = new Map();
  for (const row of rows) {
    const averageSpecificCapacity = Number(row.average_specific_capacity_m2s);
    const maxSpecificCapacity = Number(row.max_specific_capacity_m2s);
    result.set(normalizeWardNoValue(row.ward_no), {
      wardNo: normalizeWardNoValue(row.ward_no),
      wardName: row.ward_name,
      uidCount: Number(row.uid_count || 0),
      validSessions: Number(row.valid_sessions || 0),
      averageSpecificCapacityM2s: Number.isFinite(averageSpecificCapacity) ? roundNumber(averageSpecificCapacity, 8) : null,
      maxSpecificCapacityM2s: Number.isFinite(maxSpecificCapacity) ? roundNumber(maxSpecificCapacity, 8) : null,
      averageTransmissivityScaled: Number.isFinite(averageSpecificCapacity) ? roundNumber(averageSpecificCapacity * TRANSMISSIVITY_SCALE, 4) : null,
      maxTransmissivityScaled: Number.isFinite(maxSpecificCapacity) ? roundNumber(maxSpecificCapacity * TRANSMISSIVITY_SCALE, 4) : null,
      averageInverseSpecificCapacitySPerM2: roundNumber(row.average_inverse_specific_capacity_s_per_m2, 2),
      maxInverseSpecificCapacitySPerM2: roundNumber(row.max_inverse_specific_capacity_s_per_m2, 2),
      uidList: row.uid_list || ""
    });
  }
  return result;
}

function criticalGroundwaterExcelResponse(payload, filename = "critical_wards_groundwater_update.xlsx") {
  const { rows, pairRows } = criticalGroundwaterRows(payload);
  const weekHeaders = [];
  for (const label of payload.weeks || []) {
    weekHeaders.push(`${label} average_level_ft`, `${label} sensor_count`);
  }
  const headers = [
    "groundwaterDeclineRank",
    "wardNo",
    "wardName",
    "previousCriticalWard",
    "previousCriticalWardName",
    "groundwaterStatus",
    "dashboardAction",
    "dashboardMapCategory",
    "linearMethodCritical",
    "mannKendallMethodCritical",
    "theilSenMethodCritical",
    "linearMannKendallCritical",
    "theilSenMannKendallCritical",
    "oldConsumptionNoGroundwaterData",
    "groundwaterDirection",
    "computed",
    "totalSensors",
    "goodSensors",
    "usableWeeklyValues",
    "validWeeklyComparisons",
    "skippedComparisons",
    "averageChangeFtPerWeek",
    "averageChangeFtPerDay",
    "declineMethodVotes",
    "trendEvidence",
    "classifiedSensorCount",
    "decliningSensorCount",
    "confirmedDecliningSensorCount",
    "improvingSensorCount",
    "decliningSensorPercent",
    "confirmedDecliningSensorPercent",
    "medianSensorTheilSenSlopeFtPerWeek",
    "declineStrengthFtPerWeek",
    "topDeclineRank",
    "linearSlopeFtPerWeek",
    "linearSlopeFtPerDay",
    "linearR2",
    "senSlopeFtPerWeek",
    "senSlopeFtPerDay",
    "mannKendallS",
    "mannKendallZ",
    "mannKendallPValue",
    "mannKendallTrend",
    "uidList",
    "noWeeklyDataUids",
    "updateReason",
    "skippedReasonDetails",
    ...weekHeaders
  ];
  const sheets = [
    {
      name: "Ward Groundwater Update",
      headers,
      rows: rows.map(row => headers.map(header => row[header]))
    },
    {
      name: "Valid Weekly Comparisons",
      headers: [
        "wardNo",
        "wardName",
        "previousCriticalWard",
        "fromWeek",
        "toWeek",
        "startAverageLevelFt",
        "endAverageLevelFt",
        "changeFt",
        "changeFtPerWeek",
        "changeFtPerDay",
        "weekGap",
        "sensorCountUsed"
      ],
      rows: pairRows
    },
    {
      name: "Method",
      headers: ["Item", "Explanation"],
      rows: [
        ["Update frequency", "This endpoint is generated from current dashboard data and should be reviewed every 15 days after fresh sensor data is downloaded."],
        ["Source", "Uses the same KrishiHrudaya ward weekly groundwater payload used by the dashboard."],
        ["Cleaning before calculation", "Sensor points are cleaned using the dashboard water-level cleaning method, then weekly points are selected at least 7 days apart."],
        ["Minimum weekly data", `Ward trend is computed only when at least ${CRITICAL_GW_MIN_WEEKS} cleaned weekly ward values and ${CRITICAL_GW_MIN_COMPARISONS} valid week-to-week comparisons remain.`],
        ["Gap rule", `A comparison is skipped when the gap between available weekly positions is more than ${CRITICAL_GW_MAX_WEEK_GAP}.`],
        ["Large jump rule", `A comparison is skipped as likely sensor/data error when the jump is at least ${CRITICAL_GW_MIN_LARGE_JUMP_FT} ft and one value is at least ${CRITICAL_GW_RELATIVE_JUMP_RATIO} times the other.`],
        ["Direction", "Positive change means feet below ground surface increased, so groundwater became deeper. Negative change means groundwater became shallower."],
        ["Linear regression", "Fits one straight line through the weekly average groundwater points. Slope is reported in ft/week and ft/day."],
        ["Theil-Sen slope", "Primary rate estimate: the median of pairwise weekly slopes, which is resistant to isolated abnormal readings."],
        ["Mann-Kendall", `Tests whether the monotonic trend is statistically credible. A confirmed trend requires p <= ${TREND_SIGNIFICANCE_ALPHA}.`],
        ["Borewell classification", "Each UID is classified independently as declining, improving, mostly stable, possible trend, or insufficient data using Theil-Sen magnitude and Mann-Kendall significance."],
        [
          "Red dashboard color",
          `A ward is Critical when the cleaned ward-average weekly groundwater series has a Theil-Sen slope greater than ${CRITICAL_GW_DECLINE_FT_PER_WEEK} ft/week, an increasing-depth Mann-Kendall direction, and Mann-Kendall p-value <= ${TREND_SIGNIFICANCE_ALPHA}. Positive depth slope means groundwater is becoming deeper.`
        ],
        [
          "Watch classification",
          `A ward is Watch when its cleaned ward-average weekly series has a Theil-Sen slope greater than ${CRITICAL_GW_DECLINE_FT_PER_WEEK} ft/week and an increasing-depth Mann-Kendall direction, but the p-value is greater than ${TREND_SIGNIFICANCE_ALPHA}. There is no arbitrary top-60 cutoff.`
        ],
        [
          "Individual borewell evidence",
          "UID-level classifications are retained as supporting information. They report localized decline or improvement but do not override the ward-average groundwater classification."
        ]
      ]
    }
  ];
  return multiSheetExcelResponse(sheets, filename);
}

async function criticalWardComparisonExcelResponse(sql) {
  const payload = await khWeeklyPayload(sql);
  const { rows } = criticalGroundwaterRows(payload, {
    includeWeeklyColumns: false,
    includePairRows: false
  });
  const capacityByWardNo = await specificCapacityWardSummaries(sql);
  const rowsByWardNo = new Map(rows.map(row => [normalizeWardNoValue(row.wardNo), row]));
  const previousCriticalMap = criticalWardMap();
  const currentActionRows = rows.filter(row => row.groundwaterStatus === "Critical" || row.groundwaterStatus === "Watch");
  const methodRows = [
    ["Linear slope only", row => row.linearMethodCritical === "Yes"],
    ["Mann-Kendall only", row => row.mannKendallMethodCritical === "Yes"],
    ["Theil-Sen only", row => row.theilSenMethodCritical === "Yes"],
    ["Linear slope + Mann-Kendall", row => row.linearMannKendallCritical === "Yes"],
    ["Theil-Sen + Mann-Kendall", row => row.theilSenMannKendallCritical === "Yes"],
    ["Dashboard action logic", row => row.dashboardAction === "Yes"]
  ].map(([method, predicate]) => {
    const flagged = rows.filter(predicate);
    const oldMatches = flagged.filter(row => row.previousCriticalWard === "Yes");
    return [
      method,
      flagged.length,
      oldMatches.length,
      flagged.length - oldMatches.length,
      roundNumber((oldMatches.length / PREVIOUS_CRITICAL_WARDS.length) * 100, 1),
      flagged.length + rows.filter(row => row.oldConsumptionNoGroundwaterData === "Yes").length
    ];
  });
  const currentActionSet = new Set(currentActionRows.map(row => normalizeWardNoValue(row.wardNo)));
  const previousCriticalSet = new Set(Array.from(previousCriticalMap.keys()));
  const capacityValues = Array.from(capacityByWardNo.values())
    .map(item => Number(item.averageSpecificCapacityM2s))
    .filter(Number.isFinite);
  const lowCapacityCutoff = percentile(capacityValues, 0.33);
  const highCapacityCutoff = percentile(capacityValues, 0.67);
  const capacityCategory = (capacity) => {
    const value = Number(capacity?.averageSpecificCapacityM2s);
    if (!Number.isFinite(value)) return "No valid specific-capacity sessions";
    if (Number.isFinite(lowCapacityCutoff) && value <= lowCapacityCutoff) return "Low performance";
    if (Number.isFinite(highCapacityCutoff) && value >= highCapacityCutoff) return "High performance";
    return "Medium performance";
  };
  const capacityReason = (capacity) => {
    const value = Number(capacity?.averageSpecificCapacityM2s);
    if (!Number.isFinite(value)) return "No valid pumping sessions with positive drawdown, positive duration, and discharge.";
    return `Average specific capacity is ${roundNumber(value * TRANSMISSIVITY_SCALE, 4)} x10^-6 m2/s; inverse average is ${roundNumber(capacity.averageInverseSpecificCapacitySPerM2, 0)} s/m2. Classification uses citywide ward percentiles.`;
  };
  const statusBucket = (row) => {
    if (!row) return "No sensors available";
    if (row.groundwaterStatus === "Critical" || row.groundwaterStatus === "Watch") return "Current critical/action";
    if (row.computed === "Yes") return "Not current critical";
    return "Data present but not enough cleaned weekly values";
  };
  const headers = [
    "wardNo",
    "wardName",
    "previousConsumptionCritical",
    "hasDashboardGroundwaterData",
    "currentGroundwaterAction",
    "dashboardMapCategory",
    "linearMethodCritical",
    "mannKendallMethodCritical",
    "theilSenMethodCritical",
    "linearMannKendallCritical",
    "theilSenMannKendallCritical",
    "oldConsumptionNoGroundwaterData",
    "groundwaterStatus",
    "groundwaterDirection",
    "groundwaterEvidence",
    "currentGroundwaterReason",
    "totalSensors",
    "goodSensorsAfterQC",
    "classifiableGroundwaterSensors",
    "confirmedDecliningSensors",
    "medianSensorTheilSenSlopeFtPerWeek",
    "linearSlopeFtPerWeek",
    "mannKendallPValue",
    "specificCapacityUidCount",
    "specificCapacityValidSessions",
    "specificCapacityPerformance",
    "averageSpecificCapacity_x10^-6_m2s",
    "maxSpecificCapacity_x10^-6_m2s",
    "averageInverseSpecificCapacity_s_per_m2",
    "maxInverseSpecificCapacity_s_per_m2",
    "specificCapacityReason",
    "qcVsSpecificCapacityNote",
    "uidList"
  ];
  const makeRow = (wardNo, fallbackName, previousCritical) => {
    const normalizedWardNo = normalizeWardNoValue(wardNo);
    const row = rowsByWardNo.get(normalizedWardNo);
    const capacity = capacityByWardNo.get(normalizedWardNo);
    const hasGroundwaterData = Boolean(row && (Number(row.totalSensors || 0) > 0 || Number(row.goodSensors || 0) > 0));
    const currentAction = row?.groundwaterStatus === "Critical" || row?.groundwaterStatus === "Watch";
    const goodSensors = Number(row?.goodSensors || 0);
    const scUidCount = Number(capacity?.uidCount || 0);
    const qcVsSpecificCapacityNote = !goodSensors && !scUidCount
      ? "No GOOD groundwater sensors and no valid specific-capacity sessions."
      : goodSensors && !scUidCount
        ? "GOOD groundwater sensors are available, but no valid specific-capacity sessions were found; water-level QC and pump-performance calculation are different checks."
        : !goodSensors && scUidCount
          ? "Specific-capacity sessions exist, but the ward has no currently plottable GOOD groundwater sensors from QC."
          : `${scUidCount}/${goodSensors} GOOD/plottable groundwater sensors have valid specific-capacity sessions.`;
    return [
      normalizedWardNo,
      row?.wardName || capacity?.wardName || fallbackName || "",
      previousCritical ? "Yes" : "No",
      hasGroundwaterData ? "Yes" : "No",
      currentAction ? "Yes" : "No",
      row?.dashboardMapCategory || (row?.oldConsumptionNoGroundwaterData === "Yes" ? "Old consumption-critical, no groundwater data" : ""),
      row?.linearMethodCritical || "No",
      row?.mannKendallMethodCritical || "No",
      row?.theilSenMethodCritical || "No",
      row?.linearMannKendallCritical || "No",
      row?.theilSenMannKendallCritical || "No",
      row?.oldConsumptionNoGroundwaterData || "No",
      row?.groundwaterStatus || "No sensors",
      row?.groundwaterDirection || "No sensors available",
      row?.trendEvidence || "",
      row?.updateReason || "No sensors available in current dashboard groundwater data.",
      row?.totalSensors || 0,
      goodSensors,
      row?.classifiedSensorCount || 0,
      row?.confirmedDecliningSensorCount || 0,
      roundNumber(row?.medianSensorTheilSenSlopeFtPerWeek, 4),
      roundNumber(row?.linearSlopeFtPerWeek, 4),
      roundNumber(row?.mannKendallPValue, 4),
      scUidCount,
      capacity?.validSessions || 0,
      capacityCategory(capacity),
      roundNumber(Number(capacity?.averageSpecificCapacityM2s) * TRANSMISSIVITY_SCALE, 4),
      roundNumber(Number(capacity?.maxSpecificCapacityM2s) * TRANSMISSIVITY_SCALE, 4),
      roundNumber(capacity?.averageInverseSpecificCapacitySPerM2, 0),
      roundNumber(capacity?.maxInverseSpecificCapacitySPerM2, 0),
      capacityReason(capacity),
      qcVsSpecificCapacityNote,
      row?.uidList || capacity?.uidList || ""
    ];
  };

  const previousRows = Array.from(previousCriticalMap.entries())
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([wardNo, wardName]) => makeRow(wardNo, wardName, true));
  const actionRows = currentActionRows
    .sort((a, b) => Number(a.topDeclineRank || 9999) - Number(b.topDeclineRank || 9999))
    .map(row => makeRow(row.wardNo, row.wardName, previousCriticalSet.has(normalizeWardNoValue(row.wardNo))));
  const previousWithGroundwaterData = previousRows.filter(row => row[3] === "Yes").length;
  const previousCurrentAction = previousRows.filter(row => row[4] === "Yes").length;
  const currentActionFromPrevious = actionRows.filter(row => row[2] === "Yes").length;
  const currentActionNew = actionRows.filter(row => row[2] !== "Yes").length;
  const previousNoData = previousRows.filter(row => row[3] !== "Yes").length;
  const previousNoLongerCritical = previousRows.filter(row => row[3] === "Yes" && row[4] !== "Yes").length;
  const sheets = [
    {
      name: "Summary",
      headers: ["Metric", "Value"],
      rows: [
        ["Previous BWSSB consumption-critical wards", PREVIOUS_CRITICAL_WARDS.length],
        ["Previous wards with current groundwater sensor data", previousWithGroundwaterData],
        ["Previous wards still current groundwater action wards", previousCurrentAction],
        ["Previous wards with data but not current groundwater action", previousNoLongerCritical],
        ["Previous wards with no current groundwater data", previousNoData],
        ["Current groundwater action wards (Critical + Watch)", currentActionRows.length],
        ["Current action wards also in previous 60", currentActionFromPrevious],
        ["Current action wards newly added by groundwater evidence", currentActionNew],
        ["Confirmed Critical wards only", rows.filter(row => row.groundwaterStatus === "Critical").length],
        ["Watch wards included as critical/action as requested", rows.filter(row => row.groundwaterStatus === "Watch").length],
        ["Specific-capacity low-performance cutoff", Number.isFinite(lowCapacityCutoff) ? `${roundNumber(lowCapacityCutoff * TRANSMISSIVITY_SCALE, 4)} x10^-6 m2/s` : "Not available"],
        ["Specific-capacity high-performance cutoff", Number.isFinite(highCapacityCutoff) ? `${roundNumber(highCapacityCutoff * TRANSMISSIVITY_SCALE, 4)} x10^-6 m2/s` : "Not available"]
      ]
    },
    {
      name: "Method Match Summary",
      headers: [
        "Method",
        "Total flagged wards",
        "Matches in old 60",
        "New wards outside old 60",
        "Old 60 match percent",
        "Flagged plus old no-data priority"
      ],
      rows: methodRows
    },
    {
      name: "Previous 60 Comparison",
      headers,
      rows: previousRows
    },
    {
      name: "Current Action Wards",
      headers,
      rows: actionRows
    },
    {
      name: "Method",
      headers: ["Item", "Explanation"],
      rows: [
        ["Previous method", "The old 60 wards were consumption-critical wards shared earlier with BWSSB."],
        ["Current groundwater method", "Current action wards include both confirmed Critical and Watch wards from cleaned weekly groundwater depth trends."],
        ["Why Watch is included", "Watch wards have decline evidence but do not meet every strict confirmation rule; per request, these are also treated as current critical/action wards in the dashboard."],
        ["Groundwater interpretation", "Positive slope means water level below ground surface is increasing, so groundwater is getting deeper."],
        ["QC versus specific capacity", "GOOD QC means the water-level sensor series is usable. Specific capacity needs valid pumping sessions with water-level drawdown and discharge, so a GOOD sensor may still have no specific-capacity value."],
        ["Specific capacity classification", "Specific-capacity performance is classified using ward percentiles among wards with valid sessions: bottom third Low, middle third Medium, top third High."],
        ["Safer wording", "Specific capacity is treated as a pump-performance/proxy transmissivity indicator, not actual aquifer transmissivity."]
      ]
    }
  ];
  return multiSheetExcelResponse(sheets, "previous_60_vs_current_groundwater_specific_capacity.xlsx");
}

const CRC32_TABLE = new Uint32Array(256).map((_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
  }
  return value >>> 0;
});

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function stringBytes(value) {
  return new TextEncoder().encode(value);
}

function concatBytes(parts) {
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function u16(value) {
  return new Uint8Array([value & 0xff, (value >>> 8) & 0xff]);
}

function u32(value) {
  return new Uint8Array([
    value & 0xff,
    (value >>> 8) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 24) & 0xff
  ]);
}

function zipDateTime() {
  const now = new Date();
  const time = (now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2);
  const date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  return { time, date };
}

function makeZip(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  const { time, date } = zipDateTime();

  for (const file of files) {
    const nameBytes = stringBytes(file.name);
    const dataBytes = typeof file.data === "string" ? stringBytes(file.data) : file.data;
    const checksum = crc32(dataBytes);

    const localHeader = concatBytes([
      u32(0x04034b50),
      u16(20),
      u16(0x0800),
      u16(0),
      u16(time),
      u16(date),
      u32(checksum),
      u32(dataBytes.length),
      u32(dataBytes.length),
      u16(nameBytes.length),
      u16(0),
      nameBytes
    ]);
    localParts.push(localHeader, dataBytes);

    const centralHeader = concatBytes([
      u32(0x02014b50),
      u16(20),
      u16(20),
      u16(0x0800),
      u16(0),
      u16(time),
      u16(date),
      u32(checksum),
      u32(dataBytes.length),
      u32(dataBytes.length),
      u16(nameBytes.length),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(0),
      u32(offset),
      nameBytes
    ]);
    centralParts.push(centralHeader);
    offset += localHeader.length + dataBytes.length;
  }

  const centralDirectory = concatBytes(centralParts);
  const endRecord = concatBytes([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(files.length),
    u16(files.length),
    u32(centralDirectory.length),
    u32(offset),
    u16(0)
  ]);

  return concatBytes([...localParts, centralDirectory, endRecord]);
}

function columnName(index) {
  let name = "";
  while (index > 0) {
    const remainder = (index - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    index = Math.floor((index - 1) / 26);
  }
  return name;
}

function cellAddress(row, column) {
  return `${columnName(column)}${row}`;
}

function inlineCell(row, column, value, style = 3) {
  if (value === null || value === undefined || value === "") return "";
  return `<c r="${cellAddress(row, column)}" s="${style}" t="inlineStr"><is><t>${xmlEscape(value)}</t></is></c>`;
}

function numberCell(row, column, value, style = 4) {
  if (value === null || value === undefined || value === "") return "";
  return `<c r="${cellAddress(row, column)}" s="${style}"><v>${xmlEscape(value)}</v></c>`;
}

function formulaCell(row, column, formula, value, style = 3) {
  return `<c r="${cellAddress(row, column)}" s="${style}"><f>${xmlEscape(formula)}</f><v>${xmlEscape(value ?? "")}</v></c>`;
}

function tableExcelResponse(headers, rows, filename, sheetName = "Sheet1") {
  const sheetRows = [
    `<row r="1">${headers.map((header, index) => inlineCell(1, index + 1, header, 2)).join("")}</row>`
  ];

  rows.forEach((row, rowIndex) => {
    const excelRow = rowIndex + 2;
    const cells = row.map((value, colIndex) => {
      if (typeof value === "number" && Number.isFinite(value)) {
        return numberCell(excelRow, colIndex + 1, value, 4);
      }
      return inlineCell(excelRow, colIndex + 1, value, 3);
    });
    sheetRows.push(`<row r="${excelRow}">${cells.join("")}</row>`);
  });

  const maxColumn = Math.max(headers.length, 1);
  const maxRow = Math.max(rows.length + 1, 1);
  const cols = `<col min="1" max="${maxColumn}" width="18" customWidth="1"/>`;
  const worksheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <dimension ref="A1:${cellAddress(maxRow, maxColumn)}"/>
  <sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
  <cols>${cols}</cols>
  <sheetData>${sheetRows.join("")}</sheetData>
</worksheet>`;

  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="${xmlEscape(sheetName)}" sheetId="1" r:id="rId1"/></sheets>
</workbook>`;

  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
  <fills count="4"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE7E6E6"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFD9E2F3"/><bgColor indexed="64"/></patternFill></fill></fills>
  <borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left style="thin"><color rgb="FF9CA3AF"/></left><right style="thin"><color rgb="FF9CA3AF"/></right><top style="thin"><color rgb="FF9CA3AF"/></top><bottom style="thin"><color rgb="FF9CA3AF"/></bottom><diagonal/></border></borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="5">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0"/>
    <xf numFmtId="0" fontId="1" fillId="2" borderId="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="0" fontId="1" fillId="3" borderId="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="0" fontId="0" fillId="0" borderId="1" applyBorder="1"/>
    <xf numFmtId="2" fontId="0" fillId="0" borderId="1" applyNumberFormat="1" applyBorder="1"/>
  </cellXfs>
  <cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

  const zip = makeZip([
    {
      name: "[Content_Types].xml",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`
    },
    {
      name: "_rels/.rels",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`
    },
    { name: "xl/workbook.xml", data: workbook },
    {
      name: "xl/_rels/workbook.xml.rels",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`
    },
    { name: "xl/worksheets/sheet1.xml", data: worksheet },
    { name: "xl/styles.xml", data: styles }
  ]);

  return new Response(zip, {
    headers: {
      "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-disposition": `attachment; filename="${filename}"`,
      "access-control-allow-origin": "*"
    }
  });
}

function safeExcelSheetName(value, fallback = "Sheet") {
  const cleaned = String(value || fallback)
    .replace(/[\[\]:*?/\\]/g, "_")
    .slice(0, 31);
  return cleaned || fallback;
}

function payloadBytes(value) {
  if (!value) return new Uint8Array();
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (Array.isArray(value)) return new Uint8Array(value);
  if (typeof value === "string") {
    const hex = value.startsWith("\\x") ? value.slice(2) : value;
    if (/^[0-9a-f]+$/i.test(hex) && hex.length % 2 === 0) {
      const bytes = new Uint8Array(hex.length / 2);
      for (let index = 0; index < bytes.length; index += 1) {
        bytes[index] = parseInt(hex.slice(index * 2, index * 2 + 2), 16);
      }
      return bytes;
    }
  }
  return new Uint8Array(value);
}

async function gunzipJsonPayload(value) {
  const bytes = payloadBytes(value);
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  const text = await new Response(stream).text();
  return JSON.parse(text);
}

function compactPointLevel(point, key) {
  const lookup = {
    off_level: "offLevel",
    on_level: "onLevel",
    water_level: "waterLevel"
  };
  const value = point[key] ?? point[lookup[key]];
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
}

function compactPointDischarge(point) {
  const numberValue = Number(point.discharge);
  return Number.isFinite(numberValue) ? numberValue : null;
}

function minutesBetween(start, stop) {
  const startDate = new Date(start);
  const stopDate = new Date(stop);
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(stopDate.getTime())) return null;
  return (stopDate.getTime() - startDate.getTime()) / 60000;
}

function compactPointDurationMinutes(point) {
  const directMinutes = Number(
    point.session_duration_min
      ?? point.sessionDurationMin
      ?? point.durationMin
      ?? point.duration_minutes
      ?? point.durationMinutes
  );
  if (Number.isFinite(directMinutes) && directMinutes > 0) return directMinutes;
  const runtimeHours = Number(point.runtime_hours ?? point.runtimeHours);
  if (Number.isFinite(runtimeHours) && runtimeHours > 0) return runtimeHours * 60;
  return null;
}

function datePart(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value || "").slice(0, 10);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
}

function convertedSpecificCapacity(row) {
  const drawdownM = Number(row.drawdown_ft) * FT_TO_M;
  const lowestDischargeM3s = Number(row.min_discharge_lpm) * LPM_TO_M3_PER_SEC;
  return {
    startWaterLevelM: Number(row.water_level_start_ft) * FT_TO_M,
    stopWaterLevelM: Number(row.water_level_stop_ft) * FT_TO_M,
    drawdownM,
    lowestDischargeM3s,
    specificCapacityM3sPerM: drawdownM > 0 ? lowestDischargeM3s / drawdownM : null
  };
}

function inverseSpecificCapacity(specificCapacityValue, drawdownM = null, lowestDischargeM3s = null) {
  if (drawdownM !== null && lowestDischargeM3s !== null && lowestDischargeM3s > 0) {
    return drawdownM / lowestDischargeM3s;
  }
  return specificCapacityValue ? 1 / specificCapacityValue : null;
}

function averageSpecificCapacity(rows) {
  const values = rows
    .map(row => convertedSpecificCapacity(row).specificCapacityM3sPerM)
    .filter(value => Number.isFinite(value));
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function maxSpecificCapacity(rows) {
  const values = rows
    .map(row => convertedSpecificCapacity(row).specificCapacityM3sPerM)
    .filter(value => Number.isFinite(value));
  return values.length ? Math.max(...values) : null;
}

function averagePumpingMinutesPerDay(rows) {
  const daily = new Map();
  for (const row of rows || []) {
    const duration = Number(row.duration_min ?? row.durationMin);
    const time = row.start_time || row.time;
    if (!Number.isFinite(duration) || !time) continue;
    const day = datePart(time);
    daily.set(day, (daily.get(day) || 0) + Math.round(duration));
  }
  const values = Array.from(daily.values());
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function maxPumpingMinutesPerDay(rows) {
  const daily = new Map();
  for (const row of rows || []) {
    const duration = Number(row.duration_min ?? row.durationMin);
    const time = row.start_time || row.time;
    if (!Number.isFinite(duration) || !time) continue;
    const day = datePart(time);
    daily.set(day, (daily.get(day) || 0) + Math.round(duration));
  }
  const values = Array.from(daily.values());
  return values.length ? Math.max(...values) : null;
}

function specificCapacityPreamble(uid, rows) {
  const first = rows[0] || {};
  return [
    ["Ward No", first.ward_no || ""],
    ["Ward Name", first.ward_name || ""],
    ["UID", uid],
    ["Latitude", first.lat || ""],
    ["Longitude", first.lng || ""],
    ["Valid pumping sessions", rows.length],
    ["Average Pumping Time per Day (min/day)", roundNumber(averagePumpingMinutesPerDay(rows), 1)],
    ["Maximum Pumping Time per Day (min/day)", roundNumber(maxPumpingMinutesPerDay(rows), 1)],
    ["Average Specific Capacity (m2/s)", roundNumber(averageSpecificCapacity(rows), 8)],
    ["Maximum Specific Capacity (m2/s)", roundNumber(maxSpecificCapacity(rows), 8)],
    [],
    ["Calculation steps and units"],
    ["1 ft = 0.3048 m"],
    ["1 L/min = 1/60000 m3/s"],
    ["Drawdown / Drop (m) = (Stop water level below ground - Start water level below ground) x 0.3048"],
    ["Lowest discharge (m3/s) = lowest discharge during that pumping session x 1/60000"],
    ["Specific Capacity (m2/s) = Lowest discharge (m3/s) / Drawdown (m)"],
    ["Inverse Specific Capacity (s/m2) = Drawdown (m) / Lowest discharge (m3/s)"],
    []
  ];
}

const MONTHLY_SPECIFIC_CAPACITY_HEADERS = [
  "Start Water Level (m)",
  "Stop Water Level (m)",
  "Start Discharge (m3/s)",
  "Stop Discharge (m3/s)",
  "Lowest Discharge (m3/s)",
  "Pumping Duration (s)",
  "Specific Capacity (x10^-6 m2/s)",
  "Inverse Specific Capacity (s/m2)"
];

function monthLabelFromDatePart(day) {
  const [year, month] = String(day).split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, 1));
  return `${date.toLocaleString("en-US", { month: "short", timeZone: "UTC" })} ${year}`;
}

function dayLabelFromDatePart(day) {
  const [year, month, date] = String(day).split("-").map(Number);
  const monthName = new Date(Date.UTC(year, month - 1, 1)).toLocaleString("en-US", { month: "short", timeZone: "UTC" }).toUpperCase();
  return `${monthName} ${date} ${year}`;
}

function cleanedDaySessions(rows) {
  const deduped = new Map();
  for (const row of rows.sort((a, b) => String(a.start_time).localeCompare(String(b.start_time)))) {
    const converted = convertedSpecificCapacity(row);
    if (!Number.isFinite(converted.drawdownM) || converted.drawdownM < MIN_MONTHLY_DRAWDOWN_M) continue;
    const key = `${roundNumber(converted.startWaterLevelM, 1)}|${roundNumber(converted.stopWaterLevelM, 1)}`;
    const existing = deduped.get(key);
    if (!existing) {
      deduped.set(key, row);
      continue;
    }
    const existingConverted = convertedSpecificCapacity(existing);
    const currentDischarge = converted.lowestDischargeM3s;
    const existingDischarge = existingConverted.lowestDischargeM3s;
    const currentDuration = Number(row.duration_min || 0);
    const existingDuration = Number(existing.duration_min || 0);
    if (
      !Number.isFinite(existingDischarge)
      || (Number.isFinite(currentDischarge) && currentDischarge < existingDischarge)
      || (currentDischarge === existingDischarge && currentDuration > existingDuration)
    ) {
      deduped.set(key, row);
    }
  }
  return Array.from(deduped.values());
}

function cleanedSpecificCapacitySessions(sessions) {
  const deduped = new Map();
  for (const session of sessions.sort((a, b) => String(a.time).localeCompare(String(b.time)))) {
    if (!Number.isFinite(Number(session.drawdownM)) || Number(session.drawdownM) < MIN_MONTHLY_DRAWDOWN_M) continue;
    const key = [
      session.date,
      roundNumber(session.startWaterLevelM, 1),
      roundNumber(session.stopWaterLevelM, 1)
    ].join("|");
    const existing = deduped.get(key);
    if (!existing) {
      deduped.set(key, session);
      continue;
    }
    const currentDischarge = Number(session.lowestDischargeM3s);
    const existingDischarge = Number(existing.lowestDischargeM3s);
    const currentDuration = Number(session.durationSeconds || 0);
    const existingDuration = Number(existing.durationSeconds || 0);
    if (
      !Number.isFinite(existingDischarge)
      || (Number.isFinite(currentDischarge) && currentDischarge < existingDischarge)
      || (currentDischarge === existingDischarge && currentDuration > existingDuration)
    ) {
      deduped.set(key, session);
    }
  }
  return Array.from(deduped.values());
}

function sessionDayValue(rows, field) {
  const values = cleanedDaySessions(rows)
    .sort((a, b) => String(a.start_time).localeCompare(String(b.start_time)))
    .map(row => {
      const converted = convertedSpecificCapacity(row);
      const startDischarge = Number(row.start_discharge_lpm ?? row.min_discharge_lpm);
      const stopDischarge = Number(row.stop_discharge_lpm ?? row.min_discharge_lpm);
      const map = {
        "Start Water Level (m)": roundNumber(converted.startWaterLevelM, 3),
        "Stop Water Level (m)": roundNumber(converted.stopWaterLevelM, 3),
        "Start Discharge (m3/s)": Number.isFinite(startDischarge) ? roundNumber(startDischarge * LPM_TO_M3_PER_SEC, 8) : "",
        "Stop Discharge (m3/s)": Number.isFinite(stopDischarge) ? roundNumber(stopDischarge * LPM_TO_M3_PER_SEC, 8) : "",
        "Lowest Discharge (m3/s)": roundNumber(converted.lowestDischargeM3s, 8),
        "Pumping Duration (s)": row.duration_min == null ? "" : Math.round(Number(row.duration_min) * 60),
        "Specific Capacity (x10^-6 m2/s)": Number.isFinite(converted.specificCapacityM3sPerM) ? roundNumber(converted.specificCapacityM3sPerM * TRANSMISSIVITY_SCALE, 4) : "",
        "Inverse Specific Capacity (s/m2)": roundNumber(inverseSpecificCapacity(converted.specificCapacityM3sPerM, converted.drawdownM, converted.lowestDischargeM3s), 2)
      };
      return map[field];
    })
    .filter(value => value !== null && value !== undefined && value !== "");
  return values.join("\n---\n");
}

function monthlySpecificCapacitySheets(rows) {
  if (!rows.length) {
    return [{
      name: "No Data",
      headers: ["Message"],
      rows: [["No valid pumping sessions found."]]
    }];
  }

  const monthGroups = new Map();
  for (const row of rows) {
    const day = datePart(row.start_time);
    const monthKey = day.slice(0, 7);
    if (!monthGroups.has(monthKey)) monthGroups.set(monthKey, []);
    monthGroups.get(monthKey).push(row);
  }

  return Array.from(monthGroups.entries()).sort(([a], [b]) => a.localeCompare(b)).map(([monthKey, monthRows]) => {
    const days = Array.from(new Set(monthRows.map(row => datePart(row.start_time)))).sort();
    const firstHeader = ["Ward No", "Ward Name", "UID"];
    const secondHeader = ["", "", ""];
    const merges = ["A1:A2", "B1:B2", "C1:C2"];

    let col = 4;
    for (const day of days) {
      firstHeader.push(dayLabelFromDatePart(day), ...Array(MONTHLY_SPECIFIC_CAPACITY_HEADERS.length - 1).fill(""));
      secondHeader.push(...MONTHLY_SPECIFIC_CAPACITY_HEADERS);
      merges.push(`${cellAddress(1, col)}:${cellAddress(1, col + MONTHLY_SPECIFIC_CAPACITY_HEADERS.length - 1)}`);
      col += MONTHLY_SPECIFIC_CAPACITY_HEADERS.length;
    }

    const grouped = new Map();
    for (const row of monthRows) {
      const key = `${row.ward_no || ""}|${row.ward_name || ""}|${row.uid}`;
      if (!grouped.has(key)) grouped.set(key, new Map());
      const day = datePart(row.start_time);
      if (!grouped.get(key).has(day)) grouped.get(key).set(day, []);
      grouped.get(key).get(day).push(row);
    }

    const bodyRows = Array.from(grouped.entries()).sort(([a], [b]) => {
      const [wardA, nameA, uidA] = a.split("|");
      const [wardB, nameB, uidB] = b.split("|");
      const numA = Number(wardA);
      const numB = Number(wardB);
      if (Number.isFinite(numA) && Number.isFinite(numB) && numA !== numB) return numA - numB;
      return String(wardA).localeCompare(String(wardB)) || String(nameA).localeCompare(String(nameB)) || String(uidA).localeCompare(String(uidB));
    }).map(([key, dayMap]) => {
      const [wardNo, wardName, uid] = key.split("|");
      const row = [wardNo, wardName, uid];
      for (const day of days) {
        const dayRows = dayMap.get(day) || [];
        for (const header of MONTHLY_SPECIFIC_CAPACITY_HEADERS) {
          row.push(sessionDayValue(dayRows, header));
        }
      }
      return row;
    });

    return {
      name: monthLabelFromDatePart(`${monthKey}-01`),
      headerRows: [firstHeader, secondHeader],
      merges,
      rows: bodyRows
    };
  });
}

function multiSheetExcelResponse(sheets, filename) {
  const usedNames = new Set();
  const normalizedSheets = sheets.map((sheet, index) => {
    const baseName = safeExcelSheetName(sheet.name, `Sheet${index + 1}`);
    let name = baseName;
    let suffix = 2;
    while (usedNames.has(name)) {
      name = `${baseName.slice(0, 28)}_${suffix}`;
      suffix += 1;
    }
    usedNames.add(name);
    return { ...sheet, name };
  });

  const worksheetXml = (sheet) => {
    const headers = sheet.headers || [];
    const headerRows = sheet.headerRows || [headers];
    const rows = sheet.rows || [];
    const preambleRows = sheet.preambleRows || [];
    const merges = sheet.merges || [];
    const sheetRows = [];

    preambleRows.forEach((row, rowIndex) => {
      const excelRow = rowIndex + 1;
      const cells = row.map((value, colIndex) => {
        if (value && typeof value === "object" && value.formula) {
          return formulaCell(excelRow, colIndex + 1, value.formula, value.value, 3);
        }
        return inlineCell(excelRow, colIndex + 1, value, 3);
      });
      sheetRows.push(`<row r="${excelRow}">${cells.join("")}</row>`);
    });

    const headerRow = preambleRows.length + 1;
    headerRows.forEach((headerValues, headerIndex) => {
      const excelRow = headerRow + headerIndex;
      sheetRows.push(`<row r="${excelRow}">${(headerValues || []).map((header, index) => inlineCell(excelRow, index + 1, header, 2)).join("")}</row>`);
    });

    rows.forEach((row, rowIndex) => {
      const excelRow = headerRow + headerRows.length + rowIndex;
      const cells = row.map((value, colIndex) => {
        if (value && typeof value === "object" && value.formula) {
          return formulaCell(excelRow, colIndex + 1, value.formula, value.value, 3);
        }
        if (typeof value === "number" && Number.isFinite(value)) {
          return numberCell(excelRow, colIndex + 1, value, 4);
        }
        return inlineCell(excelRow, colIndex + 1, value, 3);
      });
      sheetRows.push(`<row r="${excelRow}">${cells.join("")}</row>`);
    });

    const maxColumn = Math.max(
      ...headerRows.map(row => (row || []).length),
      ...rows.map(row => (row || []).length),
      headers.length,
      1
    );
    const maxRow = Math.max(preambleRows.length + rows.length + headerRows.length, 1);
    const cols = `<col min="1" max="${maxColumn}" width="20" customWidth="1"/>`;
    const mergeXml = merges.length
      ? `<mergeCells count="${merges.length}">${merges.map(ref => `<mergeCell ref="${xmlEscape(ref)}"/>`).join("")}</mergeCells>`
      : "";
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <dimension ref="A1:${cellAddress(maxRow, maxColumn)}"/>
  <sheetViews><sheetView workbookViewId="0"><pane ySplit="${headerRow + headerRows.length - 1}" topLeftCell="A${headerRow + headerRows.length}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
  <cols>${cols}</cols>
  <sheetData>${sheetRows.join("")}</sheetData>
  ${mergeXml}
</worksheet>`;
  };

  const workbookSheets = normalizedSheets.map((sheet, index) =>
    `<sheet name="${xmlEscape(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`
  ).join("");

  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>${workbookSheets}</sheets>
</workbook>`;

  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
  <fills count="4"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE7E6E6"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFD9E2F3"/><bgColor indexed="64"/></patternFill></fill></fills>
  <borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left style="thin"><color rgb="FF9CA3AF"/></left><right style="thin"><color rgb="FF9CA3AF"/></right><top style="thin"><color rgb="FF9CA3AF"/></top><bottom style="thin"><color rgb="FF9CA3AF"/></bottom><diagonal/></border></borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="5">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0"/>
    <xf numFmtId="0" fontId="1" fillId="2" borderId="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="0" fontId="1" fillId="3" borderId="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="0" fontId="0" fillId="0" borderId="1" applyBorder="1"/>
    <xf numFmtId="2" fontId="0" fillId="0" borderId="1" applyNumberFormat="1" applyBorder="1"/>
  </cellXfs>
  <cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

  const contentTypeOverrides = normalizedSheets.map((_, index) =>
    `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
  ).join("");
  const workbookRels = normalizedSheets.map((_, index) =>
    `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`
  ).join("");

  const files = [
    {
      name: "[Content_Types].xml",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${contentTypeOverrides}<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`
    },
    {
      name: "_rels/.rels",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`
    },
    { name: "xl/workbook.xml", data: workbook },
    {
      name: "xl/_rels/workbook.xml.rels",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${workbookRels}<Relationship Id="rId${normalizedSheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`
    },
    { name: "xl/styles.xml", data: styles },
    ...normalizedSheets.map((sheet, index) => ({
      name: `xl/worksheets/sheet${index + 1}.xml`,
      data: worksheetXml(sheet)
    }))
  ];

  return new Response(makeZip(files), {
    headers: {
      "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-disposition": `attachment; filename="${filename}"`,
      "access-control-allow-origin": "*"
    }
  });
}

function weeklyLevelsExcelResponse(rows, filename) {
  const monthMap = new Map();
  const sensorMap = new Map();

  for (const row of rows) {
    const monthKey = `${row.year}-${String(row.month_number).padStart(2, "0")}`;
    if (!monthMap.has(monthKey)) {
      monthMap.set(monthKey, {
        key: monthKey,
        year: Number(row.year),
        monthNumber: Number(row.month_number),
        label: monthLabel(row.year, row.month_number)
      });
    }

    const sensorKey = String(row.uid);
    if (!sensorMap.has(sensorKey)) {
      sensorMap.set(sensorKey, {
        wardNo: row.ward_no,
        wardName: row.ward_name,
        uid: sensorKey,
        months: new Map()
      });
    }

    sensorMap.get(sensorKey).months.set(monthKey, row);
  }

  const months = Array.from(monthMap.values())
    .filter(month => month.year > 2026 || (month.year === 2026 && month.monthNumber >= 1))
    .sort((a, b) => {
      if (a.year !== b.year) return a.year - b.year;
      return a.monthNumber - b.monthNumber;
    });

  const sensors = Array.from(sensorMap.values()).sort((a, b) => {
    const wardA = Number(a.wardNo);
    const wardB = Number(b.wardNo);
    if (Number.isFinite(wardA) && Number.isFinite(wardB) && wardA !== wardB) return wardA - wardB;
    return String(a.wardNo).localeCompare(String(b.wardNo))
      || String(a.wardName || "").localeCompare(String(b.wardName || ""))
      || String(a.uid).localeCompare(String(b.uid));
  });

  const wardSpans = new Map();
  for (let index = 0; index < sensors.length; index += 1) {
    const sensor = sensors[index];
    const wardKey = `${sensor.wardNo || ""}|${sensor.wardName || ""}`;
    if (!wardSpans.has(wardKey)) {
      wardSpans.set(wardKey, { start: index, count: 0 });
    }
    wardSpans.get(wardKey).count += 1;
  }

  const merges = ["A1:A2", "B1:B2", "C1:C2"];
  const sheetRows = [];
  const firstRowCells = [
    inlineCell(1, 1, "Ward Num", 1),
    inlineCell(1, 2, "Ward Name", 1),
    inlineCell(1, 3, "UID", 1)
  ];
  const secondRowCells = [];
  let column = 4;
  for (const month of months) {
    firstRowCells.push(inlineCell(1, column, month.label, 2));
    merges.push(`${cellAddress(1, column)}:${cellAddress(1, column + 3)}`);
    for (let week = 1; week <= 4; week += 1) {
      secondRowCells.push(inlineCell(2, column, `Week ${week}`, 2));
      column += 1;
    }
  }
  sheetRows.push(`<row r="1">${firstRowCells.join("")}</row>`);
  sheetRows.push(`<row r="2">${secondRowCells.join("")}</row>`);

  sensors.forEach((sensor, index) => {
    const wardKey = `${sensor.wardNo || ""}|${sensor.wardName || ""}`;
    const wardSpan = wardSpans.get(wardKey);
    const rowNumber = index + 3;
    const cells = [];
    if (wardSpan.start === index) {
      cells.push(inlineCell(rowNumber, 1, sensor.wardNo, 5));
      cells.push(inlineCell(rowNumber, 2, sensor.wardName, 5));
      if (wardSpan.count > 1) {
        merges.push(`A${rowNumber}:A${rowNumber + wardSpan.count - 1}`);
        merges.push(`B${rowNumber}:B${rowNumber + wardSpan.count - 1}`);
      }
    }
    cells.push(inlineCell(rowNumber, 3, sensor.uid, 6));
    let dataColumn = 4;
    for (const month of months) {
      const row = sensor.months.get(month.key) || {};
      for (let week = 1; week <= 4; week += 1) {
        const value = waterLevelCell(row[`week_${week}_start_water_level_ft`]);
        cells.push(numberCell(rowNumber, dataColumn, value, 4));
        dataColumn += 1;
      }
    }
    sheetRows.push(`<row r="${rowNumber}">${cells.join("")}</row>`);
  });

  const mergeXml = merges.length
    ? `<mergeCells count="${merges.length}">${merges.map(ref => `<mergeCell ref="${ref}"/>`).join("")}</mergeCells>`
    : "";
  const maxColumn = 3 + (months.length * 4);
  const cols = [
    '<col min="1" max="1" width="12" customWidth="1"/>',
    '<col min="2" max="2" width="24" customWidth="1"/>',
    '<col min="3" max="3" width="20" customWidth="1"/>',
    maxColumn >= 4 ? `<col min="4" max="${maxColumn}" width="11" customWidth="1"/>` : ""
  ].join("");

  const worksheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <dimension ref="A1:${cellAddress(Math.max(2, sensors.length + 2), Math.max(3, maxColumn))}"/>
  <sheetViews><sheetView workbookViewId="0"><pane xSplit="3" ySplit="2" topLeftCell="D3" activePane="bottomRight" state="frozen"/></sheetView></sheetViews>
  <cols>${cols}</cols>
  <sheetData>${sheetRows.join("")}</sheetData>
  ${mergeXml}
</worksheet>`;

  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="Weekly Start Levels" sheetId="1" r:id="rId1"/></sheets>
</workbook>`;

  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
  <fills count="4"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE7E6E6"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFD9E2F3"/><bgColor indexed="64"/></patternFill></fill></fills>
  <borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left style="thin"><color rgb="FF9CA3AF"/></left><right style="thin"><color rgb="FF9CA3AF"/></right><top style="thin"><color rgb="FF9CA3AF"/></top><bottom style="thin"><color rgb="FF9CA3AF"/></bottom><diagonal/></border></borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="7">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0"/>
    <xf numFmtId="0" fontId="1" fillId="2" borderId="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="0" fontId="1" fillId="3" borderId="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="0" fontId="0" fillId="0" borderId="1" applyBorder="1"/>
    <xf numFmtId="2" fontId="0" fillId="0" borderId="1" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>
    <xf numFmtId="0" fontId="0" fillId="2" borderId="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="49" fontId="0" fillId="0" borderId="1" applyNumberFormat="1" applyBorder="1"/>
  </cellXfs>
  <cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

  const zip = makeZip([
    {
      name: "[Content_Types].xml",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`
    },
    {
      name: "_rels/.rels",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`
    },
    {
      name: "xl/workbook.xml",
      data: workbook
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`
    },
    {
      name: "xl/worksheets/sheet1.xml",
      data: worksheet
    },
    {
      name: "xl/styles.xml",
      data: styles
    }
  ]);

  return new Response(zip, {
    headers: {
      "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-disposition": `attachment; filename="${filename}"`,
      "access-control-allow-origin": "*"
    }
  });
}

function isStale(lastFinished) {
  if (!lastFinished) return true;
  const last = new Date(lastFinished).getTime();
  return Date.now() - last > FRESHNESS_HOURS * 60 * 60 * 1000;
}

function isRunningStale(lastStarted) {
  if (!lastStarted) return false;
  const started = new Date(lastStarted).getTime();
  return Date.now() - started > RUNNING_TIMEOUT_MINUTES * 60 * 1000;
}

function statusPayload(row = {}) {
  return {
    running: !!row.running,
    ok: row.ok,
    lastStarted: row.last_started || null,
    lastFinished: row.last_finished || null,
    message: row.message || ""
  };
}

function isMissingRelation(error) {
  return /relation .* does not exist/i.test(String(error?.message || error));
}

function byteaToBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (Array.isArray(value)) return new Uint8Array(value);
  if (value?.data && Array.isArray(value.data)) return new Uint8Array(value.data);
  if (typeof value === "string" && value.startsWith("\\x")) {
    const bytes = new Uint8Array((value.length - 2) / 2);
    for (let index = 2; index < value.length; index += 2) {
      bytes[(index - 2) / 2] = Number.parseInt(value.slice(index, index + 2), 16);
    }
    return bytes;
  }
  throw new Error("Unsupported uploaded payload format");
}

async function gunzipJson(value) {
  const bytes = byteaToBytes(value);
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).json();
}

function requireAdmin(request, env) {
  const expected = env.ADMIN_PASSWORD;
  const provided = request.headers.get("x-admin-password") || "";
  return !!expected && provided === expected;
}

async function triggerGithubAction(env) {
  const url = `https://api.github.com/repos/${env.GH_OWNER}/${env.GH_REPO}/actions/workflows/refresh.yml/dispatches`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "authorization": `Bearer ${env.GITHUB_TOKEN}`,
      "accept": "application/vnd.github+json",
      "user-agent": "bbmp-borewell-worker"
    },
    body: JSON.stringify({ ref: env.GH_BRANCH || "main" })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GitHub dispatch failed: ${response.status} ${text}`);
  }
}

async function queueRefresh(sql, env, message = "Refresh queued") {
  await sql`
    INSERT INTO refresh_status (id, running, ok, last_started, message)
    VALUES (1, true, true, NOW(), ${message})
    ON CONFLICT (id) DO UPDATE SET
      running = true,
      ok = true,
      last_started = NOW(),
      message = ${message}
  `;
  await triggerGithubAction(env);
}

async function ensureUploadedTables(sql) {
  await sql`
    CREATE TABLE IF NOT EXISTS uploaded_type_a_readings (
      id SERIAL PRIMARY KEY,
      uid TEXT REFERENCES sensors(uid) ON DELETE CASCADE,
      lat DOUBLE PRECISION NULL,
      lng DOUBLE PRECISION NULL,
      source_file TEXT NULL,
      time TIMESTAMP NOT NULL,
      discharge DOUBLE PRECISION NULL,
      power_kw DOUBLE PRECISION NULL,
      pump_status TEXT NULL
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS uploaded_type_b_sessions (
      id SERIAL PRIMARY KEY,
      uid TEXT REFERENCES sensors(uid) ON DELETE CASCADE,
      lat DOUBLE PRECISION NULL,
      lng DOUBLE PRECISION NULL,
      source_file TEXT NULL,
      start_time TIMESTAMP NOT NULL,
      stop_time TIMESTAMP NOT NULL,
      tts_start_seconds DOUBLE PRECISION NULL,
      water_level_start_m DOUBLE PRECISION NULL,
      water_level_start_ft DOUBLE PRECISION NULL,
      tts_stop_seconds DOUBLE PRECISION NULL,
      water_level_stop_m DOUBLE PRECISION NULL,
      water_level_stop_ft DOUBLE PRECISION NULL,
      session_duration_min DOUBLE PRECISION NULL,
      min_discharge_lpm DOUBLE PRECISION NULL,
      start_discharge_lpm DOUBLE PRECISION NULL,
      stop_discharge_lpm DOUBLE PRECISION NULL,
      avg_discharge_lpm DOUBLE PRECISION NULL,
      max_discharge_lpm DOUBLE PRECISION NULL,
      discharge_readings_in_session INTEGER DEFAULT 0
    )
  `;
  await sql`ALTER TABLE uploaded_type_b_sessions ADD COLUMN IF NOT EXISTS min_discharge_lpm DOUBLE PRECISION NULL`;
  await sql`ALTER TABLE uploaded_type_b_sessions ADD COLUMN IF NOT EXISTS start_discharge_lpm DOUBLE PRECISION NULL`;
  await sql`ALTER TABLE uploaded_type_b_sessions ADD COLUMN IF NOT EXISTS stop_discharge_lpm DOUBLE PRECISION NULL`;
  await sql`ALTER TABLE uploaded_type_b_sessions ADD COLUMN IF NOT EXISTS avg_discharge_lpm DOUBLE PRECISION NULL`;
  await sql`ALTER TABLE uploaded_type_b_sessions ADD COLUMN IF NOT EXISTS max_discharge_lpm DOUBLE PRECISION NULL`;
  await sql`ALTER TABLE uploaded_type_b_sessions ADD COLUMN IF NOT EXISTS discharge_readings_in_session INTEGER DEFAULT 0`;
}

async function ensureVendorTables(sql) {
  await sql`
    CREATE TABLE IF NOT EXISTS vendor_sensors (
      device_name TEXT PRIMARY KEY,
      constituency TEXT NULL,
      ward_no TEXT NULL,
      ward_name TEXT NULL,
      lat DOUBLE PRECISION NULL,
      lng DOUBLE PRECISION NULL,
      first_data_at TIMESTAMP NULL,
      last_data_at TIMESTAMP NULL,
      water_readings INTEGER DEFAULT 0,
      total_readings INTEGER DEFAULT 0,
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS vendor_water_levels (
      id SERIAL PRIMARY KEY,
      device_name TEXT NOT NULL,
      constituency TEXT NULL,
      ward_no TEXT NULL,
      lat DOUBLE PRECISION NULL,
      lng DOUBLE PRECISION NULL,
      water_level_ft DOUBLE PRECISION NULL,
      updated_at TIMESTAMP NOT NULL,
      source_file TEXT NULL
    )
  `;
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS vendor_water_levels_device_time_key
    ON vendor_water_levels (device_name, updated_at)
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS vendor_sensor_qc (
      uid TEXT PRIMARY KEY,
      ward_no TEXT NULL,
      ward_name TEXT NULL,
      lat DOUBLE PRECISION NULL,
      lng DOUBLE PRECISION NULL,
      data_source TEXT DEFAULT 'vendor',
      first_data_at TIMESTAMP NULL,
      last_data_at TIMESTAMP NULL,
      total_readings INTEGER DEFAULT 0,
      valid_readings INTEGER DEFAULT 0,
      invalid_readings INTEGER DEFAULT 0,
      water_readings INTEGER DEFAULT 0,
      discharge_readings INTEGER DEFAULT 0,
      duplicate_timestamp_count INTEGER DEFAULT 0,
      gap_count INTEGER DEFAULT 0,
      max_gap_hours DOUBLE PRECISION DEFAULT 0,
      range_error_count INTEGER DEFAULT 0,
      spike_count INTEGER DEFAULT 0,
      flatline_count INTEGER DEFAULT 0,
      stale_data_days DOUBLE PRECISION NULL,
      coverage_score DOUBLE PRECISION DEFAULT 0,
      range_score DOUBLE PRECISION DEFAULT 0,
      stability_score DOUBLE PRECISION DEFAULT 0,
      recent_data_score DOUBLE PRECISION DEFAULT 0,
      overall_qc_score DOUBLE PRECISION DEFAULT 0,
      qc_status TEXT DEFAULT 'NO_DATA',
      flags JSONB DEFAULT '[]'::jsonb,
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `;
}

async function ensureCompactUploadTable(sql) {
  await sql`
    CREATE TABLE IF NOT EXISTS uploaded_sensor_series (
      uid TEXT PRIMARY KEY REFERENCES sensors(uid) ON DELETE CASCADE,
      lat DOUBLE PRECISION NULL,
      lng DOUBLE PRECISION NULL,
      source_file_count INTEGER DEFAULT 0,
      first_data_at TIMESTAMP NULL,
      last_data_at TIMESTAMP NULL,
      water_readings INTEGER DEFAULT 0,
      discharge_readings INTEGER DEFAULT 0,
      total_readings INTEGER DEFAULT 0,
      payload_gzip BYTEA NOT NULL,
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `;
}

async function recalculateSummaries(sql) {
  await ensureUploadedTables(sql);
  await sql`
    UPDATE sensors
    SET
      has_data = false,
      data_category = 'none',
      first_data_at = NULL,
      last_data_at = NULL,
      water_readings = 0,
      discharge_readings = 0,
      total_readings = 0
  `;
  await sql`
    WITH uploaded_points AS (
      SELECT DISTINCT uid, time, false AS has_water, true AS has_discharge
      FROM uploaded_type_a_readings
      UNION ALL
      SELECT DISTINCT uid, start_time AS time, true AS has_water, false AS has_discharge
      FROM uploaded_type_b_sessions
      UNION ALL
      SELECT DISTINCT uid, stop_time AS time, true AS has_water, false AS has_discharge
      FROM uploaded_type_b_sessions
    ),
    uploaded_uids AS (
      SELECT DISTINCT uid FROM uploaded_points
    ),
    uploaded_summary AS (
      SELECT
        uid,
        MIN(time) AS first_data_at,
        MAX(time) AS last_data_at,
        COUNT(*) FILTER (WHERE has_water) AS water_readings,
        COUNT(*) FILTER (WHERE has_discharge) AS discharge_readings
      FROM uploaded_points
      GROUP BY uid
    ),
    kh_summary AS (
      SELECT
        uid,
        MIN(time) AS first_data_at,
        MAX(time) AS last_data_at,
        COUNT(*) FILTER (WHERE water_level IS NOT NULL OR on_level IS NOT NULL OR off_level IS NOT NULL) AS water_readings,
        COUNT(*) FILTER (WHERE discharge IS NOT NULL) AS discharge_readings
      FROM water_levels
      WHERE uid NOT IN (SELECT uid FROM uploaded_uids)
      GROUP BY uid
    ),
    summary AS (
      SELECT * FROM uploaded_summary
      UNION ALL
      SELECT * FROM kh_summary
    )
    UPDATE sensors
    SET
      first_data_at = summary.first_data_at,
      last_data_at = summary.last_data_at,
      water_readings = summary.water_readings,
      discharge_readings = summary.discharge_readings,
      total_readings = summary.water_readings + summary.discharge_readings,
      has_data = summary.water_readings > 0 OR summary.discharge_readings > 0,
      data_category = CASE
        WHEN summary.water_readings > 0 AND summary.discharge_readings > 0 THEN 'both'
        WHEN summary.water_readings > 0 THEN 'water'
        WHEN summary.discharge_readings > 0 THEN 'discharge'
        ELSE 'none'
      END
    FROM summary
    WHERE sensors.uid = summary.uid
  `;
}

async function upsertAdminSensors(sql, rowsJson) {
  await sql`
    WITH input AS (
      SELECT uid, MAX(lat) AS lat, MAX(lng) AS lng
      FROM jsonb_to_recordset(${rowsJson}::jsonb) AS x(uid text, lat double precision, lng double precision)
      WHERE uid IS NOT NULL AND uid <> ''
      GROUP BY uid
    )
    INSERT INTO sensors (uid, lat, lng, data_category, has_data, water_readings, discharge_readings, total_readings)
    SELECT uid, lat, lng, 'none', false, 0, 0, 0
    FROM input
    ON CONFLICT (uid) DO UPDATE SET
      lat = COALESCE(EXCLUDED.lat, sensors.lat),
      lng = COALESCE(EXCLUDED.lng, sensors.lng)
  `;
}

async function uploadTypeA(sql, rows) {
  await ensureUploadedTables(sql);
  const rowsJson = JSON.stringify(rows);
  await upsertAdminSensors(sql, rowsJson);
  await sql`
    WITH raw_input AS (
      SELECT *
      FROM jsonb_to_recordset(${rowsJson}::jsonb) AS x(
        uid text,
        lat double precision,
        lng double precision,
        source_file text,
        time timestamp,
        discharge double precision,
        power_kw double precision,
        pump_status text
      )
    ),
    input AS (
      SELECT
        uid,
        MAX(lat) AS lat,
        MAX(lng) AS lng,
        MAX(source_file) AS source_file,
        time,
        MAX(discharge) AS discharge,
        MAX(power_kw) AS power_kw,
        MAX(pump_status) AS pump_status
      FROM raw_input
      WHERE uid IS NOT NULL AND uid <> '' AND time IS NOT NULL
      GROUP BY uid, time
    )
    INSERT INTO uploaded_type_a_readings (uid, lat, lng, source_file, time, discharge, power_kw, pump_status)
    SELECT uid, lat, lng, source_file, time, discharge, power_kw, pump_status
    FROM input
    WHERE NOT EXISTS (
      SELECT 1
      FROM uploaded_type_a_readings existing
      WHERE existing.uid = input.uid
        AND existing.time = input.time
    )
  `;
}

async function uploadTypeB(sql, rows) {
  await ensureUploadedTables(sql);
  const rowsJson = JSON.stringify(rows);
  await upsertAdminSensors(sql, rowsJson);
  await sql`
    WITH raw_input AS (
      SELECT *
      FROM jsonb_to_recordset(${rowsJson}::jsonb) AS x(
        uid text,
        lat double precision,
        lng double precision,
        source_file text,
        start_time timestamp,
        stop_time timestamp,
        tts_start_seconds double precision,
        water_level_start_m double precision,
        water_level_start_ft double precision,
        tts_stop_seconds double precision,
        water_level_stop_m double precision,
        water_level_stop_ft double precision,
        session_duration_min double precision
      )
    ),
    input AS (
      SELECT
        uid,
        MAX(lat) AS lat,
        MAX(lng) AS lng,
        MAX(source_file) AS source_file,
        start_time,
        stop_time,
        MAX(tts_start_seconds) AS tts_start_seconds,
        MAX(water_level_start_m) AS water_level_start_m,
        MAX(water_level_start_ft) AS water_level_start_ft,
        MAX(tts_stop_seconds) AS tts_stop_seconds,
        MAX(water_level_stop_m) AS water_level_stop_m,
        MAX(water_level_stop_ft) AS water_level_stop_ft,
        MAX(session_duration_min) AS session_duration_min
      FROM raw_input
      WHERE uid IS NOT NULL AND uid <> '' AND start_time IS NOT NULL AND stop_time IS NOT NULL
      GROUP BY uid, start_time, stop_time
    )
    INSERT INTO uploaded_type_b_sessions (
      uid, lat, lng, source_file, start_time, stop_time,
      tts_start_seconds, water_level_start_m, water_level_start_ft,
      tts_stop_seconds, water_level_stop_m, water_level_stop_ft,
      session_duration_min
    )
    SELECT
      uid, lat, lng, source_file, start_time, stop_time,
      tts_start_seconds, water_level_start_m, water_level_start_ft,
      tts_stop_seconds, water_level_stop_m, water_level_stop_ft,
      session_duration_min
    FROM input
    WHERE NOT EXISTS (
      SELECT 1
      FROM uploaded_type_b_sessions existing
      WHERE existing.uid = input.uid
        AND existing.start_time = input.start_time
        AND existing.stop_time = input.stop_time
    )
  `;
}

function adminPage() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>BBMP Borewell Admin Upload</title>
  <style>
    body{font-family:Arial,sans-serif;margin:0;background:#f5f7fb;color:#172033}
    main{max-width:760px;margin:40px auto;padding:24px;background:white;border:1px solid #dde3ee;border-radius:8px}
    label{display:block;margin:16px 0 6px;font-weight:700}
    input,button{font:inherit}
    input[type=password],input[type=file]{width:100%;box-sizing:border-box;padding:10px;border:1px solid #c8d1df;border-radius:6px}
    button{margin-top:18px;padding:10px 14px;border:0;border-radius:6px;background:#1f6feb;color:white;font-weight:700;cursor:pointer}
    button:disabled{opacity:.6;cursor:wait}
    pre{white-space:pre-wrap;background:#101828;color:#d1e7ff;padding:14px;border-radius:6px;min-height:180px;max-height:420px;overflow:auto}
  </style>
</head>
<body>
  <main>
    <h1>Admin Upload</h1>
    <label for="password">Password</label>
    <input id="password" type="password" autocomplete="current-password">
    <label for="zip">TypeA/TypeB zip file</label>
    <input id="zip" type="file" accept=".zip">
    <button id="upload">Upload parsed data</button>
    <pre id="log">Choose the zip and enter the admin password.</pre>
  </main>
  <script src="https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js"></script>
  <script>
    const M_TO_FT = 3.280839895;
    const BATCH_SIZE = 1500;
    const logEl = document.getElementById('log');
    const button = document.getElementById('upload');
    const passwordEl = document.getElementById('password');
    const zipEl = document.getElementById('zip');

    function log(message) {
      logEl.textContent += "\\n" + message;
      logEl.scrollTop = logEl.scrollHeight;
    }

    function parseCSV(text) {
      const rows = [];
      let row = [];
      let cell = '';
      let quoted = false;
      for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        const next = text[i + 1];
        if (ch === '"' && quoted && next === '"') {
          cell += '"';
          i++;
        } else if (ch === '"') {
          quoted = !quoted;
        } else if (ch === ',' && !quoted) {
          row.push(cell);
          cell = '';
        } else if ((ch === '\\n' || ch === '\\r') && !quoted) {
          if (ch === '\\r' && next === '\\n') i++;
          row.push(cell);
          if (row.some(value => value.trim() !== '')) rows.push(row);
          row = [];
          cell = '';
        } else {
          cell += ch;
        }
      }
      if (cell || row.length) {
        row.push(cell);
        if (row.some(value => value.trim() !== '')) rows.push(row);
      }
      return rows;
    }

    function metaFromRow(row) {
      const meta = {};
      for (const cell of row || []) {
        const index = cell.indexOf(':');
        if (index === -1) continue;
        meta[cell.slice(0, index).trim().toLowerCase()] = cell.slice(index + 1).trim();
      }
      return meta;
    }

    function number(value) {
      const text = String(value ?? '').replace(/,/g, '').trim();
      if (!text) return null;
      const parsed = Number(text);
      return Number.isFinite(parsed) ? parsed : null;
    }

    function median(values) {
      const sorted = values.filter(value => Number.isFinite(value)).sort((a, b) => a - b);
      if (!sorted.length) return null;
      const middle = Math.floor(sorted.length / 2);
      return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
    }

    function waterLevelConverters(values) {
      const center = median(values);
      if (center === null) {
        return { toM: () => null, toFt: () => null };
      }
      if (center > 120) {
        return {
          toM: value => value === null ? null : value / M_TO_FT,
          toFt: value => value
        };
      }
      return {
        toM: value => value,
        toFt: value => value === null ? null : value * M_TO_FT
      };
    }

    function khTime(value) {
      const match = String(value || '').trim().match(/^(\\d{2})(\\d{2})(\\d{2})\\s+(\\d{2})(\\d{2})(\\d{2})$/);
      if (!match) return null;
      const [, dd, mm, yy, hh, mi, ss] = match;
      const year = Number(yy) + 2000;
      return new Date(Date.UTC(year, Number(mm) - 1, Number(dd), Number(hh), Number(mi), Number(ss))).toISOString();
    }

    function fileInfo(name) {
      const match = name.match(/(\\d{15}).*?(TypeA|TypeB)\\.csv$/i);
      if (!match) return null;
      return { uid: match[1], kind: match[2].toUpperCase() };
    }

    function objectRows(rows) {
      const header = rows[1] || [];
      return rows.slice(2).map(raw => Object.fromEntries(header.map((name, index) => [name, raw[index] || ''])));
    }

    async function postRows(path, rows, password) {
      let sent = 0;
      for (let i = 0; i < rows.length; i += BATCH_SIZE) {
        const batch = rows.slice(i, i + BATCH_SIZE);
        const response = await fetch(path, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-admin-password': password
          },
          body: JSON.stringify({ rows: batch })
        });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || 'Upload failed');
        sent += payload.count || batch.length;
      }
      return sent;
    }

    async function flushQueue(queue, path, password) {
      if (!queue.length) return 0;
      const batch = queue.splice(0, queue.length);
      return postRows(path, batch, password);
    }

    async function flushIfNeeded(queue, path, password) {
      let sent = 0;
      while (queue.length >= BATCH_SIZE) {
        const batch = queue.splice(0, BATCH_SIZE);
        sent += await postRows(path, batch, password);
      }
      return sent;
    }

    async function upload() {
      const file = zipEl.files[0];
      const password = passwordEl.value;
      if (!file) throw new Error('Choose a zip file first.');
      if (!password) throw new Error('Enter the admin password.');
      if (!window.JSZip) throw new Error('Could not load JSZip. Check internet access to cdn.jsdelivr.net, then refresh this admin page.');

      button.disabled = true;
      logEl.textContent = 'Reading zip...';
      const zip = await JSZip.loadAsync(file);
      let typeACount = 0;
      let typeBCount = 0;
      let files = 0;
      const typeAQueue = [];
      const typeBQueue = [];

      for (const entry of Object.values(zip.files)) {
        if (entry.dir || !entry.name.toLowerCase().endsWith('.csv')) continue;
        const info = fileInfo(entry.name);
        if (!info) continue;
        files++;
        const text = await entry.async('text');
        const csv = parseCSV(text);
        if (csv.length < 3) continue;
        const meta = metaFromRow(csv[0]);
        const lat = number(meta.lat);
        const lng = number(meta.long);
        const rows = objectRows(csv);

        if (info.kind === 'TYPEA') {
          const dischargeColumn = Object.keys(rows[0] || {}).find(name => name.toLowerCase().includes('discharge'));
          const multiplier = dischargeColumn && dischargeColumn.toLowerCase().includes('kl/min') ? 1000 : 1;
          const parsed = rows.map(row => {
            const time = khTime(row['timestamp (ddmmyy hhmmss)']);
            const rawDischarge = number(row[dischargeColumn]);
            const discharge = rawDischarge === null ? null : rawDischarge * multiplier;
            if (!time || !Number.isFinite(discharge)) return null;
            return {
              uid: info.uid,
              lat,
              lng,
              source_file: entry.name.split('/').pop(),
              time,
              discharge,
              power_kw: number(row['power (kW)']),
              pump_status: row.pump_status || null
            };
          }).filter(Boolean);
          typeAQueue.push(...parsed);
          typeACount += await flushIfNeeded(typeAQueue, '/api/admin/upload-type-a', password);
        }

        if (info.kind === 'TYPEB') {
          const rawLevels = rows.flatMap(row => [
            number(row['water level at start (m below surface)']),
            number(row['water level at stop (m below surface)'])
          ]).filter(value => value !== null);
          const converters = waterLevelConverters(rawLevels);
          const parsed = rows.map(row => {
            const start = khTime(row['timestamp_start (ddmmyy hhmmss)']);
            const stop = khTime(row['timestamp_stop (ddmmyy hhmmss)']);
            const startRaw = number(row['water level at start (m below surface)']);
            const stopRaw = number(row['water level at stop (m below surface)']);
            const startM = converters.toM(startRaw);
            const stopM = converters.toM(stopRaw);
            const startFt = converters.toFt(startRaw);
            const stopFt = converters.toFt(stopRaw);
            if (!start || !stop || startFt === null || stopFt === null || stopFt <= startFt) return null;
            return {
              uid: info.uid,
              lat,
              lng,
              source_file: entry.name.split('/').pop(),
              start_time: start,
              stop_time: stop,
              tts_start_seconds: number(row['TTS at start (seconds)']),
              water_level_start_m: startM,
              water_level_start_ft: startFt,
              tts_stop_seconds: number(row['TTS at stop (seconds)']),
              water_level_stop_m: stopM,
              water_level_stop_ft: stopFt,
              session_duration_min: number(row['session duration (min)'])
            };
          }).filter(Boolean);
          typeBQueue.push(...parsed);
          typeBCount += await flushIfNeeded(typeBQueue, '/api/admin/upload-type-b', password);
        }

        if (files % 25 === 0) {
          log('Processed ' + files + ' files. Uploaded TypeA rows: ' + typeACount + ', TypeB sessions: ' + typeBCount + '. Queued: ' + (typeAQueue.length + typeBQueue.length));
        }
      }

      typeACount += await flushQueue(typeAQueue, '/api/admin/upload-type-a', password);
      typeBCount += await flushQueue(typeBQueue, '/api/admin/upload-type-b', password);
      log('Finished uploading rows. Updating summaries...');

      const response = await fetch('/api/admin/recalculate-summaries', {
        method: 'POST',
        headers: { 'x-admin-password': password }
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'Summary update failed');
      log('Done. Uploaded TypeA rows: ' + typeACount + ', TypeB sessions: ' + typeBCount);
      button.disabled = false;
    }

    button.addEventListener('click', () => upload().catch(error => {
      log('ERROR: ' + error.message);
      button.disabled = false;
    }));
  </script>
</body>
</html>`;
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return json({ ok: true });

    const url = new URL(request.url);
    const sql = neon(env.DATABASE_URL);

    try {
      if (url.pathname === "/") {
        return json({ message: "BBMP Borewell Worker API running" });
      }

      if (url.pathname === "/admin-upload") {
        return html(adminPage());
      }

      if (url.pathname === "/api/admin/upload-type-a" && request.method === "POST") {
        if (!requireAdmin(request, env)) return json({ error: "Unauthorized" }, 401);
        const payload = await request.json();
        const rows = Array.isArray(payload.rows) ? payload.rows : [];
        try {
          await uploadTypeA(sql, rows);
          return json({ ok: true, count: rows.length });
        } catch (error) {
          return json({ error: String(error.message || error), route: "upload-type-a" }, 500);
        }
      }

      if (url.pathname === "/api/admin/upload-type-b" && request.method === "POST") {
        if (!requireAdmin(request, env)) return json({ error: "Unauthorized" }, 401);
        const payload = await request.json();
        const rows = Array.isArray(payload.rows) ? payload.rows : [];
        try {
          await uploadTypeB(sql, rows);
          return json({ ok: true, count: rows.length });
        } catch (error) {
          return json({ error: String(error.message || error), route: "upload-type-b" }, 500);
        }
      }

      if (url.pathname === "/api/admin/recalculate-summaries" && request.method === "POST") {
        if (!requireAdmin(request, env)) return json({ error: "Unauthorized" }, 401);
        await recalculateSummaries(sql);
        return json({ ok: true });
      }

      if (url.pathname === "/api/status") {
        const rows = await sql`
          SELECT running, ok, last_started, last_finished, message
          FROM refresh_status
          WHERE id = 1
        `;
        return json(statusPayload(rows[0]));
      }

      if (url.pathname === "/api/refresh") {
        const rows = await sql`
          SELECT running, ok, last_started, last_finished, message
          FROM refresh_status
          WHERE id = 1
        `;
        const status = rows[0];

        if (status?.running && !isRunningStale(status.last_started)) {
          return json({ started: false, reason: "already_running", status: statusPayload(status) });
        }

        if (status?.ok !== false && status && !isStale(status.last_finished)) {
          return json({ started: false, reason: "fresh", status: statusPayload(status) });
        }

        await queueRefresh(sql, env, "Refresh queued");

        return json({ started: true });
      }

      if (url.pathname === "/api/sensors") {
        const source = url.searchParams.get("source") || "kh";
        if (source === "vendor") {
          await ensureVendorTables(sql);
          const rows = await sql`
            SELECT
              device_name AS uid,
              lat,
              lng,
              ward_no,
              ward_name,
              'water' AS data_category,
              COALESCE(water_readings, 0) > 0 AS has_data,
              first_data_at,
              last_data_at,
              COALESCE(water_readings, 0) AS water_readings,
              0 AS discharge_readings,
              COALESCE(total_readings, 0) AS total_readings
            FROM vendor_sensors
            ORDER BY device_name
          `;
          return cachedJson(request, {
            source: "vendor",
            sensors: rows.map(row => ({
              uid: row.uid,
              lat: row.lat,
              lng: row.lng,
              wardNo: row.ward_no,
              wardName: row.ward_name,
              dataCategory: row.data_category || "water",
              hasData: !!row.has_data,
              firstDataAt: row.first_data_at,
              lastDataAt: row.last_data_at,
              waterReadings: row.water_readings || 0,
              dischargeReadings: 0,
              totalReadings: row.total_readings || 0
            })),
            sensorsWithWaterData: rows.filter(row => row.has_data).length
          });
        }

        await ensureCompactUploadTable(sql);
        const rows = await sql`
          SELECT
            COALESCE(s.uid, uploaded.uid) AS uid,
            COALESCE(uploaded.lat, s.lat) AS lat,
            COALESCE(uploaded.lng, s.lng) AS lng,
            s.ward_no,
            s.ward_name,
            CASE
              WHEN uploaded.uid IS NOT NULL AND COALESCE(uploaded.water_readings, 0) > 0 AND COALESCE(uploaded.discharge_readings, 0) > 0 THEN 'both'
              WHEN uploaded.uid IS NOT NULL AND COALESCE(uploaded.water_readings, 0) > 0 THEN 'water'
              WHEN uploaded.uid IS NOT NULL AND COALESCE(uploaded.discharge_readings, 0) > 0 THEN 'discharge'
              ELSE COALESCE(s.data_category, 'none')
            END AS data_category,
            CASE
              WHEN uploaded.uid IS NOT NULL THEN COALESCE(uploaded.water_readings, 0) > 0 OR COALESCE(uploaded.discharge_readings, 0) > 0
              ELSE COALESCE(s.has_data, false)
            END AS has_data,
            COALESCE(uploaded.first_data_at, s.first_data_at) AS first_data_at,
            COALESCE(uploaded.last_data_at, s.last_data_at) AS last_data_at,
            COALESCE(uploaded.water_readings, s.water_readings, 0) AS water_readings,
            COALESCE(uploaded.discharge_readings, s.discharge_readings, 0) AS discharge_readings,
            COALESCE(uploaded.total_readings, s.total_readings, 0) AS total_readings
          FROM sensors s
          FULL OUTER JOIN uploaded_sensor_series uploaded ON uploaded.uid = s.uid
          ORDER BY COALESCE(s.uid, uploaded.uid)
        `;

        return cachedJson(request, {
          sensors: rows.map(row => ({
            uid: row.uid,
            lat: row.lat,
            lng: row.lng,
            wardNo: row.ward_no,
            wardName: row.ward_name,
            dataCategory: row.data_category || "none",
            hasData: !!row.has_data,
            firstDataAt: row.first_data_at,
            lastDataAt: row.last_data_at,
            waterReadings: row.water_readings || 0,
            dischargeReadings: row.discharge_readings || 0,
            totalReadings: row.total_readings || 0
          })),
          sensorsWithWaterData: rows.filter(row => row.has_data).length
        });
      }

      if (url.pathname === "/api/qc/sensors") {
        const source = url.searchParams.get("source") || "kh";
        const wardNo = url.searchParams.get("ward_no");
        const status = url.searchParams.get("status");
        if (source === "vendor") {
          await ensureVendorTables(sql);
          const rows = wardNo && status ? await sql`
            SELECT *
            FROM vendor_sensor_qc
            WHERE ward_no = ${wardNo}
              AND qc_status = ${status}
            ORDER BY ward_no, overall_qc_score DESC, uid
          ` : wardNo ? await sql`
            SELECT *
            FROM vendor_sensor_qc
            WHERE ward_no = ${wardNo}
            ORDER BY overall_qc_score DESC, uid
          ` : status ? await sql`
            SELECT *
            FROM vendor_sensor_qc
            WHERE qc_status = ${status}
            ORDER BY ward_no, overall_qc_score DESC, uid
          ` : await sql`
            SELECT *
            FROM vendor_sensor_qc
            ORDER BY ward_no, overall_qc_score DESC, uid
          `;
          return json({
            source: "vendor",
            sensors: rows.map(row => ({
              uid: row.uid,
              wardNo: row.ward_no,
              wardName: row.ward_name,
              lat: row.lat,
              lng: row.lng,
              dataSource: row.data_source || "vendor",
              firstDataAt: row.first_data_at,
              lastDataAt: row.last_data_at,
              totalReadings: row.total_readings || 0,
              validReadings: row.valid_readings || 0,
              invalidReadings: row.invalid_readings || 0,
              waterReadings: row.water_readings || 0,
              dischargeReadings: 0,
              duplicateTimestampCount: row.duplicate_timestamp_count || 0,
              gapCount: row.gap_count || 0,
              maxGapHours: row.max_gap_hours || 0,
              rangeErrorCount: row.range_error_count || 0,
              spikeCount: row.spike_count || 0,
              flatlineCount: row.flatline_count || 0,
              staleDataDays: row.stale_data_days,
              coverageScore: row.coverage_score || 0,
              rangeScore: row.range_score || 0,
              stabilityScore: row.stability_score || 0,
              recentDataScore: row.recent_data_score || 0,
              overallQcScore: row.overall_qc_score || 0,
              qcStatus: row.qc_status || "NO_DATA",
              flags: Array.isArray(row.flags) ? row.flags : [],
              updatedAt: row.updated_at
            })),
            count: rows.length
          });
        }

        const rows = wardNo && status ? await sql`
          SELECT *
          FROM sensor_qc_summary
          WHERE ward_no = ${wardNo}
            AND qc_status = ${status}
          ORDER BY ward_no, overall_qc_score DESC, uid
        ` : wardNo ? await sql`
          SELECT *
          FROM sensor_qc_summary
          WHERE ward_no = ${wardNo}
          ORDER BY overall_qc_score DESC, uid
        ` : status ? await sql`
          SELECT *
          FROM sensor_qc_summary
          WHERE qc_status = ${status}
          ORDER BY ward_no, overall_qc_score DESC, uid
        ` : await sql`
          SELECT *
          FROM sensor_qc_summary
          ORDER BY ward_no, overall_qc_score DESC, uid
        `;

        return json({
          sensors: rows.map(row => ({
            uid: row.uid,
            wardNo: row.ward_no,
            wardName: row.ward_name,
            lat: row.lat,
            lng: row.lng,
            dataSource: row.data_source,
            firstDataAt: row.first_data_at,
            lastDataAt: row.last_data_at,
            totalReadings: row.total_readings || 0,
            validReadings: row.valid_readings || 0,
            invalidReadings: row.invalid_readings || 0,
            waterReadings: row.water_readings || 0,
            dischargeReadings: row.discharge_readings || 0,
            duplicateTimestampCount: row.duplicate_timestamp_count || 0,
            gapCount: row.gap_count || 0,
            maxGapHours: row.max_gap_hours || 0,
            rangeErrorCount: row.range_error_count || 0,
            spikeCount: row.spike_count || 0,
            flatlineCount: row.flatline_count || 0,
            staleDataDays: row.stale_data_days,
            coverageScore: row.coverage_score || 0,
            rangeScore: row.range_score || 0,
            stabilityScore: row.stability_score || 0,
            recentDataScore: row.recent_data_score || 0,
            overallQcScore: row.overall_qc_score || 0,
            qcStatus: row.qc_status || "NO_DATA",
            flags: Array.isArray(row.flags) ? row.flags : [],
            updatedAt: row.updated_at
          })),
          count: rows.length
        });
      }

      if (
        url.pathname === "/api/qc/not-usable-sensors.xlsx"
        || url.pathname === "/api/qc/not-usable-sensors.csv"
      ) {
        const rows = await sql`
          SELECT *
          FROM sensor_qc_summary
          WHERE qc_status <> 'GOOD'
            AND COALESCE(total_readings, 0) > 0
          ORDER BY
            CASE qc_status
              WHEN 'POOR' THEN 1
              WHEN 'USABLE_WITH_CAUTION' THEN 2
              WHEN 'INSUFFICIENT_DATA' THEN 3
              ELSE 4
            END,
            ward_no,
            uid
        `;
        const headers = [
          "uid",
          "ward_no",
          "ward_name",
          "first_data_at",
          "last_data_at",
          "reason",
          "total_readings",
          "valid_readings",
          "water_readings",
          "gap_count",
          "max_gap_hours",
          "range_error_count",
          "spike_count",
          "flatline_count",
          "stale_data_days",
          "lat",
          "lng"
        ];
        const csvRows = rows.map(row => [
          row.uid,
          row.ward_no,
          row.ward_name,
          formatExcelDateTime(row.first_data_at),
          formatExcelDateTime(row.last_data_at),
          notUsableReason(row),
          row.total_readings,
          row.valid_readings,
          row.water_readings,
          row.gap_count,
          row.max_gap_hours,
          row.range_error_count,
          row.spike_count,
          row.flatline_count,
          row.stale_data_days,
          row.lat,
          row.lng
        ]);
        return tableExcelResponse(headers, csvRows, "not_usable_sensor_qc_reasons.xlsx", "Not Usable Sensors");
      }

      if (url.pathname === "/api/specific-capacity/wards.xlsx") {
        const requestedWardNo = url.searchParams.get("ward_no");
        const normalizedRequestedWardNo = normalizeWardNoValue(requestedWardNo);
        let rows = await sql`
          WITH both_sensors AS (
            SELECT
              s.uid,
              COALESCE(NULLIF(s.ward_no, ''), NULLIF(q.ward_no, ''), NULLIF(a.ward_no, '')) AS ward_no,
              COALESCE(NULLIF(s.ward_name, ''), NULLIF(q.ward_name, ''), NULLIF(a.ward_name, '')) AS ward_name,
              s.lat,
              s.lng
            FROM sensors s
            LEFT JOIN sensor_qc_summary q ON q.uid = s.uid
            LEFT JOIN sensor_ward_assignments a ON a.uid = s.uid
            WHERE COALESCE(s.water_readings, 0) > 0
              AND COALESCE(s.discharge_readings, 0) > 0
          ),
          sessions AS (
            SELECT
              b.uid,
              bs.ward_no,
              bs.ward_name,
              bs.lat,
              bs.lng,
              b.start_time,
              b.stop_time,
              b.water_level_start_ft,
              b.water_level_stop_ft,
              COALESCE(
                b.session_duration_min,
                EXTRACT(EPOCH FROM (b.stop_time - b.start_time)) / 60.0
              ) AS duration_min,
              b.water_level_stop_ft - b.water_level_start_ft AS drawdown_ft,
              b.min_discharge_lpm,
              b.start_discharge_lpm,
              b.stop_discharge_lpm,
              b.avg_discharge_lpm,
              b.max_discharge_lpm,
              b.discharge_readings_in_session
            FROM uploaded_type_b_sessions b
            JOIN both_sensors bs ON bs.uid = b.uid
            WHERE b.start_time IS NOT NULL
              AND b.stop_time IS NOT NULL
              AND b.water_level_start_ft IS NOT NULL
              AND b.water_level_stop_ft IS NOT NULL
              AND bs.ward_no IS NOT NULL
              AND bs.ward_no <> ''
          ),
          session_discharge AS (SELECT * FROM sessions WHERE min_discharge_lpm IS NOT NULL AND min_discharge_lpm > 0)
          SELECT
            ward_no,
            ward_name,
            uid,
            lat,
            lng,
            start_time,
            stop_time,
            duration_min,
            water_level_start_ft,
            water_level_stop_ft,
            drawdown_ft,
            min_discharge_lpm,
            start_discharge_lpm,
            stop_discharge_lpm,
            avg_discharge_lpm,
            max_discharge_lpm,
            discharge_readings_in_session,
            min_discharge_lpm / drawdown_ft AS specific_capacity_lpm_per_ft
          FROM session_discharge
          WHERE drawdown_ft > 0
            AND COALESCE(
              duration_min,
              EXTRACT(EPOCH FROM (stop_time - start_time)) / 60.0
            ) >= 0.5
          ORDER BY
            NULLIF(regexp_replace(ward_no, '[^0-9]', '', 'g'), '')::int NULLS LAST,
            ward_no,
            ward_name,
            uid,
            start_time
        `;

        if (requestedWardNo) {
          rows = rows.filter(row => normalizeWardNoValue(row.ward_no) === normalizedRequestedWardNo);
        }

        if (!rows.length) {
          const compactRows = requestedWardNo ? await sql`
            SELECT
              u.uid,
              COALESCE(NULLIF(s.ward_no, ''), NULLIF(q.ward_no, ''), NULLIF(a.ward_no, '')) AS ward_no,
              COALESCE(NULLIF(s.ward_name, ''), NULLIF(q.ward_name, ''), NULLIF(a.ward_name, '')) AS ward_name,
              COALESCE(u.lat, s.lat, q.lat, a.lat) AS lat,
              COALESCE(u.lng, s.lng, q.lng, a.lng) AS lng,
              u.payload_gzip
            FROM uploaded_sensor_series u
            LEFT JOIN sensors s ON s.uid = u.uid
            LEFT JOIN sensor_qc_summary q ON q.uid = u.uid
            LEFT JOIN sensor_ward_assignments a ON a.uid = u.uid
            WHERE COALESCE(u.water_readings, 0) > 0
              AND COALESCE(u.discharge_readings, 0) > 0
              AND COALESCE(NULLIF(s.ward_no, ''), NULLIF(q.ward_no, ''), NULLIF(a.ward_no, '')) IS NOT NULL
              AND regexp_replace(COALESCE(NULLIF(s.ward_no, ''), NULLIF(q.ward_no, ''), NULLIF(a.ward_no, '')), '\\.0+$', '') = ${normalizedRequestedWardNo}
            ORDER BY COALESCE(NULLIF(s.ward_no, ''), NULLIF(q.ward_no, ''), NULLIF(a.ward_no, '')), u.uid
          ` : await sql`
            SELECT
              u.uid,
              COALESCE(NULLIF(s.ward_no, ''), NULLIF(q.ward_no, ''), NULLIF(a.ward_no, '')) AS ward_no,
              COALESCE(NULLIF(s.ward_name, ''), NULLIF(q.ward_name, ''), NULLIF(a.ward_name, '')) AS ward_name,
              COALESCE(u.lat, s.lat, q.lat, a.lat) AS lat,
              COALESCE(u.lng, s.lng, q.lng, a.lng) AS lng,
              u.payload_gzip
            FROM uploaded_sensor_series u
            LEFT JOIN sensors s ON s.uid = u.uid
            LEFT JOIN sensor_qc_summary q ON q.uid = u.uid
            LEFT JOIN sensor_ward_assignments a ON a.uid = u.uid
            WHERE COALESCE(u.water_readings, 0) > 0
              AND COALESCE(u.discharge_readings, 0) > 0
              AND COALESCE(NULLIF(s.ward_no, ''), NULLIF(q.ward_no, ''), NULLIF(a.ward_no, '')) IS NOT NULL
            ORDER BY COALESCE(NULLIF(s.ward_no, ''), NULLIF(q.ward_no, ''), NULLIF(a.ward_no, '')), u.uid
          `;

          const payloadRows = [];
          for (const sensor of compactRows) {
            const payload = await gunzipJsonPayload(sensor.payload_gzip);
            const points = payload
              .filter(point => point.time)
              .sort((a, b) => String(a.time).localeCompare(String(b.time)));
            let openSession = null;
            for (const point of points) {
            const offLevel = compactPointLevel(point, "off_level");
            const onLevel = compactPointLevel(point, "on_level");
            const discharge = compactPointDischarge(point);
            const sameRecordDurationMin = compactPointDurationMinutes(point);

            if (offLevel !== null && onLevel !== null && discharge !== null && discharge > 0) {
              const drawdown = onLevel - offLevel;
              if (drawdown > 0 && sameRecordDurationMin !== null && Math.round(sameRecordDurationMin) > 0) {
                payloadRows.push({
                  ward_no: sensor.ward_no,
                  ward_name: sensor.ward_name,
                  uid: sensor.uid,
                  lat: sensor.lat,
                  lng: sensor.lng,
                  start_time: point.time,
                  stop_time: point.stop_time || point.time,
                  duration_min: sameRecordDurationMin,
                  water_level_start_ft: offLevel,
                  water_level_stop_ft: onLevel,
                  drawdown_ft: drawdown,
                  min_discharge_lpm: discharge,
                  start_discharge_lpm: discharge,
                  stop_discharge_lpm: discharge,
                  avg_discharge_lpm: discharge,
                  max_discharge_lpm: discharge,
                  discharge_readings_in_session: 1,
                  specific_capacity_lpm_per_ft: discharge / drawdown
                });
                openSession = null;
                continue;
              }
            }

            if (offLevel !== null) {
              openSession = {
                start_time: point.time,
                  water_level_start_ft: offLevel,
                  discharges: []
                };
              }

              if (openSession && discharge !== null && discharge > 0) {
                openSession.discharges.push(discharge);
              }

              if (openSession && onLevel !== null) {
                const drawdown = onLevel - openSession.water_level_start_ft;
                const discharges = openSession.discharges;
                const durationMin = minutesBetween(openSession.start_time, point.time);
                if (drawdown > 0 && discharges.length && durationMin !== null && Math.round(durationMin) > 0) {
                  payloadRows.push({
                    ward_no: sensor.ward_no,
                    ward_name: sensor.ward_name,
                    uid: sensor.uid,
                    lat: sensor.lat,
                    lng: sensor.lng,
                    start_time: openSession.start_time,
                    stop_time: point.time,
                    duration_min: durationMin,
                    water_level_start_ft: openSession.water_level_start_ft,
                    water_level_stop_ft: onLevel,
                    drawdown_ft: drawdown,
                    min_discharge_lpm: Math.min(...discharges),
                    start_discharge_lpm: discharges[0],
                    stop_discharge_lpm: discharges[discharges.length - 1],
                    avg_discharge_lpm: discharges.reduce((sum, value) => sum + value, 0) / discharges.length,
                    max_discharge_lpm: Math.max(...discharges),
                    discharge_readings_in_session: discharges.length,
                    specific_capacity_lpm_per_ft: Math.min(...discharges) / drawdown
                  });
                }
                openSession = null;
              }
            }
          }
          rows = payloadRows.sort((a, b) => {
            const wardA = Number(a.ward_no);
            const wardB = Number(b.ward_no);
            if (Number.isFinite(wardA) && Number.isFinite(wardB) && wardA !== wardB) return wardA - wardB;
            return String(a.ward_no).localeCompare(String(b.ward_no))
              || String(a.uid).localeCompare(String(b.uid))
              || String(a.start_time).localeCompare(String(b.start_time));
          });
        }

        const sheets = monthlySpecificCapacitySheets(rows);

        const filename = requestedWardNo
          ? `specific_capacity_ward_${normalizedRequestedWardNo || requestedWardNo}.xlsx`
          : "specific_capacity_monthly_by_ward_uid.xlsx";
        return multiSheetExcelResponse(sheets, filename);
      }

      if (url.pathname === "/api/specific-capacity/ward") {
        const requestedWardNo = url.searchParams.get("ward_no");
        if (!requestedWardNo) return json({ ward: null, sensors: [] }, 400);
        const normalizedRequestedWardNo = normalizeWardNoValue(requestedWardNo);
        const compactRows = await sql`
          SELECT
            u.uid,
            COALESCE(NULLIF(s.ward_no, ''), NULLIF(q.ward_no, ''), NULLIF(a.ward_no, '')) AS ward_no,
            COALESCE(NULLIF(s.ward_name, ''), NULLIF(q.ward_name, ''), NULLIF(a.ward_name, '')) AS ward_name,
            COALESCE(u.lat, s.lat, q.lat, a.lat) AS lat,
            COALESCE(u.lng, s.lng, q.lng, a.lng) AS lng,
            u.payload_gzip
          FROM uploaded_sensor_series u
          LEFT JOIN sensors s ON s.uid = u.uid
          LEFT JOIN sensor_qc_summary q ON q.uid = u.uid
          LEFT JOIN sensor_ward_assignments a ON a.uid = u.uid
          WHERE COALESCE(u.water_readings, 0) > 0
            AND COALESCE(u.discharge_readings, 0) > 0
            AND COALESCE(NULLIF(s.ward_no, ''), NULLIF(q.ward_no, ''), NULLIF(a.ward_no, '')) IS NOT NULL
            AND regexp_replace(COALESCE(NULLIF(s.ward_no, ''), NULLIF(q.ward_no, ''), NULLIF(a.ward_no, '')), '\\.0+$', '') = ${normalizedRequestedWardNo}
          ORDER BY u.uid
        `;

        const sensorRows = [];
        const skippedSensors = [];
        for (const sensor of compactRows) {
          const payload = await gunzipJsonPayload(sensor.payload_gzip);
          const points = payload
            .filter(point => point.time)
            .sort((a, b) => String(a.time).localeCompare(String(b.time)));
          const sessions = [];
          let sameRecordCandidateCount = 0;
          let bridgedSessionCandidateCount = 0;
          let openSession = null;
          for (const point of points) {
            const offLevel = compactPointLevel(point, "off_level");
            const onLevel = compactPointLevel(point, "on_level");
            const discharge = compactPointDischarge(point);
            const sameRecordDurationMin = compactPointDurationMinutes(point);
            if (offLevel !== null && onLevel !== null && discharge !== null && discharge > 0) {
              sameRecordCandidateCount += 1;
              const drawdownFt = onLevel - offLevel;
              if (sameRecordDurationMin !== null && Math.round(sameRecordDurationMin) > 0 && drawdownFt > 0) {
                const drawdownM = drawdownFt * FT_TO_M;
                if (drawdownM < MIN_MONTHLY_DRAWDOWN_M) {
                  openSession = null;
                  continue;
                }
                const lowestDischargeM3s = discharge * LPM_TO_M3_PER_SEC;
                const specificCapacityM2s = lowestDischargeM3s / drawdownM;
                const inverseCapacitySPerM2 = inverseSpecificCapacity(specificCapacityM2s, drawdownM, lowestDischargeM3s);
                sessions.push({
                  date: datePart(point.time),
                  label: formatExcelDateTime(point.time),
                  time: point.time,
                  stopTime: point.stop_time || point.time,
                  durationMin: Math.round(sameRecordDurationMin),
                  durationSeconds: Math.round(sameRecordDurationMin * 60),
                  startWaterLevelM: roundNumber(offLevel * FT_TO_M, 3),
                  stopWaterLevelM: roundNumber(onLevel * FT_TO_M, 3),
                  drawdownM: roundNumber(drawdownM, 3),
                  lowestDischargeM3s: roundNumber(lowestDischargeM3s, 8),
                  specificCapacityM2s: roundNumber(specificCapacityM2s, 8),
                  transmissivityScaled: roundNumber(specificCapacityM2s * TRANSMISSIVITY_SCALE, 4),
                  inverseSpecificCapacitySPerM2: roundNumber(inverseCapacitySPerM2, 2)
                });
                openSession = null;
                continue;
              }
            }
            if (offLevel !== null) {
              openSession = { startTime: point.time, startLevelFt: offLevel, discharges: [] };
            }
            if (openSession && discharge !== null && discharge > 0) {
              openSession.discharges.push(discharge);
            }
            if (openSession && onLevel !== null) {
              const durationMin = minutesBetween(openSession.startTime, point.time);
              const drawdownFt = onLevel - openSession.startLevelFt;
              bridgedSessionCandidateCount += 1;
              if (durationMin !== null && Math.round(durationMin) > 0 && drawdownFt > 0 && openSession.discharges.length) {
                const drawdownM = drawdownFt * FT_TO_M;
                if (drawdownM < MIN_MONTHLY_DRAWDOWN_M) {
                  openSession = null;
                  continue;
                }
                const lowestDischargeM3s = Math.min(...openSession.discharges) * LPM_TO_M3_PER_SEC;
                const specificCapacityM2s = lowestDischargeM3s / drawdownM;
                const inverseCapacitySPerM2 = inverseSpecificCapacity(specificCapacityM2s, drawdownM, lowestDischargeM3s);
                sessions.push({
                  date: datePart(openSession.startTime),
                  label: formatExcelDateTime(openSession.startTime),
                  time: openSession.startTime,
                  stopTime: point.time,
                  durationMin: Math.round(durationMin),
                  durationSeconds: Math.round(durationMin * 60),
                  startWaterLevelM: roundNumber(openSession.startLevelFt * FT_TO_M, 3),
                  stopWaterLevelM: roundNumber(onLevel * FT_TO_M, 3),
                  drawdownM: roundNumber(drawdownM, 3),
                  lowestDischargeM3s: roundNumber(lowestDischargeM3s, 8),
                  specificCapacityM2s: roundNumber(specificCapacityM2s, 8),
                  transmissivityScaled: roundNumber(specificCapacityM2s * TRANSMISSIVITY_SCALE, 4),
                  inverseSpecificCapacitySPerM2: roundNumber(inverseCapacitySPerM2, 2)
                });
              }
              openSession = null;
            }
          }
          const cleanedSessions = cleanedSpecificCapacitySessions(sessions);
          const values = cleanedSessions.map(item => Number(item.specificCapacityM2s)).filter(Number.isFinite);
          const inverseValues = cleanedSessions.map(item => Number(item.inverseSpecificCapacitySPerM2)).filter(Number.isFinite);
          if (!values.length) {
            skippedSensors.push({
              uid: String(sensor.uid),
              wardNo: sensor.ward_no,
              wardName: sensor.ward_name,
              reason: sameRecordCandidateCount || bridgedSessionCandidateCount
                ? "Water level and discharge exist, but no session had positive drawdown, positive duration, and discharge inside the pumping period."
                : "Water level and discharge exist for this UID, but OFF/ON pumping-session pairs could not be identified."
            });
            continue;
          }
          sensorRows.push({
            uid: String(sensor.uid),
            wardNo: sensor.ward_no,
            wardName: sensor.ward_name,
            lat: sensor.lat,
            lng: sensor.lng,
            validSessions: cleanedSessions.length,
            averagePumpingMinutesPerDay: roundNumber(averagePumpingMinutesPerDay(cleanedSessions), 1),
            maxPumpingMinutesPerDay: roundNumber(maxPumpingMinutesPerDay(cleanedSessions), 1),
            averageSpecificCapacityM2s: roundNumber(values.reduce((sum, value) => sum + value, 0) / values.length, 8),
            maxSpecificCapacityM2s: roundNumber(Math.max(...values), 8),
            averageTransmissivityScaled: roundNumber((values.reduce((sum, value) => sum + value, 0) / values.length) * TRANSMISSIVITY_SCALE, 4),
            maxTransmissivityScaled: roundNumber(Math.max(...values) * TRANSMISSIVITY_SCALE, 4),
            averageInverseSpecificCapacitySPerM2: roundNumber(inverseValues.reduce((sum, value) => sum + value, 0) / inverseValues.length, 2),
            maxInverseSpecificCapacitySPerM2: roundNumber(Math.max(...inverseValues), 2),
            sessions: cleanedSessions
          });
        }

        sensorRows.sort((a, b) => (b.averageSpecificCapacityM2s || 0) - (a.averageSpecificCapacityM2s || 0) || String(a.uid).localeCompare(String(b.uid)));
        const allValues = sensorRows.flatMap(sensor => sensor.sessions.map(session => Number(session.specificCapacityM2s))).filter(Number.isFinite);
        const allInverseValues = sensorRows.flatMap(sensor => sensor.sessions.map(session => Number(session.inverseSpecificCapacitySPerM2))).filter(Number.isFinite);
        return cachedJson(request, {
          ward: sensorRows.length ? {
            wardNo: sensorRows[0].wardNo,
            wardName: sensorRows[0].wardName,
            uidCount: sensorRows.length,
            validSessions: sensorRows.reduce((sum, sensor) => sum + sensor.validSessions, 0),
            averageSpecificCapacityM2s: allValues.length ? roundNumber(allValues.reduce((sum, value) => sum + value, 0) / allValues.length, 8) : null,
            maxSpecificCapacityM2s: allValues.length ? roundNumber(Math.max(...allValues), 8) : null,
            averageTransmissivityScaled: allValues.length ? roundNumber((allValues.reduce((sum, value) => sum + value, 0) / allValues.length) * TRANSMISSIVITY_SCALE, 4) : null,
            maxTransmissivityScaled: allValues.length ? roundNumber(Math.max(...allValues) * TRANSMISSIVITY_SCALE, 4) : null,
            averageInverseSpecificCapacitySPerM2: allInverseValues.length ? roundNumber(allInverseValues.reduce((sum, value) => sum + value, 0) / allInverseValues.length, 2) : null,
            maxInverseSpecificCapacitySPerM2: allInverseValues.length ? roundNumber(Math.max(...allInverseValues), 2) : null
          } : null,
          sensors: sensorRows,
          diagnostics: {
            candidateSensorsWithWaterAndDischarge: compactRows.length,
            sensorsWithValidSpecificCapacity: sensorRows.length,
            sensorsWithoutValidSpecificCapacity: skippedSensors.length,
            skippedSensors
          }
        });
      }

      if (url.pathname === "/api/qc/wards") {
        const rows = await sql`
          SELECT *
          FROM ward_sensor_qc_summary
          ORDER BY
            CASE confidence
              WHEN 'High' THEN 1
              WHEN 'Medium' THEN 2
              ELSE 3
            END,
            avg_qc_score DESC,
            ward_no
        `;

        return json({
          wards: rows.map(row => ({
            wardNo: row.ward_no,
            wardName: row.ward_name,
            sensorCount: row.sensor_count || 0,
            sensorsWithData: row.sensors_with_data || 0,
            goodSensorCount: row.good_sensor_count || 0,
            usableSensorCount: row.usable_sensor_count || 0,
            poorSensorCount: row.poor_sensor_count || 0,
            insufficientSensorCount: row.insufficient_sensor_count || 0,
            noDataSensorCount: row.no_data_sensor_count || 0,
            avgQcScore: row.avg_qc_score || 0,
            confidence: row.confidence || "Low",
            updatedAt: row.updated_at
          })),
          count: rows.length
        });
      }

      if (url.pathname === "/api/population/wards") {
        const rows = await sql`
          SELECT
            ward_no,
            ward_name,
            area_km2,
            population_2001,
            population_2011,
            cagr_2001_2011,
            projected_population_2024,
            projected_population_2025,
            projected_population_2026,
            households_2011,
            projected_households_2024,
            imported_at
          FROM ward_population_estimates
          ORDER BY NULLIF(regexp_replace(ward_no, '[^0-9]', '', 'g'), '')::int NULLS LAST, ward_no
        `;

        return json({
          wards: rows.map(row => ({
            wardNo: row.ward_no,
            wardName: row.ward_name,
            areaKm2: row.area_km2,
            population2001: row.population_2001,
            population2011: row.population_2011,
            cagr2001To2011: row.cagr_2001_2011,
            projectedPopulation2024: row.projected_population_2024,
            projectedPopulation2025: row.projected_population_2025,
            projectedPopulation2026: row.projected_population_2026,
            households2011: row.households_2011,
            projectedHouseholds2024: row.projected_households_2024,
            importedAt: row.imported_at
          })),
          count: rows.length
        });
      }

      if (url.pathname === "/api/consumption/wards") {
        const rows = await sql`
          WITH latest AS (
            SELECT DISTINCT ON (normalized_ward_name)
              ward_name,
              normalized_ward_name,
              month,
              connections,
              consumption_ml,
              consumption_per_connection
            FROM ward_monthly_consumption
            ORDER BY normalized_ward_name, month DESC
          ),
          summary AS (
            SELECT
              normalized_ward_name,
              MIN(month) AS first_month,
              MAX(month) AS last_month,
              COUNT(*) AS month_count,
              AVG(consumption_ml) AS avg_consumption_ml,
              AVG(consumption_per_connection) AS avg_consumption_per_connection
            FROM ward_monthly_consumption
            GROUP BY normalized_ward_name
          ),
          yearly AS (
            SELECT
              normalized_ward_name,
              SUM(consumption_ml) FILTER (WHERE EXTRACT(YEAR FROM month) = 2020) AS consumption_2020_ml,
              SUM(consumption_ml) FILTER (WHERE EXTRACT(YEAR FROM month) = 2021) AS consumption_2021_ml,
              SUM(consumption_ml) FILTER (WHERE EXTRACT(YEAR FROM month) = 2022) AS consumption_2022_ml,
              SUM(consumption_ml) FILTER (WHERE EXTRACT(YEAR FROM month) = 2023) AS consumption_2023_ml,
              SUM(consumption_ml) FILTER (WHERE EXTRACT(YEAR FROM month) = 2024) AS consumption_2024_ml,
              SUM(consumption_ml) FILTER (WHERE EXTRACT(YEAR FROM month) = 2025) AS consumption_2025_ml,
              SUM(consumption_ml) FILTER (WHERE EXTRACT(YEAR FROM month) = 2026) AS consumption_2026_ml,
              COUNT(*) FILTER (WHERE EXTRACT(YEAR FROM month) = 2020) AS months_2020,
              COUNT(*) FILTER (WHERE EXTRACT(YEAR FROM month) = 2021) AS months_2021,
              COUNT(*) FILTER (WHERE EXTRACT(YEAR FROM month) = 2022) AS months_2022,
              COUNT(*) FILTER (WHERE EXTRACT(YEAR FROM month) = 2023) AS months_2023,
              COUNT(*) FILTER (WHERE EXTRACT(YEAR FROM month) = 2024) AS months_2024,
              COUNT(*) FILTER (WHERE EXTRACT(YEAR FROM month) = 2025) AS months_2025,
              COUNT(*) FILTER (WHERE EXTRACT(YEAR FROM month) = 2026) AS months_2026,
              MAX(connections) FILTER (WHERE EXTRACT(YEAR FROM month) = 2020) AS connections_2020,
              MAX(connections) FILTER (WHERE EXTRACT(YEAR FROM month) = 2021) AS connections_2021,
              MAX(connections) FILTER (WHERE EXTRACT(YEAR FROM month) = 2022) AS connections_2022,
              MAX(connections) FILTER (WHERE EXTRACT(YEAR FROM month) = 2023) AS connections_2023,
              MAX(connections) FILTER (WHERE EXTRACT(YEAR FROM month) = 2024) AS connections_2024,
              MAX(connections) FILTER (WHERE EXTRACT(YEAR FROM month) = 2025) AS connections_2025,
              MAX(connections) FILTER (WHERE EXTRACT(YEAR FROM month) = 2026) AS connections_2026,
              SUM(consumption_ml) FILTER (WHERE EXTRACT(YEAR FROM month) = 2020)
                / NULLIF(MAX(connections) FILTER (WHERE EXTRACT(YEAR FROM month) = 2020), 0) AS cpc_2020,
              SUM(consumption_ml) FILTER (WHERE EXTRACT(YEAR FROM month) = 2021)
                / NULLIF(MAX(connections) FILTER (WHERE EXTRACT(YEAR FROM month) = 2021), 0) AS cpc_2021,
              SUM(consumption_ml) FILTER (WHERE EXTRACT(YEAR FROM month) = 2022)
                / NULLIF(MAX(connections) FILTER (WHERE EXTRACT(YEAR FROM month) = 2022), 0) AS cpc_2022,
              SUM(consumption_ml) FILTER (WHERE EXTRACT(YEAR FROM month) = 2023)
                / NULLIF(MAX(connections) FILTER (WHERE EXTRACT(YEAR FROM month) = 2023), 0) AS cpc_2023,
              SUM(consumption_ml) FILTER (WHERE EXTRACT(YEAR FROM month) = 2024)
                / NULLIF(MAX(connections) FILTER (WHERE EXTRACT(YEAR FROM month) = 2024), 0) AS cpc_2024,
              SUM(consumption_ml) FILTER (WHERE EXTRACT(YEAR FROM month) = 2025)
                / NULLIF(MAX(connections) FILTER (WHERE EXTRACT(YEAR FROM month) = 2025), 0) AS cpc_2025,
              SUM(consumption_ml) FILTER (WHERE EXTRACT(YEAR FROM month) = 2026)
                / NULLIF(MAX(connections) FILTER (WHERE EXTRACT(YEAR FROM month) = 2026), 0) AS cpc_2026
            FROM ward_monthly_consumption
            GROUP BY normalized_ward_name
          )
          SELECT
            latest.ward_name,
            latest.normalized_ward_name,
            latest.month AS latest_month,
            latest.connections,
            latest.consumption_ml,
            latest.consumption_per_connection,
            summary.first_month,
            summary.last_month,
            summary.month_count,
            summary.avg_consumption_ml,
            summary.avg_consumption_per_connection,
            yearly.consumption_2020_ml,
            yearly.consumption_2021_ml,
            yearly.consumption_2022_ml,
            yearly.consumption_2023_ml,
            yearly.consumption_2024_ml,
            yearly.consumption_2025_ml,
            yearly.consumption_2026_ml,
            yearly.months_2020,
            yearly.months_2021,
            yearly.months_2022,
            yearly.months_2023,
            yearly.months_2024,
            yearly.months_2025,
            yearly.months_2026,
            yearly.connections_2020,
            yearly.connections_2021,
            yearly.connections_2022,
            yearly.connections_2023,
            yearly.connections_2024,
            yearly.connections_2025,
            yearly.connections_2026,
            yearly.cpc_2020,
            yearly.cpc_2021,
            yearly.cpc_2022,
            yearly.cpc_2023,
            yearly.cpc_2024,
            yearly.cpc_2025,
            yearly.cpc_2026
          FROM latest
          JOIN summary USING (normalized_ward_name)
          LEFT JOIN yearly USING (normalized_ward_name)
          ORDER BY latest.ward_name
        `;

        return json({
          wards: rows.map(row => ({
            wardName: row.ward_name,
            normalizedWardName: row.normalized_ward_name,
            latestMonth: row.latest_month,
            connections: row.connections || 0,
            consumptionMl: row.consumption_ml || 0,
            consumptionPerConnection: row.consumption_per_connection || 0,
            firstMonth: row.first_month,
            lastMonth: row.last_month,
            monthCount: row.month_count || 0,
            avgConsumptionMl: row.avg_consumption_ml || 0,
            avgConsumptionPerConnection: row.avg_consumption_per_connection || 0,
            consumption2020Ml: row.consumption_2020_ml,
            consumption2021Ml: row.consumption_2021_ml,
            consumption2022Ml: row.consumption_2022_ml,
            consumption2023Ml: row.consumption_2023_ml,
            consumption2024Ml: row.consumption_2024_ml,
            consumption2025Ml: row.consumption_2025_ml,
            consumption2026Ml: row.consumption_2026_ml,
            months2020: row.months_2020 || 0,
            months2021: row.months_2021 || 0,
            months2022: row.months_2022 || 0,
            months2023: row.months_2023 || 0,
            months2024: row.months_2024 || 0,
            months2025: row.months_2025 || 0,
            months2026: row.months_2026 || 0,
            connections2020: row.connections_2020,
            connections2021: row.connections_2021,
            connections2022: row.connections_2022,
            connections2023: row.connections_2023,
            connections2024: row.connections_2024,
            connections2025: row.connections_2025,
            connections2026: row.connections_2026,
            consumptionPerConnection2020: row.cpc_2020,
            consumptionPerConnection2021: row.cpc_2021,
            consumptionPerConnection2022: row.cpc_2022,
            consumptionPerConnection2023: row.cpc_2023,
            consumptionPerConnection2024: row.cpc_2024,
            consumptionPerConnection2025: row.cpc_2025,
            consumptionPerConnection2026: row.cpc_2026
          })),
          count: rows.length
        });
      }

            if (url.pathname === "/api/criticality/wards") {
        const rows = await sql`
          SELECT *
          FROM ward_criticality_summary
          ORDER BY criticality_score DESC, ward_no
        `;

        return json({
          wards: rows.map(row => ({
            wardNo: row.ward_no,
            wardName: row.ward_name,
            qcConfidence: row.qc_confidence,
            usableSensorCount: row.usable_sensor_count || 0,
            avgQcScore: row.avg_qc_score || 0,
            latestConsumptionMl: row.latest_consumption_ml,
            latestConnections: row.latest_connections,
            latestConsumptionPerConnection: row.latest_consumption_per_connection,
            recent90DayRainfallMm: row.recent_90_day_rainfall_mm,
            latestMedianWaterLevelFt: row.latest_median_water_level_ft,
            latestMedianDischargeLpm: row.latest_median_discharge_lpm,
            waterLevelTrendFtPerWeek: row.water_level_trend_ft_per_week,
            waterLevelTrendFtPerMonth: row.water_level_trend_ft_per_month,
            dischargeTrendLpmPerWeek: row.discharge_trend_lpm_per_week,
            dischargeTrendLpmPerMonth: row.discharge_trend_lpm_per_month,
            rainfallResponseFt: row.rainfall_response_ft,
            rainyEventCount: row.rainy_event_count || 0,
            demandScore: row.demand_score || 0,
            groundwaterQcScore: row.groundwater_qc_score || 0,
            rainfallScore: row.rainfall_score || 0,
            depletionScore: row.depletion_score || 0,
            dischargeDeclineScore: row.discharge_decline_score || 0,
            recoveryScore: row.recovery_score || 0,
            criticalityScore: row.criticality_score || 0,
            criticalityStatus: row.criticality_status || "Insufficient Data",
            reasons: Array.isArray(row.reasons) ? row.reasons : [],
            updatedAt: row.updated_at
          })),
          count: rows.length
        });
      }

      if (url.pathname === "/api/criticality/wards.csv") {
        const rows = await sql`
          SELECT *
          FROM ward_criticality_summary
          ORDER BY criticality_score DESC, ward_no
        `;
        const headers = [
          "ward_no",
          "ward_name",
          "criticality_status",
          "criticality_score",
          "qc_confidence",
          "usable_sensor_count",
          "latest_consumption_ml",
          "latest_connections",
          "latest_consumption_per_connection",
          "recent_90_day_rainfall_mm",
          "latest_median_water_level_ft",
          "latest_median_discharge_lpm",
          "water_level_trend_ft_per_week",
          "water_level_trend_ft_per_month",
          "discharge_trend_lpm_per_week",
          "discharge_trend_lpm_per_month",
          "rainfall_response_ft",
          "rainy_event_count",
          "demand_score",
          "depletion_score",
          "discharge_decline_score",
          "recovery_score",
          "rainfall_score",
          "reasons"
        ];
        const csvRows = rows.map(row => [
          row.ward_no,
          row.ward_name,
          row.criticality_status,
          row.criticality_score,
          row.qc_confidence,
          row.usable_sensor_count,
          row.latest_consumption_ml,
          row.latest_connections,
          row.latest_consumption_per_connection,
          row.recent_90_day_rainfall_mm,
          row.latest_median_water_level_ft,
          row.latest_median_discharge_lpm,
          row.water_level_trend_ft_per_week,
          row.water_level_trend_ft_per_month,
          row.discharge_trend_lpm_per_week,
          row.discharge_trend_lpm_per_month,
          row.rainfall_response_ft,
          row.rainy_event_count,
          row.demand_score,
          row.depletion_score,
          row.discharge_decline_score,
          row.recovery_score,
          row.rainfall_score,
          Array.isArray(row.reasons) ? row.reasons.join("; ") : ""
        ]);
        return csvResponse(headers, csvRows, "ward_criticality.csv");
      }

      if (url.pathname === "/api/groundwater-loss/wards.csv") {
        const rows = await sql`
          WITH sensor_uids AS (
            SELECT
              ward_no,
              STRING_AGG(uid, '; ' ORDER BY uid) AS sensor_uids,
              COUNT(*) AS assigned_sensor_count
            FROM sensor_ward_assignments
            WHERE ward_no IS NOT NULL AND ward_no <> ''
            GROUP BY ward_no
          )
          SELECT
            gw.*,
            COALESCE(sensor_uids.sensor_uids, '') AS sensor_uids,
            COALESCE(sensor_uids.assigned_sensor_count, 0) AS assigned_sensor_count
          FROM ward_groundwater_indicators gw
          LEFT JOIN sensor_uids ON sensor_uids.ward_no = gw.ward_no
          WHERE sensor_uids.assigned_sensor_count > 0
          ORDER BY
            water_level_trend_ft_per_month DESC NULLS LAST,
            water_level_trend_ft_per_week DESC NULLS LAST,
            usable_sensor_count DESC,
            ward_no
        `;
        const headers = [
          "rank",
          "ward_no",
          "ward_name",
          "gw_loss_ft_per_week",
          "gw_loss_ft_per_month",
          "sensor_uids",
          "assigned_sensor_count",
          "usable_sensor_count",
          "water_sensor_count",
          "latest_median_water_level_ft",
          "discharge_trend_lpm_per_week",
          "discharge_trend_lpm_per_month",
          "latest_median_discharge_lpm",
          "first_data_at",
          "last_data_at"
        ];
        const csvRows = rows.map((row, index) => [
          index + 1,
          row.ward_no,
          row.ward_name,
          row.water_level_trend_ft_per_week,
          row.water_level_trend_ft_per_month,
          row.sensor_uids,
          row.assigned_sensor_count,
          row.usable_sensor_count,
          row.water_sensor_count,
          row.latest_median_water_level_ft,
          row.discharge_trend_lpm_per_week,
          row.discharge_trend_lpm_per_month,
          row.latest_median_discharge_lpm,
          row.first_data_at,
          row.last_data_at
        ]);
        return csvResponse(headers, csvRows, "groundwater_loss_ward_ranking.csv");
      }

      if (
        url.pathname === "/api/good-sensor-weekly-start-levels.xlsx"
        || url.pathname === "/api/good-sensor-weekly-start-levels.xls"
        || url.pathname === "/api/good-sensor-weekly-start-levels.csv"
      ) {
        const rows = await sql`
          WITH good_sensors AS (
            SELECT uid, ward_no, ward_name, qc_status
            FROM sensor_qc_summary
            WHERE qc_status = 'GOOD'
              AND ward_no IS NOT NULL
              AND ward_no <> ''
          ),
          uploaded_uids AS (
            SELECT DISTINCT uid FROM uploaded_type_b_sessions
          ),
          type_b_points AS (
            SELECT
              q.ward_no,
              q.ward_name,
              q.uid,
              q.qc_status,
              b.start_time AS time,
              b.water_level_start_ft AS water_level_ft
            FROM uploaded_type_b_sessions b
            JOIN good_sensors q ON q.uid = b.uid
            WHERE b.water_level_start_ft IS NOT NULL
            UNION ALL
            SELECT
              q.ward_no,
              q.ward_name,
              q.uid,
              q.qc_status,
              b.stop_time AS time,
              b.water_level_stop_ft AS water_level_ft
            FROM uploaded_type_b_sessions b
            JOIN good_sensors q ON q.uid = b.uid
            WHERE b.water_level_stop_ft IS NOT NULL
          ),
          kh_points AS (
            SELECT
              q.ward_no,
              q.ward_name,
              q.uid,
              q.qc_status,
              w.time,
              COALESCE(w.water_level, w.on_level, w.off_level) AS water_level_ft
            FROM water_levels w
            JOIN good_sensors q ON q.uid = w.uid
            WHERE q.uid NOT IN (SELECT uid FROM uploaded_uids)
              AND COALESCE(w.water_level, w.on_level, w.off_level) IS NOT NULL
          ),
          points AS (
            SELECT * FROM type_b_points
            UNION ALL
            SELECT * FROM kh_points
          ),
          keyed AS (
            SELECT
              ward_no,
              ward_name,
              uid,
              qc_status,
              EXTRACT(YEAR FROM time)::integer AS year,
              EXTRACT(MONTH FROM time)::integer AS month_number,
              TO_CHAR(DATE_TRUNC('month', time), 'YYYY-MM Mon') AS month,
              LEAST((((EXTRACT(DAY FROM time)::integer - 1) / 7) + 1), 4)::integer AS week_number,
              time AS reading_time,
              water_level_ft
            FROM points
          ),
          first_readings AS (
            SELECT *,
              ROW_NUMBER() OVER (
                PARTITION BY uid, year, month_number, week_number
                ORDER BY reading_time ASC
              ) AS reading_rank
            FROM keyed
          )
          SELECT
            ward_no,
            ward_name,
            uid,
            qc_status,
            year,
            month_number,
            month,
            MAX(water_level_ft) FILTER (WHERE week_number = 1) AS week_1_start_water_level_ft,
            MAX(reading_time) FILTER (WHERE week_number = 1) AS week_1_reading_time,
            MAX(water_level_ft) FILTER (WHERE week_number = 2) AS week_2_start_water_level_ft,
            MAX(reading_time) FILTER (WHERE week_number = 2) AS week_2_reading_time,
            MAX(water_level_ft) FILTER (WHERE week_number = 3) AS week_3_start_water_level_ft,
            MAX(reading_time) FILTER (WHERE week_number = 3) AS week_3_reading_time,
            MAX(water_level_ft) FILTER (WHERE week_number = 4) AS week_4_start_water_level_ft,
            MAX(reading_time) FILTER (WHERE week_number = 4) AS week_4_reading_time
          FROM first_readings
          WHERE reading_rank = 1
          GROUP BY ward_no, ward_name, uid, qc_status, year, month_number, month
          ORDER BY year DESC, month_number DESC, ward_no, ward_name, uid
        `;

        return weeklyLevelsExcelResponse(rows, "good_sensor_weekly_start_levels.xlsx");
      }

      if (url.pathname === "/api/critical-wards-groundwater" || url.pathname === "/api/critical-wards-groundwater.xlsx") {
        const payload = await khWeeklyPayload(sql);
        const generatedAt = new Date();
        const updateWindowDays = 15;
        const nextRecommendedUpdate = new Date(generatedAt.getTime() + updateWindowDays * 86400000);
        if (url.pathname.endsWith(".xlsx")) {
          return criticalGroundwaterExcelResponse(payload);
        }
        const { rows } = criticalGroundwaterRows(payload, {
          includeWeeklyColumns: false,
          includePairRows: false
        });
        const methodCounts = {
          linearOnly: rows.filter(row => row.linearMethodCritical === "Yes").length,
          mannKendallOnly: rows.filter(row => row.mannKendallMethodCritical === "Yes").length,
          theilSenOnly: rows.filter(row => row.theilSenMethodCritical === "Yes").length,
          linearAndMannKendall: rows.filter(row => row.linearMannKendallCritical === "Yes").length,
          theilSenAndMannKendall: rows.filter(row => row.theilSenMannKendallCritical === "Yes").length,
          dashboardAction: rows.filter(row => row.dashboardAction === "Yes").length,
          oldConsumptionNoGroundwaterData: rows.filter(row => row.oldConsumptionNoGroundwaterData === "Yes").length
        };
        return cachedJson(request, {
          generatedAt: generatedAt.toISOString(),
          nextRecommendedUpdate: nextRecommendedUpdate.toISOString(),
          updateWindowDays,
          minimumWeeklyValues: CRITICAL_GW_MIN_WEEKS,
          minimumWeeklyComparisons: CRITICAL_GW_MIN_COMPARISONS,
          criticalCount: rows.filter(row => row.groundwaterStatus === "Critical").length,
          actionCount: rows.filter(row => row.groundwaterStatus === "Critical" || row.groundwaterStatus === "Watch").length,
          watchCount: rows.filter(row => row.groundwaterStatus === "Watch").length,
          previousCriticalCount: PREVIOUS_CRITICAL_WARDS.length,
          methodCounts,
          wards: rows
        });
      }

      if (url.pathname === "/api/critical-wards-comparison.xlsx") {
        return await criticalWardComparisonExcelResponse(sql);
      }

      if (url.pathname === "/api/ward-weekly-levels") {
        const source = url.searchParams.get("source") || "kh";
        const wardNo = url.searchParams.get("ward_no");
        const normalizedWardNo = normalizeWardNoValue(wardNo);
        if (source === "vendor") {
          await ensureVendorTables(sql);
          const qcRows = wardNo ? await sql`
            SELECT uid, ward_no, ward_name, qc_status
            FROM vendor_sensor_qc
            WHERE regexp_replace(ward_no, '\.0+$', '') = ${normalizedWardNo}
          ` : await sql`
            SELECT uid, ward_no, ward_name, qc_status
            FROM vendor_sensor_qc
            WHERE ward_no IS NOT NULL
              AND ward_no <> ''
          `;
          const rows = wardNo ? await sql`
            WITH good_sensors AS (
              SELECT uid, ward_no, ward_name
              FROM vendor_sensor_qc
              WHERE qc_status = 'GOOD'
                AND regexp_replace(ward_no, '\.0+$', '') = ${normalizedWardNo}
            )
            SELECT
              q.ward_no,
              q.ward_name,
              q.uid,
              v.updated_at AS reading_time,
              v.water_level_ft,
              NULL::double precision AS on_level,
              NULL::double precision AS off_level,
              NULL::double precision AS runtime_hours
            FROM vendor_water_levels v
            JOIN good_sensors q ON q.uid = v.device_name
            WHERE v.water_level_ft IS NOT NULL
            ORDER BY q.ward_no, q.uid, v.updated_at
          ` : await sql`
            WITH good_sensors AS (
              SELECT uid, ward_no, ward_name
              FROM vendor_sensor_qc
              WHERE qc_status = 'GOOD'
                AND ward_no IS NOT NULL
                AND ward_no <> ''
            )
            SELECT
              q.ward_no,
              q.ward_name,
              q.uid,
              v.updated_at AS reading_time,
              v.water_level_ft,
              NULL::double precision AS on_level,
              NULL::double precision AS off_level,
              NULL::double precision AS runtime_hours
            FROM vendor_water_levels v
            JOIN good_sensors q ON q.uid = v.device_name
            WHERE v.water_level_ft IS NOT NULL
            ORDER BY q.ward_no, q.uid, v.updated_at
          `;
          const payload = weeklyWardPayload(rows, qcRows, Boolean(wardNo));
          return cachedJson(request, wardNo ? {
            source: "vendor",
            ward: payload.wards.find(ward => normalizeWardNoValue(ward.wardNo) === normalizedWardNo) || null,
            weeks: payload.weeks
          } : { source: "vendor", ...payload });
        }

        const qcRows = wardNo ? await sql`
          SELECT uid, ward_no, ward_name, qc_status
          FROM sensor_qc_summary
          WHERE regexp_replace(ward_no, '\.0+$', '') = ${normalizedWardNo}
        ` : await sql`
          SELECT uid, ward_no, ward_name, qc_status
          FROM sensor_qc_summary
          WHERE ward_no IS NOT NULL
            AND ward_no <> ''
        `;
        const rows = wardNo ? await sql`
          WITH good_sensors AS (
            SELECT uid, ward_no, ward_name
            FROM sensor_qc_summary
            WHERE qc_status = 'GOOD'
              AND regexp_replace(ward_no, '\.0+$', '') = ${normalizedWardNo}
          ),
          uploaded_uids AS (
            SELECT DISTINCT uid FROM uploaded_type_b_sessions
          ),
          type_b_points AS (
            SELECT
              q.ward_no,
              q.ward_name,
              q.uid,
              b.stop_time AS reading_time,
              b.water_level_stop_ft AS water_level_ft,
              b.water_level_stop_ft AS on_level,
              b.water_level_start_ft AS off_level,
              COALESCE(b.session_duration_min, EXTRACT(EPOCH FROM (b.stop_time - b.start_time)) / 60) / 60 AS runtime_hours
            FROM uploaded_type_b_sessions b
            JOIN good_sensors q ON q.uid = b.uid
            WHERE b.water_level_stop_ft IS NOT NULL
          ),
          kh_points AS (
            SELECT
              q.ward_no,
              q.ward_name,
              q.uid,
              w.time AS reading_time,
              COALESCE(w.water_level, w.on_level, w.off_level) AS water_level_ft,
              w.on_level,
              w.off_level,
              NULL::double precision AS runtime_hours
            FROM water_levels w
            JOIN good_sensors q ON q.uid = w.uid
            WHERE q.uid NOT IN (SELECT uid FROM uploaded_uids)
              AND COALESCE(w.water_level, w.on_level, w.off_level) IS NOT NULL
          )
          SELECT ward_no, ward_name, uid, reading_time, water_level_ft, on_level, off_level, runtime_hours
          FROM (
            SELECT * FROM type_b_points
            UNION ALL
            SELECT * FROM kh_points
          ) points
          ORDER BY ward_no, uid, reading_time
        ` : await sql`
          WITH good_sensors AS (
            SELECT uid, ward_no, ward_name
            FROM sensor_qc_summary
            WHERE qc_status = 'GOOD'
              AND ward_no IS NOT NULL
              AND ward_no <> ''
          ),
          uploaded_uids AS (
            SELECT DISTINCT uid FROM uploaded_type_b_sessions
          ),
          type_b_points AS (
            SELECT
              q.ward_no,
              q.ward_name,
              q.uid,
              b.stop_time AS reading_time,
              b.water_level_stop_ft AS water_level_ft,
              b.water_level_stop_ft AS on_level,
              b.water_level_start_ft AS off_level,
              COALESCE(b.session_duration_min, EXTRACT(EPOCH FROM (b.stop_time - b.start_time)) / 60) / 60 AS runtime_hours
            FROM uploaded_type_b_sessions b
            JOIN good_sensors q ON q.uid = b.uid
            WHERE b.water_level_stop_ft IS NOT NULL
          ),
          kh_points AS (
            SELECT
              q.ward_no,
              q.ward_name,
              q.uid,
              w.time AS reading_time,
              COALESCE(w.water_level, w.on_level, w.off_level) AS water_level_ft,
              w.on_level,
              w.off_level,
              NULL::double precision AS runtime_hours
            FROM water_levels w
            JOIN good_sensors q ON q.uid = w.uid
            WHERE q.uid NOT IN (SELECT uid FROM uploaded_uids)
              AND COALESCE(w.water_level, w.on_level, w.off_level) IS NOT NULL
          )
          SELECT ward_no, ward_name, uid, reading_time, water_level_ft, on_level, off_level, runtime_hours
          FROM (
            SELECT * FROM type_b_points
            UNION ALL
            SELECT * FROM kh_points
          ) points
          ORDER BY ward_no, uid, reading_time
        `;

        const payload = weeklyWardPayload(rows, qcRows, Boolean(wardNo));
        return cachedJson(request, wardNo ? {
          ward: payload.wards.find(ward => normalizeWardNoValue(ward.wardNo) === normalizedWardNo) || null,
          weeks: payload.weeks
        } : payload);
      }

      if (url.pathname === "/api/indicators/wards") {
        const rows = await sql`
          WITH recent_rainfall AS (
            SELECT
              ward_no,
              SUM(rainfall_mm) AS recent_90_day_rainfall_mm
            FROM ward_daily_rainfall
            WHERE date >= CURRENT_DATE - INTERVAL '90 days'
              AND source = 'CHIRPS'
            GROUP BY ward_no
          )
          SELECT
            gw.*,
            recent_rainfall.recent_90_day_rainfall_mm
          FROM ward_groundwater_indicators gw
          LEFT JOIN recent_rainfall ON recent_rainfall.ward_no = gw.ward_no
          ORDER BY gw.ward_no
        `;

        return json({
          wards: rows.map(row => ({
            wardNo: row.ward_no,
            wardName: row.ward_name,
            usableSensorCount: row.usable_sensor_count || 0,
            waterSensorCount: row.water_sensor_count || 0,
            dischargeSensorCount: row.discharge_sensor_count || 0,
            latestMedianWaterLevelFt: row.latest_median_water_level_ft,
            latestMedianDischargeLpm: row.latest_median_discharge_lpm,
            waterLevelTrendFtPerWeek: row.water_level_trend_ft_per_week,
            waterLevelTrendFtPerMonth: row.water_level_trend_ft_per_month,
            dischargeTrendLpmPerWeek: row.discharge_trend_lpm_per_week,
            dischargeTrendLpmPerMonth: row.discharge_trend_lpm_per_month,
            recent90DayRainfallMm: row.recent_90_day_rainfall_mm,
            rainfallResponseFt: row.rainfall_response_ft,
            rainyEventCount: row.rainy_event_count || 0,
            firstDataAt: row.first_data_at,
            lastDataAt: row.last_data_at,
            updatedAt: row.updated_at
          })),
          count: rows.length
        });
      }

      if (url.pathname === "/api/water-level") {
        const uid = url.searchParams.get("uid");
        if (!uid) return json({ error: "uid is required" }, 400);
        const source = url.searchParams.get("source") || "kh";

        if (source === "vendor") {
          await ensureVendorTables(sql);
          const rows = await sql`
            SELECT updated_at AS time, water_level_ft AS water_level
            FROM vendor_water_levels
            WHERE device_name = ${uid}
            ORDER BY updated_at
          `;
          return json({
            uid,
            source: "vendor",
            points: rows.map(row => ({
              time: row.time,
              waterLevel: row.water_level,
              onLevel: null,
              offLevel: null,
              discharge: null
            }))
          });
        }

        await ensureCompactUploadTable(sql);
        const compactRows = await sql`
          SELECT payload_gzip
          FROM uploaded_sensor_series
          WHERE uid = ${uid}
          LIMIT 1
        `;

        if (compactRows.length) {
          const points = await gunzipJson(compactRows[0].payload_gzip);
          return json({
            uid,
            source: "uploaded_compact",
            points
          });
        }

        await ensureUploadedTables(sql);
        const uploaded = await sql`
          WITH type_b_points AS (
            SELECT start_time AS time, water_level_start_ft AS water_level, NULL::double precision AS on_level,
                   water_level_start_ft AS off_level, NULL::double precision AS discharge
            FROM uploaded_type_b_sessions
            WHERE uid = ${uid}
            UNION ALL
            SELECT stop_time AS time, water_level_stop_ft AS water_level, water_level_stop_ft AS on_level,
                   NULL::double precision AS off_level, NULL::double precision AS discharge
            FROM uploaded_type_b_sessions
            WHERE uid = ${uid}
          ),
          type_a_points AS (
            SELECT time, NULL::double precision AS water_level, NULL::double precision AS on_level,
                   NULL::double precision AS off_level, discharge
            FROM uploaded_type_a_readings
            WHERE uid = ${uid}
          )
          SELECT time, MAX(water_level) AS water_level, MAX(on_level) AS on_level,
                 MAX(off_level) AS off_level, MAX(discharge) AS discharge
          FROM (
            SELECT * FROM type_b_points
            UNION ALL
            SELECT * FROM type_a_points
          ) points
          GROUP BY time
          ORDER BY time
        `;

        const rows = uploaded.length ? uploaded : await sql`
          SELECT time, water_level, on_level, off_level, discharge
          FROM water_levels
          WHERE uid = ${uid}
          ORDER BY time
        `;

        return json({
          uid,
          source: uploaded.length ? "uploaded" : "kh_download",
          points: rows.map(row => ({
            time: row.time,
            waterLevel: row.water_level,
            onLevel: row.on_level,
            offLevel: row.off_level,
            discharge: row.discharge
          }))
        });
      }

      return json({ error: "Not found" }, 404);
    } catch (error) {
      if (isNeonQuotaError(error)) {
        const fallback = await cachedFallback(request);
        if (fallback) return fallback;
        return json({
          error: "Database transfer quota exceeded",
          message: "Neon has exceeded its data-transfer quota, so live database reads are temporarily unavailable. The dashboard will work again after the quota resets or the plan is upgraded.",
          retryable: true
        }, 503);
      }

      if (isMissingRelation(error)) {
        if (url.pathname === "/api/status") {
          return json(statusPayload({ running: false, ok: null, message: "Database is not initialized yet" }));
        }

        if (url.pathname === "/api/refresh") {
          await triggerGithubAction(env);
          return json({ started: true, reason: "database_not_initialized" });
        }

        if (url.pathname === "/api/sensors") {
          return json({ sensors: [], sensorsWithWaterData: 0 });
        }

        if (url.pathname === "/api/qc/sensors") {
          return json({ sensors: [], count: 0 });
        }

        if (url.pathname === "/api/qc/wards") {
          return json({ wards: [], count: 0 });
        }

        if (url.pathname === "/api/ward-weekly-levels") {
          return json(url.searchParams.get("ward_no") ? { ward: null, weeks: [] } : { wards: [], weeks: [] });
        }

        if (url.pathname === "/api/population/wards") {
          return json({ wards: [], count: 0 });
        }

        if (url.pathname === "/api/water-level") {
          return json({ uid: url.searchParams.get("uid") || "", points: [] });
        }
      }

      return json({ error: String(error.message || error) }, 500);
    }
  },
  async scheduled(controller, env, ctx) {
    const sql = neon(env.DATABASE_URL);
    ctx.waitUntil(
      queueRefresh(sql, env, `Scheduled 15-day refresh queued by cron ${controller.cron}`)
        .catch(error => console.error("Scheduled refresh failed", error))
    );
  }
};
