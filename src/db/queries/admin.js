import { FRESHNESS_HOURS, RUNNING_TIMEOUT_MINUTES } from "../../config/constants.js";
import { ensureUploadedTables } from "../schema.js";

export function isStale(lastFinished) {
  if (!lastFinished) return true;
  const last = new Date(lastFinished).getTime();
  return Date.now() - last > FRESHNESS_HOURS * 60 * 60 * 1000;
}

export function isRunningStale(lastStarted) {
  if (!lastStarted) return false;
  const started = new Date(lastStarted).getTime();
  return Date.now() - started > RUNNING_TIMEOUT_MINUTES * 60 * 1000;
}

export function statusPayload(row = {}) {
  return {
    running: !!row.running,
    ok: row.ok,
    lastStarted: row.last_started || null,
    lastFinished: row.last_finished || null,
    message: row.message || ""
  };
}

export function requireAdmin(request, env) {
  const expected = env.ADMIN_PASSWORD;
  const provided = request.headers.get("x-admin-password") || "";
  return !!expected && provided === expected;
}

export async function triggerGithubAction(env) {
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

export async function queueRefresh(sql, env, message = "Refresh queued") {
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

export async function upsertAdminSensors(sql, rowsJson) {
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

export async function recalculateSummaries(sql) {
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

export async function uploadTypeA(sql, rows) {
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

export async function uploadTypeB(sql, rows) {
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
