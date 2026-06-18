import { neon } from "@neondatabase/serverless";

const FRESHNESS_HOURS = 6;
const RUNNING_TIMEOUT_MINUTES = 30;

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

function html(body, status = 200) {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store"
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
      session_duration_min DOUBLE PRECISION NULL
    )
  `;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_uploaded_type_a_uid_time_unique ON uploaded_type_a_readings(uid, time)`;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_uploaded_type_b_uid_session_unique ON uploaded_type_b_sessions(uid, start_time, stop_time)`;
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
      SELECT uid, time, false AS has_water, true AS has_discharge
      FROM uploaded_type_a_readings
      UNION ALL
      SELECT uid, start_time AS time, true AS has_water, false AS has_discharge
      FROM uploaded_type_b_sessions
      UNION ALL
      SELECT uid, stop_time AS time, true AS has_water, false AS has_discharge
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
      SELECT DISTINCT uid, lat, lng
      FROM jsonb_to_recordset(${rowsJson}::jsonb) AS x(uid text, lat double precision, lng double precision)
      WHERE uid IS NOT NULL AND uid <> ''
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
    WITH input AS (
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
    )
    INSERT INTO uploaded_type_a_readings (uid, lat, lng, source_file, time, discharge, power_kw, pump_status)
    SELECT uid, lat, lng, source_file, time, discharge, power_kw, pump_status
    FROM input
    WHERE uid IS NOT NULL AND time IS NOT NULL
    ON CONFLICT (uid, time) DO UPDATE SET
      lat = COALESCE(EXCLUDED.lat, uploaded_type_a_readings.lat),
      lng = COALESCE(EXCLUDED.lng, uploaded_type_a_readings.lng),
      source_file = COALESCE(EXCLUDED.source_file, uploaded_type_a_readings.source_file),
      discharge = COALESCE(EXCLUDED.discharge, uploaded_type_a_readings.discharge),
      power_kw = COALESCE(EXCLUDED.power_kw, uploaded_type_a_readings.power_kw),
      pump_status = COALESCE(EXCLUDED.pump_status, uploaded_type_a_readings.pump_status)
  `;
}

async function uploadTypeB(sql, rows) {
  await ensureUploadedTables(sql);
  const rowsJson = JSON.stringify(rows);
  await upsertAdminSensors(sql, rowsJson);
  await sql`
    WITH input AS (
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
    WHERE uid IS NOT NULL AND start_time IS NOT NULL AND stop_time IS NOT NULL
    ON CONFLICT (uid, start_time, stop_time) DO UPDATE SET
      lat = COALESCE(EXCLUDED.lat, uploaded_type_b_sessions.lat),
      lng = COALESCE(EXCLUDED.lng, uploaded_type_b_sessions.lng),
      source_file = COALESCE(EXCLUDED.source_file, uploaded_type_b_sessions.source_file),
      tts_start_seconds = COALESCE(EXCLUDED.tts_start_seconds, uploaded_type_b_sessions.tts_start_seconds),
      water_level_start_m = COALESCE(EXCLUDED.water_level_start_m, uploaded_type_b_sessions.water_level_start_m),
      water_level_start_ft = COALESCE(EXCLUDED.water_level_start_ft, uploaded_type_b_sessions.water_level_start_ft),
      tts_stop_seconds = COALESCE(EXCLUDED.tts_stop_seconds, uploaded_type_b_sessions.tts_stop_seconds),
      water_level_stop_m = COALESCE(EXCLUDED.water_level_stop_m, uploaded_type_b_sessions.water_level_stop_m),
      water_level_stop_ft = COALESCE(EXCLUDED.water_level_stop_ft, uploaded_type_b_sessions.water_level_stop_ft),
      session_duration_min = COALESCE(EXCLUDED.session_duration_min, uploaded_type_b_sessions.session_duration_min)
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
    const BATCH_SIZE = 750;
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

    async function upload() {
      const file = zipEl.files[0];
      const password = passwordEl.value;
      if (!file) throw new Error('Choose a zip file first.');
      if (!password) throw new Error('Enter the admin password.');

      button.disabled = true;
      logEl.textContent = 'Reading zip...';
      const zip = await JSZip.loadAsync(file);
      let typeACount = 0;
      let typeBCount = 0;
      let files = 0;

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
          typeACount += await postRows('/api/admin/upload-type-a', parsed, password);
        }

        if (info.kind === 'TYPEB') {
          const parsed = rows.map(row => {
            const start = khTime(row['timestamp_start (ddmmyy hhmmss)']);
            const stop = khTime(row['timestamp_stop (ddmmyy hhmmss)']);
            const startM = number(row['water level at start (m below surface)']);
            const stopM = number(row['water level at stop (m below surface)']);
            if (!start || !stop || startM === null || stopM === null || stopM <= startM) return null;
            return {
              uid: info.uid,
              lat,
              lng,
              source_file: entry.name.split('/').pop(),
              start_time: start,
              stop_time: stop,
              tts_start_seconds: number(row['TTS at start (seconds)']),
              water_level_start_m: startM,
              water_level_start_ft: startM * M_TO_FT,
              tts_stop_seconds: number(row['TTS at stop (seconds)']),
              water_level_stop_m: stopM,
              water_level_stop_ft: stopM * M_TO_FT,
              session_duration_min: number(row['session duration (min)'])
            };
          }).filter(Boolean);
          typeBCount += await postRows('/api/admin/upload-type-b', parsed, password);
        }

        log('Processed ' + files + ' files. TypeA rows: ' + typeACount + ', TypeB sessions: ' + typeBCount);
      }

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
        await uploadTypeA(sql, rows);
        return json({ ok: true, count: rows.length });
      }

      if (url.pathname === "/api/admin/upload-type-b" && request.method === "POST") {
        if (!requireAdmin(request, env)) return json({ error: "Unauthorized" }, 401);
        const payload = await request.json();
        const rows = Array.isArray(payload.rows) ? payload.rows : [];
        await uploadTypeB(sql, rows);
        return json({ ok: true, count: rows.length });
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

        await sql`
          INSERT INTO refresh_status (id, running, ok, last_started, message)
          VALUES (1, true, true, NOW(), 'Refresh queued')
          ON CONFLICT (id) DO UPDATE SET
            running = true,
            ok = true,
            last_started = NOW(),
            message = 'Refresh queued'
        `;

        await triggerGithubAction(env);

        return json({ started: true });
      }

      if (url.pathname === "/api/sensors") {
        const rows = await sql`
          SELECT uid, lat, lng, ward_no, ward_name, data_category, has_data,
                 first_data_at, last_data_at,
                 water_readings, discharge_readings, total_readings
          FROM sensors
          ORDER BY uid
        `;

        return json({
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

      if (url.pathname === "/api/water-level") {
        const uid = url.searchParams.get("uid");
        if (!uid) return json({ error: "uid is required" }, 400);

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

        if (url.pathname === "/api/water-level") {
          return json({ uid: url.searchParams.get("uid") || "", points: [] });
        }
      }

      return json({ error: String(error.message || error) }, 500);
    }
  }
};
