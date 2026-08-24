import { roundNumber } from "../../utils/math.js";
import { notUsableReason } from "../../utils/data-cleaning.js";

export async function getQcSensors(sql, source, wardNoFilter, statusFilter) {
  const isVendorSource = source === "vendor";
  const rows = isVendorSource ? await sql`
    SELECT
      v.uid,
      v.ward_no,
      v.ward_name,
      v.lat,
      v.lng,
      'vendor' AS data_source,
      v.total_readings,
      v.valid_readings,
      v.water_readings,
      v.stale_data_days,
      v.coverage_score,
      v.range_score,
      v.stability_score,
      v.recent_data_score,
      v.overall_qc_score,
      v.qc_status,
      v.flags,
      0 AS discharge_readings,
      0 AS water_negative_count,
      0 AS water_too_deep_count,
      0 AS discharge_negative_count,
      0 AS discharge_too_high_count,
      0 AS on_off_logic_error_count,
      0 AS gap_count,
      0 AS spike_count,
      0 AS flatline_count,
      s.motor_hp,
      s.borewell_depth,
      s.pump_name
    FROM vendor_sensor_qc v
    LEFT JOIN sensors s ON s.uid = v.uid
    ORDER BY NULLIF(regexp_replace(v.ward_no, '[^0-9.]', '', 'g'), '')::numeric NULLS LAST, v.ward_no, v.uid
  ` : await sql`
    SELECT
      q.uid,
      q.ward_no,
      q.ward_name,
      q.lat,
      q.lng,
      q.data_source,
      q.total_readings,
      q.valid_readings,
      q.water_readings,
      q.discharge_readings,
      q.stale_data_days,
      q.coverage_score,
      q.range_score,
      q.stability_score,
      q.recent_data_score,
      q.overall_qc_score,
      q.qc_status,
      q.flags,
      q.water_negative_count,
      q.water_too_deep_count,
      q.discharge_negative_count,
      q.discharge_too_high_count,
      q.on_off_logic_error_count,
      q.gap_count,
      q.max_gap_hours,
      q.spike_count,
      q.flatline_count,
      s.motor_hp,
      s.borewell_depth,
      s.pump_name
    FROM sensor_qc_summary q
    JOIN uploaded_sensor_series uploaded ON uploaded.uid = q.uid
    LEFT JOIN sensors s ON s.uid = q.uid
    ORDER BY NULLIF(regexp_replace(q.ward_no, '[^0-9.]', '', 'g'), '')::numeric NULLS LAST, q.ward_no, q.uid
  `;

  let filtered = rows;
  if (wardNoFilter) {
    filtered = filtered.filter(row => String(row.ward_no) === String(wardNoFilter));
  }
  if (statusFilter) {
    filtered = filtered.filter(row => String(row.qc_status).toUpperCase() === String(statusFilter).toUpperCase());
  }

  return filtered.map(row => ({
    uid: row.uid,
    wardNo: row.ward_no,
    wardName: row.ward_name,
    lat: row.lat,
    lng: row.lng,
    dataSource: row.data_source || (isVendorSource ? "vendor" : "kh"),
    motorHp: row.motor_hp ?? null,
    borewellDepth: row.borewell_depth ?? null,
    pumpName: row.pump_name ?? null,
    totalReadings: row.total_readings,
    validReadings: row.valid_readings,
    waterReadings: row.water_readings,
    dischargeReadings: row.discharge_readings,
    staleDataDays: roundNumber(row.stale_data_days, 1),
    coverageScore: roundNumber(row.coverage_score, 1),
    rangeScore: roundNumber(row.range_score, 1),
    stabilityScore: roundNumber(row.stability_score, 1),
    recentDataScore: roundNumber(row.recent_data_score, 1),
    overallQcScore: roundNumber(row.overall_qc_score, 1),
    qcStatus: row.qc_status,
    flags: Array.isArray(row.flags) ? row.flags : [],
    subtypeCounts: {
      waterNegativeCount: Number(row.water_negative_count || 0),
      waterTooDeepCount: Number(row.water_too_deep_count || 0),
      dischargeNegativeCount: Number(row.discharge_negative_count || 0),
      dischargeTooHighCount: Number(row.discharge_too_high_count || 0),
      onOffLogicErrorCount: Number(row.on_off_logic_error_count || 0),
      gapCount: Number(row.gap_count || 0),
      maxGapHours: roundNumber(row.max_gap_hours, 1),
      spikeCount: Number(row.spike_count || 0),
      flatlineCount: Number(row.flatline_count || 0)
    },
    notUsableReason: row.qc_status !== "GOOD" ? notUsableReason(row) : null
  }));
}

export async function getQcWards(sql, source) {
  const isVendorSource = source === "vendor";
  const rows = isVendorSource ? await sql`
    SELECT
      ward_no,
      ward_name,
      COUNT(*)::integer AS total_sensors,
      COUNT(*) FILTER (WHERE qc_status = 'GOOD')::integer AS good_sensors,
      COUNT(*) FILTER (WHERE qc_status <> 'GOOD')::integer AS not_usable_sensors,
      ROUND(AVG(overall_qc_score)::numeric, 1)::double precision AS avg_qc_score,
      ARRAY_AGG(uid ORDER BY uid) FILTER (WHERE qc_status = 'GOOD') AS good_uids,
      ARRAY_AGG(uid ORDER BY uid) FILTER (WHERE qc_status <> 'GOOD') AS not_usable_uids
    FROM vendor_sensor_qc
    WHERE ward_no IS NOT NULL AND ward_no <> ''
    GROUP BY ward_no, ward_name
    ORDER BY NULLIF(regexp_replace(ward_no, '[^0-9.]', '', 'g'), '')::numeric NULLS LAST, ward_no
  ` : await sql`
    SELECT
      COALESCE(NULLIF(q.ward_no, ''), NULLIF(s.ward_no, ''), NULLIF(a.ward_no, '')) AS ward_no,
      COALESCE(NULLIF(q.ward_name, ''), NULLIF(s.ward_name, ''), NULLIF(a.ward_name, '')) AS ward_name,
      COUNT(*)::integer AS total_sensors,
      COUNT(*) FILTER (WHERE q.qc_status = 'GOOD')::integer AS good_sensors,
      COUNT(*) FILTER (WHERE q.qc_status = 'USABLE_WITH_CAUTION')::integer AS usable_caution_sensors,
      COUNT(*) FILTER (WHERE q.qc_status = 'POOR')::integer AS poor_sensors,
      COUNT(*) FILTER (WHERE q.qc_status IN ('NO_DATA', 'INSUFFICIENT_DATA'))::integer AS no_data_sensors,
      COUNT(*) FILTER (WHERE q.qc_status <> 'GOOD')::integer AS not_usable_sensors,
      ROUND((COUNT(*) FILTER (WHERE q.qc_status = 'GOOD')::numeric / NULLIF(COUNT(*)::numeric, 0)) * 100, 1)::double precision AS good_percent,
      ROUND(AVG(overall_qc_score)::numeric, 1)::double precision AS avg_qc_score,
      ARRAY_AGG(q.uid ORDER BY q.uid) FILTER (WHERE q.qc_status = 'GOOD') AS good_uids,
      ARRAY_AGG(q.uid ORDER BY q.uid) FILTER (WHERE q.qc_status <> 'GOOD') AS not_usable_uids
    FROM sensor_qc_summary q
    JOIN uploaded_sensor_series uploaded ON uploaded.uid = q.uid
    LEFT JOIN sensors s ON s.uid = q.uid
    LEFT JOIN sensor_ward_assignments a ON a.uid = q.uid
    WHERE COALESCE(NULLIF(q.ward_no, ''), NULLIF(s.ward_no, ''), NULLIF(a.ward_no, '')) IS NOT NULL
    GROUP BY
      COALESCE(NULLIF(q.ward_no, ''), NULLIF(s.ward_no, ''), NULLIF(a.ward_no, '')),
      COALESCE(NULLIF(q.ward_name, ''), NULLIF(s.ward_name, ''), NULLIF(a.ward_name, ''))
    ORDER BY NULLIF(regexp_replace(COALESCE(NULLIF(q.ward_no, ''), NULLIF(s.ward_no, ''), NULLIF(a.ward_no, '')), '[^0-9.]', '', 'g'), '')::numeric NULLS LAST,
      COALESCE(NULLIF(q.ward_no, ''), NULLIF(s.ward_no, ''), NULLIF(a.ward_no, ''))
  `;

  return rows.map(row => {
    const totalSensors = Number(row.total_sensors || 0);
    const goodSensors = Number(row.good_sensors || 0);
    const notUsableSensors = Number(row.not_usable_sensors || 0);
    return {
      wardNo: row.ward_no,
      wardName: row.ward_name,
      totalSensors,
      goodSensors,
      notUsableSensors,
      usableCautionSensors: Number(row.usable_caution_sensors || 0),
      poorSensors: Number(row.poor_sensors || 0),
      noDataSensors: Number(row.no_data_sensors || 0),
      goodPercent: totalSensors ? roundNumber((goodSensors / totalSensors) * 100, 1) : Number(row.good_percent || 0),
      avgQcScore: roundNumber(row.avg_qc_score, 1),
      goodUids: Array.isArray(row.good_uids) ? row.good_uids : [],
      notUsableUids: Array.isArray(row.not_usable_uids) ? row.not_usable_uids : []
    };
  });
}
