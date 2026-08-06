import {
  FT_TO_M,
  LPM_TO_M3_PER_SEC,
  TRANSMISSIVITY_SCALE,
  MIN_MONTHLY_DRAWDOWN_M
} from "../../config/constants.js";
import { roundNumber } from "../../utils/math.js";
import { normalizeWardNoValue } from "../../utils/data-cleaning.js";

export async function specificCapacityWardSummaries(sql) {
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

export async function pumpingPerformanceWardSummaries(sql) {
  const rows = await sql`
    WITH valid_sessions AS (
      SELECT
        b.uid,
        COALESCE(NULLIF(a.ward_no, ''), NULLIF(s.ward_no, ''), NULLIF(q.ward_no, '')) AS ward_no,
        COALESCE(NULLIF(a.ward_name, ''), NULLIF(s.ward_name, ''), NULLIF(q.ward_name, '')) AS ward_name,
        COALESCE(b.avg_discharge_lpm, b.min_discharge_lpm) * b.session_duration_min / 1000.0 AS pumped_volume_m3,
        (b.min_discharge_lpm * ${LPM_TO_M3_PER_SEC})
          / ((b.water_level_stop_ft - b.water_level_start_ft) * ${FT_TO_M})
          * ${TRANSMISSIVITY_SCALE} AS specific_capacity_scaled,
        (b.water_level_stop_ft - b.water_level_start_ft)
          / (COALESCE(b.avg_discharge_lpm, b.min_discharge_lpm) * b.session_duration_min / 1000.0)
          AS drawdown_ft_per_m3
      FROM uploaded_type_b_sessions b
      LEFT JOIN sensors s ON s.uid = b.uid
      LEFT JOIN sensor_qc_summary q ON q.uid = b.uid
      LEFT JOIN sensor_ward_assignments a ON a.uid = b.uid
      WHERE b.start_time IS NOT NULL
        AND b.stop_time IS NOT NULL
        AND b.session_duration_min > 0
        AND b.water_level_start_ft IS NOT NULL
        AND b.water_level_stop_ft > b.water_level_start_ft
        AND b.min_discharge_lpm > 0
        AND COALESCE(b.avg_discharge_lpm, b.min_discharge_lpm) > 0
        AND COALESCE(NULLIF(a.ward_no, ''), NULLIF(s.ward_no, ''), NULLIF(q.ward_no, '')) IS NOT NULL
    ),
    uid_performance AS (
      SELECT
        uid,
        ward_no,
        MAX(ward_name) AS ward_name,
        COUNT(*)::integer AS sessions,
        SUM(pumped_volume_m3) AS total_volume_m3,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY specific_capacity_scaled) AS median_specific_capacity_scaled,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY median_drawdown_ft_per_m3) AS median_drawdown_ft_per_m3
      FROM valid_sessions
      GROUP BY uid, ward_no
    ),
    ward_performance AS (
      SELECT
        ward_no,
        MAX(ward_name) AS ward_name,
        COUNT(*)::integer AS borewells,
        SUM(sessions)::integer AS total_sessions,
        SUM(total_volume_m3) AS total_volume_m3,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY median_specific_capacity_scaled) AS median_specific_capacity_scaled,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY median_drawdown_ft_per_m3) AS median_drawdown_ft_per_m3
      FROM uid_performance
      GROUP BY ward_no
    ),
    thresholds AS (
      SELECT
        percentile_cont(0.75) WITHIN GROUP (ORDER BY total_volume_m3) AS extraction_p75,
        percentile_cont(0.25) WITHIN GROUP (ORDER BY median_specific_capacity_scaled) AS specific_capacity_p25,
        percentile_cont(0.75) WITHIN GROUP (ORDER BY median_drawdown_ft_per_m3) AS normalized_drawdown_p75
      FROM ward_performance
    )
    SELECT w.*, t.extraction_p75, t.specific_capacity_p25, t.normalized_drawdown_p75
    FROM ward_performance w
    CROSS JOIN thresholds t
    ORDER BY NULLIF(regexp_replace(w.ward_no, '[^0-9.]', '', 'g'), '')::numeric NULLS LAST, w.ward_no
  `;
  const number = value => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const first = rows[0] || {};
  const thresholds = {
    extractionP75M3: number(first.extraction_p75),
    specificCapacityP25Scaled: number(first.specific_capacity_p25),
    normalizedDrawdownP75FtPerM3: number(first.normalized_drawdown_p75)
  };
  const wards = rows.map(row => {
    const totalVolume = number(row.total_volume_m3);
    const medianSpecificCapacity = number(row.median_specific_capacity_scaled);
    const medianNormalizedDrawdown = number(row.median_drawdown_ft_per_m3);
    return {
      wardNo: normalizeWardNoValue(row.ward_no),
      wardName: row.ward_name || "",
      borewells: Number(row.borewells || 0),
      validSessions: Number(row.total_sessions || 0),
      totalPumpedVolumeM3: roundNumber(totalVolume, 2),
      medianSpecificCapacityScaled: roundNumber(medianSpecificCapacity, 4),
      medianNormalizedDrawdownFtPerM3: roundNumber(medianNormalizedDrawdown, 4),
      criticalByExtraction: Number.isFinite(totalVolume) && Number.isFinite(thresholds.extractionP75M3)
        && totalVolume >= thresholds.extractionP75M3,
      criticalBySpecificCapacity: Number.isFinite(medianSpecificCapacity) && Number.isFinite(thresholds.specificCapacityP25Scaled)
        && medianSpecificCapacity <= thresholds.specificCapacityP25Scaled,
      highNormalizedDrawdown: Number.isFinite(medianNormalizedDrawdown) && Number.isFinite(thresholds.normalizedDrawdownP75FtPerM3)
        && medianNormalizedDrawdown >= thresholds.normalizedDrawdownP75FtPerM3
    };
  });
  return { wards, thresholds };
}
