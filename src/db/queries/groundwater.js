import {
  CRITICAL_GW_MIN_WEEKS,
  CRITICAL_GW_MIN_COMPARISONS,
  CRITICAL_GW_DECLINE_FT_PER_WEEK,
  TREND_SIGNIFICANCE_ALPHA,
  WARD_MIN_CLASSIFIED_SENSORS,
  WARD_DECLINING_SENSOR_FRACTION
} from "../../config/constants.js";
import { roundNumber, trendMethods, combinedGroundwaterStatus } from "../../utils/math.js";
import {
  normalizeWardNoValue,
  criticalWardMap,
  validCriticalComparisons,
  weeklyWardPayload
} from "../../utils/data-cleaning.js";

export async function khWeeklyPayload(sql, includeSensorDetails = false) {
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

export function criticalGroundwaterRows(payload, options = {}) {
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

    const classifiedSensorCount = Number(sensorSummary.classifiedSensorCount || 0);
    const decliningSensorCount = Number(sensorSummary.decliningSensorCount || 0);
    const confirmedDecliningSensorCount = Number(sensorSummary.confirmedDecliningSensorCount || 0);
    const improvingSensorCount = Number(sensorSummary.improvingSensorCount || 0);
    const medianSensorSlopeRaw = sensorSummary.medianTheilSenSlopeFtPerWeek;
    const medianSensorSlope = medianSensorSlopeRaw !== null && medianSensorSlopeRaw !== undefined && Number.isFinite(Number(medianSensorSlopeRaw))
      ? Number(medianSensorSlopeRaw)
      : null;
    const decliningSensorFraction = classifiedSensorCount > 0 ? confirmedDecliningSensorCount / classifiedSensorCount : 0;

    const hasSensorAgreement = classifiedSensorCount >= WARD_MIN_CLASSIFIED_SENSORS &&
      decliningSensorFraction >= WARD_DECLINING_SENSOR_FRACTION &&
      medianSensorSlope !== null &&
      medianSensorSlope > CRITICAL_GW_DECLINE_FT_PER_WEEK;

    const groundwaterCritical = linearMannKendallCritical && !cleanRiseOverride;
    const groundwaterWatch = hasEnough && !cleanRiseOverride && !groundwaterCritical &&
      (wardTrend.status === "Watch" || confirmedDecliningSensorCount > 0);
    const dashboardAction = groundwaterCritical || groundwaterWatch;
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
      groundwaterStatus: groundwaterCritical ? "Critical" : groundwaterWatch ? "Watch" : wardTrend.evidence === "insufficient" ? "Insufficient data" : "Normal",
      dashboardAction: dashboardAction ? "Yes" : "No",
      linearMethodCritical: linearMethodCritical ? "Yes" : "No",
      mannKendallMethodCritical: mannKendallMethodCritical ? "Yes" : "No",
      theilSenMethodCritical: theilSenMethodCritical ? "Yes" : "No",
      linearMannKendallCritical: linearMannKendallCritical ? "Yes" : "No",
      theilSenMannKendallCritical: theilSenMannKendallCritical ? "Yes" : "No",
      groundwaterRiseOverride: cleanRiseOverride ? "Yes" : "No",
      oldConsumptionNoGroundwaterData: "No",
      dashboardMapCategory: groundwaterCritical
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
