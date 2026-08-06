export function adminPage() {
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
