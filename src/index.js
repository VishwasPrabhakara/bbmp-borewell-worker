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

      if (url.pathname === "/api/qc/sensors") {
        const wardNo = url.searchParams.get("ward_no");
        const status = url.searchParams.get("status");
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
            summary.avg_consumption_per_connection
          FROM latest
          JOIN summary USING (normalized_ward_name)
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
            avgConsumptionPerConnection: row.avg_consumption_per_connection || 0
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

        if (url.pathname === "/api/water-level") {
          return json({ uid: url.searchParams.get("uid") || "", points: [] });
        }
      }

      return json({ error: String(error.message || error) }, 500);
    }
  }
};
