export async function getWardPopulation(sql) {
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

  return {
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
  };
}

export async function getWardConsumption(sql) {
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

  return {
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
  };
}

export async function getWardCriticality(sql) {
  const rows = await sql`
    SELECT *
    FROM ward_criticality_summary
    ORDER BY criticality_score DESC, ward_no
  `;

  return {
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
  };
}

export async function getGoodSensorWeeklyStartLevels(sql) {
  return await sql`
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
}
