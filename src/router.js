import {
  json,
  html,
  csvResponse,
  cachedJson,
  cachedFallback,
  isNeonQuotaError
} from "./utils/response.js";
import { getDb } from "./db/client.js";
import { adminPage } from "./views/admin-page.js";
import {
  requireAdmin,
  isStale,
  isRunningStale,
  statusPayload,
  queueRefresh,
  triggerGithubAction,
  recalculateSummaries,
  uploadTypeA,
  uploadTypeB
} from "./db/queries/admin.js";
import {
  ensureVendorTables,
  ensureCompactUploadTable,
  ensureSensorMetadataColumns,
  ensureUploadedTables
} from "./db/schema.js";
import { getQcSensors, getQcWards } from "./db/queries/qc.js";
import { khWeeklyPayload, criticalGroundwaterRows } from "./db/queries/groundwater.js";
import { specificCapacityWardSummaries, pumpingPerformanceWardSummaries } from "./db/queries/pumping.js";
import { getWardPopulation, getWardConsumption, getWardCriticality, getGoodSensorWeeklyStartLevels } from "./db/queries/demography.js";
import {
  tableExcelResponse,
  multiSheetExcelResponse,
  weeklyLevelsExcelResponse,
  criticalGroundwaterExcelResponse,
  criticalWardComparisonExcelResponse
} from "./utils/excel.js";
import { formatExcelDateTime, minutesBetween, datePart } from "./date.js";
import {
  notUsableReason,
  normalizeWardNoValue,
  weeklyWardPayload,
  compactPointLevel,
  compactPointDischarge,
  compactPointDurationMinutes,
  cleanedSpecificCapacitySessions,
  averagePumpingMinutesPerDay,
  maxPumpingMinutesPerDay,
  monthlySpecificCapacitySheets
} from "./utils/data-cleaning.js";
import { roundNumber, inverseSpecificCapacity } from "./utils/math.js";
import { FT_TO_M, LPM_TO_M3_PER_SEC, TRANSMISSIVITY_SCALE, MIN_MONTHLY_DRAWDOWN_M, CRITICAL_GW_MIN_WEEKS, CRITICAL_GW_MIN_COMPARISONS, PREVIOUS_CRITICAL_WARDS } from "./config/constants.js";

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

export function payloadBytes(value) {
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

export async function gunzipJsonPayload(value) {
  const bytes = payloadBytes(value);
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  const text = await new Response(stream).text();
  return JSON.parse(text);
}

export async function handleRequest(request, env) {
  if (request.method === "OPTIONS") return json({ ok: true });

  const url = new URL(request.url);
  const sql = getDb(env);

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
      await ensureSensorMetadataColumns(sql);
      const rows = await sql`
        SELECT
          COALESCE(s.uid, uploaded.uid) AS uid,
          COALESCE(uploaded.lat, s.lat) AS lat,
          COALESCE(uploaded.lng, s.lng) AS lng,
          s.ward_no,
          s.ward_name,
          s.motor_hp,
          s.borewell_depth,
          s.pump_name,
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
          motorHp: row.motor_hp,
          borewellDepth: row.borewell_depth,
          pumpName: row.pump_name,
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
      }
      const sensors = await getQcSensors(sql, source, wardNo, status);
      return json({
        ...(source === "vendor" ? { source: "vendor" } : {}),
        sensors,
        count: sensors.length
      });
    }

    if (url.pathname === "/api/qc/not-usable-sensors.xlsx" || url.pathname === "/api/qc/not-usable-sensors.csv") {
      const rows = await sql`
        SELECT *
        FROM sensor_qc_summary
        WHERE qc_status <> 'GOOD'
          AND (
            COALESCE(total_readings, 0) > 0
            OR qc_status <> 'NO_DATA'
          )
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
        "uid", "ward_no", "ward_name", "first_data_at", "last_data_at",
        "reason", "total_readings", "valid_readings", "water_readings",
        "gap_count", "max_gap_hours", "range_error_count", "spike_count",
        "flatline_count", "stale_data_days", "lat", "lng"
      ];
      const csvRows = rows.map(row => [
        row.uid, row.ward_no, row.ward_name, formatExcelDateTime(row.first_data_at),
        formatExcelDateTime(row.last_data_at), notUsableReason(row),
        row.total_readings, row.valid_readings, row.water_readings, row.gap_count,
        row.max_gap_hours, row.range_error_count, row.spike_count, row.flatline_count,
        row.stale_data_days, row.lat, row.lng
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
            COALESCE(b.session_duration_min, EXTRACT(EPOCH FROM (b.stop_time - b.start_time)) / 60.0) AS duration_min,
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
          ward_no, ward_name, uid, lat, lng, start_time, stop_time, duration_min,
          water_level_start_ft, water_level_stop_ft, drawdown_ft, min_discharge_lpm,
          start_discharge_lpm, stop_discharge_lpm, avg_discharge_lpm, max_discharge_lpm,
          discharge_readings_in_session, min_discharge_lpm / drawdown_ft AS specific_capacity_lpm_per_ft
        FROM session_discharge
        WHERE drawdown_ft > 0
          AND COALESCE(duration_min, EXTRACT(EPOCH FROM (stop_time - start_time)) / 60.0) >= 0.5
        ORDER BY NULLIF(regexp_replace(ward_no, '[^0-9]', '', 'g'), '')::int NULLS LAST, ward_no, ward_name, uid, start_time
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
          const points = payload.filter(point => point.time).sort((a, b) => String(a.time).localeCompare(String(b.time)));
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
              openSession = { start_time: point.time, water_level_start_ft: offLevel, discharges: [] };
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
          return String(a.ward_no).localeCompare(String(b.ward_no)) || String(a.uid).localeCompare(String(b.uid)) || String(a.start_time).localeCompare(String(b.start_time));
        });
      }

      const sheets = monthlySpecificCapacitySheets(rows);
      const filename = requestedWardNo
        ? `specific_capacity_ward_${normalizedRequestedWardNo || requestedWardNo}.xlsx`
        : "specific_capacity_monthly_by_ward_uid.xlsx";
      return multiSheetExcelResponse(sheets, filename);
    }

    if (url.pathname === "/api/pumping-performance/wards") {
      const payload = await pumpingPerformanceWardSummaries(sql);
      return cachedJson(request, {
        ...payload,
        counts: {
          wardsWithValidSessions: payload.wards.length,
          extractionCritical: payload.wards.filter(ward => ward.criticalByExtraction).length,
          specificCapacityCritical: payload.wards.filter(ward => ward.criticalBySpecificCapacity).length,
          pumpingStressCritical: payload.wards.filter(ward => ward.highNormalizedDrawdown).length
        },
        method: {
          extraction: "Critical when total estimated pumped volume is at or above the citywide ward 75th percentile.",
          specificCapacity: "Critical when ward median specific capacity is at or below the citywide ward 25th percentile.",
          pumpingStress: "Critical when ward median volume-normalized drawdown is at or above the citywide ward 75th percentile.",
          note: "These are relative screening categories among wards with valid pumping sessions, not universal engineering limits."
        }
      });
    }

    if (url.pathname === "/api/pumping-performance/ward") {
      const requestedWardNo = url.searchParams.get("ward_no");
      if (!requestedWardNo) return json({ ward: null, sensors: [] }, 400);
      const normalizedRequestedWardNo = normalizeWardNoValue(requestedWardNo);
      const rows = await sql`
        WITH valid_sessions AS (
          SELECT
            b.uid,
            COALESCE(NULLIF(a.ward_no, ''), NULLIF(s.ward_no, '')) AS ward_no,
            COALESCE(NULLIF(a.ward_name, ''), NULLIF(s.ward_name, '')) AS ward_name,
            s.lat, s.lng, s.motor_hp, s.borewell_depth, s.pump_name,
            b.start_time, b.stop_time, b.session_duration_min,
            b.water_level_stop_ft - b.water_level_start_ft AS drawdown_ft,
            COALESCE(b.avg_discharge_lpm, b.min_discharge_lpm) AS volume_discharge_lpm,
            b.min_discharge_lpm,
            COALESCE(b.avg_discharge_lpm, b.min_discharge_lpm) * b.session_duration_min / 1000.0 AS pumped_volume_m3,
            (b.min_discharge_lpm * ${LPM_TO_M3_PER_SEC}) / ((b.water_level_stop_ft - b.water_level_start_ft) * ${FT_TO_M}) * ${TRANSMISSIVITY_SCALE} AS specific_capacity_scaled,
            (b.water_level_stop_ft - b.water_level_start_ft) / (COALESCE(b.avg_discharge_lpm, b.min_discharge_lpm) * b.session_duration_min / 1000.0) AS drawdown_ft_per_m3
          FROM uploaded_type_b_sessions b
          LEFT JOIN sensors s ON s.uid = b.uid
          LEFT JOIN sensor_ward_assignments a ON a.uid = b.uid
          WHERE b.start_time IS NOT NULL AND b.stop_time IS NOT NULL AND b.session_duration_min > 0
            AND b.water_level_start_ft IS NOT NULL AND b.water_level_stop_ft > b.water_level_start_ft
            AND b.min_discharge_lpm > 0 AND COALESCE(b.avg_discharge_lpm, b.min_discharge_lpm) > 0
            AND COALESCE(NULLIF(a.ward_no, ''), NULLIF(s.ward_no, '')) IS NOT NULL
        ),
        uid_performance AS (
          SELECT
            uid, ward_no, MAX(ward_name) AS ward_name, MAX(lat) AS lat, MAX(lng) AS lng,
            MAX(motor_hp) AS motor_hp, MAX(borewell_depth) AS borewell_depth, MAX(pump_name) AS pump_name,
            COUNT(*)::integer AS sessions, MIN(start_time) AS first_session, MAX(stop_time) AS last_session,
            SUM(session_duration_min) AS total_duration_min, SUM(pumped_volume_m3) AS total_volume_m3,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY pumped_volume_m3) AS median_session_volume_m3,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY drawdown_ft) AS median_drawdown_ft,
            MAX(drawdown_ft) AS max_drawdown_ft,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY volume_discharge_lpm) AS median_discharge_lpm,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY specific_capacity_scaled) AS median_specific_capacity_scaled,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY drawdown_ft_per_m3) AS median_drawdown_ft_per_m3
          FROM valid_sessions
          GROUP BY uid, ward_no
        ),
        ward_performance AS (
          SELECT
            ward_no, MAX(ward_name) AS ward_name, COUNT(*)::integer AS borewells,
            COUNT(motor_hp)::integer AS borewells_with_hp, SUM(sessions)::integer AS total_sessions,
            SUM(total_volume_m3) AS total_volume_m3,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY total_volume_m3) AS median_uid_volume_m3,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY median_specific_capacity_scaled) AS median_specific_capacity_scaled,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY median_drawdown_ft_per_m3) AS median_drawdown_ft_per_m3
          FROM uid_performance
          GROUP BY ward_no
        ),
        thresholds AS (
          SELECT
            percentile_cont(0.25) WITHIN GROUP (ORDER BY median_specific_capacity_scaled) AS uid_sc_p25,
            percentile_cont(0.75) WITHIN GROUP (ORDER BY median_specific_capacity_scaled) AS uid_sc_p75,
            percentile_cont(0.50) WITHIN GROUP (ORDER BY median_drawdown_ft_per_m3) AS uid_stress_p50,
            percentile_cont(0.75) WITHIN GROUP (ORDER BY median_drawdown_ft_per_m3) AS uid_stress_p75,
            percentile_cont(0.75) WITHIN GROUP (ORDER BY total_volume_m3) AS uid_volume_p75
          FROM uid_performance
        ),
        ward_thresholds AS (
          SELECT
            percentile_cont(0.75) WITHIN GROUP (ORDER BY median_drawdown_ft_per_m3) AS ward_stress_p75,
            percentile_cont(0.25) WITHIN GROUP (ORDER BY median_specific_capacity_scaled) AS ward_sc_p25,
            percentile_cont(0.75) WITHIN GROUP (ORDER BY total_volume_m3) AS ward_volume_p75
          FROM ward_performance
        )
        SELECT u.*, w.borewells, w.borewells_with_hp, w.total_sessions, w.total_volume_m3 AS ward_total_volume_m3,
               w.median_uid_volume_m3, w.median_specific_capacity_scaled AS ward_median_specific_capacity_scaled,
               w.median_drawdown_ft_per_m3 AS ward_median_drawdown_ft_per_m3,
               t.uid_sc_p25, t.uid_sc_p75, t.uid_stress_p50, t.uid_stress_p75, t.uid_volume_p75,
               wt.ward_stress_p75, wt.ward_sc_p25, wt.ward_volume_p75
        FROM uid_performance u
        JOIN ward_performance w ON w.ward_no = u.ward_no
        CROSS JOIN thresholds t
        CROSS JOIN ward_thresholds wt
        WHERE regexp_replace(u.ward_no, '\\.0+$', '') = ${normalizedRequestedWardNo}
        ORDER BY u.median_drawdown_ft_per_m3 DESC NULLS LAST, u.uid
      `;

      if (!rows.length) {
        return cachedJson(request, {
          ward: null,
          sensors: [],
          method: {
            volume: "Pumped volume (m3) = average session discharge (L/min) x pumping duration (min) / 1000. Minimum discharge is used only when average discharge is unavailable.",
            normalizedDrawdown: "Volume-normalized drawdown (ft/m3) = pumping drawdown (ft) / pumped volume (m3)."
          }
        });
      }

      const first = rows[0];
      const number = value => {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : null;
      };
      const thresholds = {
        uidSpecificCapacityP25: number(first.uid_sc_p25),
        uidSpecificCapacityP75: number(first.uid_sc_p75),
        uidNormalizedDrawdownP50: number(first.uid_stress_p50),
        uidNormalizedDrawdownP75: number(first.uid_stress_p75),
        uidTotalVolumeP75: number(first.uid_volume_p75),
        wardNormalizedDrawdownP75: number(first.ward_stress_p75),
        wardSpecificCapacityP25: number(first.ward_sc_p25),
        wardTotalVolumeP75: number(first.ward_volume_p75)
      };
      const sensors = rows.map(row => {
        const specificCapacity = number(row.median_specific_capacity_scaled);
        const normalizedDrawdown = number(row.median_drawdown_ft_per_m3);
        const totalVolume = number(row.total_volume_m3);
        const specificCapacityClass = specificCapacity <= thresholds.uidSpecificCapacityP25
          ? "Low performance"
          : specificCapacity >= thresholds.uidSpecificCapacityP75
            ? "High performance"
            : "Medium performance";
        const normalizedDrawdownClass = normalizedDrawdown >= thresholds.uidNormalizedDrawdownP75
          ? "High stress"
          : normalizedDrawdown <= thresholds.uidNormalizedDrawdownP50
            ? "Low stress"
            : "Moderate stress";
        const highExtraction = totalVolume >= thresholds.uidTotalVolumeP75;
        const interpretation = specificCapacityClass === "Low performance" && normalizedDrawdownClass === "High stress"
          ? "High priority"
          : highExtraction
            ? "High extraction"
            : specificCapacityClass === "High performance" && normalizedDrawdownClass === "Low stress"
              ? "Good performer"
              : "Moderate / normal";
        const motorHp = number(row.motor_hp);
        return {
          uid: String(row.uid),
          wardNo: row.ward_no,
          wardName: row.ward_name,
          lat: number(row.lat),
          lng: number(row.lng),
          motorHp,
          borewellDepth: number(row.borewell_depth),
          pumpName: row.pump_name || null,
          sessions: number(row.sessions),
          firstSession: row.first_session,
          lastSession: row.last_session,
          totalDurationMin: roundNumber(row.total_duration_min, 1),
          totalPumpedVolumeM3: roundNumber(totalVolume, 2),
          medianSessionVolumeM3: roundNumber(row.median_session_volume_m3, 2),
          medianDrawdownFt: roundNumber(row.median_drawdown_ft, 2),
          maxDrawdownFt: roundNumber(row.max_drawdown_ft, 2),
          medianDischargeLpm: roundNumber(row.median_discharge_lpm, 2),
          medianSpecificCapacityScaled: roundNumber(specificCapacity, 4),
          medianNormalizedDrawdownFtPerM3: roundNumber(normalizedDrawdown, 4),
          totalVolumeM3PerHp: motorHp > 0 ? roundNumber(totalVolume / motorHp, 2) : null,
          specificCapacityClass,
          normalizedDrawdownClass,
          extractionClass: highExtraction ? "High extraction" : "Normal extraction",
          interpretation
        };
      });
      const wardNormalizedDrawdown = number(first.ward_median_drawdown_ft_per_m3);
      const wardSpecificCapacity = number(first.ward_median_specific_capacity_scaled);
      const wardTotalVolume = number(first.ward_total_volume_m3);
      const wardClassification = wardNormalizedDrawdown >= thresholds.wardNormalizedDrawdownP75
        ? "High pumping stress"
        : wardSpecificCapacity <= thresholds.wardSpecificCapacityP25
          ? "Low specific-capacity performance"
          : wardTotalVolume >= thresholds.wardTotalVolumeP75
            ? "High extraction"
            : "Normal pumping performance";

      return cachedJson(request, {
        ward: {
          wardNo: first.ward_no,
          wardName: first.ward_name,
          borewells: number(first.borewells),
          borewellsWithHp: number(first.borewells_with_hp),
          totalSessions: number(first.total_sessions),
          totalPumpedVolumeM3: roundNumber(wardTotalVolume, 2),
          medianUidPumpedVolumeM3: roundNumber(first.median_uid_volume_m3, 2),
          medianSpecificCapacityScaled: roundNumber(wardSpecificCapacity, 4),
          medianNormalizedDrawdownFtPerM3: roundNumber(wardNormalizedDrawdown, 4),
          classification: wardClassification,
          highPriorityUids: sensors.filter(sensor => sensor.interpretation === "High priority").length,
          highExtractionUids: sensors.filter(sensor => sensor.extractionClass === "High extraction").length
        },
        sensors,
        thresholds,
        method: {
          volume: "Pumped volume (m3) = average session discharge (L/min) x pumping duration (min) / 1000. Minimum discharge is used only when average discharge is unavailable.",
          normalizedDrawdown: "Volume-normalized drawdown (ft/m3) = pumping drawdown (ft) / pumped volume (m3). Higher values indicate a larger water-level response per unit extracted volume.",
          classification: "Screening classes use current citywide percentile thresholds and update with the database. They are relative screening categories, not universal engineering limits."
        }
      });
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
        const points = payload.filter(point => point.time).sort((a, b) => String(a.time).localeCompare(String(b.time)));
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
      const source = url.searchParams.get("source") || "kh";
      const wards = await getQcWards(sql, source);
      return json({
        ...(source === "vendor" ? { source: "vendor" } : {}),
        wards,
        count: wards.length
      });
    }

    if (url.pathname === "/api/population/wards") {
      const result = await getWardPopulation(sql);
      return json(result);
    }

    if (url.pathname === "/api/consumption/wards") {
      const result = await getWardConsumption(sql);
      return json(result);
    }

    if (url.pathname === "/api/criticality/wards") {
      const result = await getWardCriticality(sql);
      return json(result);
    }

    if (url.pathname === "/api/criticality/wards.csv") {
      const rows = await sql`
        SELECT *
        FROM ward_criticality_summary
        ORDER BY criticality_score DESC, ward_no
      `;
      const headers = [
        "ward_no", "ward_name", "criticality_status", "criticality_score",
        "qc_confidence", "usable_sensor_count", "latest_consumption_ml",
        "latest_connections", "latest_consumption_per_connection",
        "recent_90_day_rainfall_mm", "latest_median_water_level_ft",
        "latest_median_discharge_lpm", "water_level_trend_ft_per_week",
        "water_level_trend_ft_per_month", "discharge_trend_lpm_per_week",
        "discharge_trend_lpm_per_month", "rainfall_response_ft",
        "rainy_event_count", "demand_score", "depletion_score",
        "discharge_decline_score", "recovery_score", "rainfall_score", "reasons"
      ];
      const csvRows = rows.map(row => [
        row.ward_no, row.ward_name, row.criticality_status, row.criticality_score,
        row.qc_confidence, row.usable_sensor_count, row.latest_consumption_ml,
        row.latest_connections, row.latest_consumption_per_connection,
        row.recent_90_day_rainfall_mm, row.latest_median_water_level_ft,
        row.latest_median_discharge_lpm, row.water_level_trend_ft_per_week,
        row.water_level_trend_ft_per_month, row.discharge_trend_lpm_per_week,
        row.discharge_trend_lpm_per_month, row.rainfall_response_ft,
        row.rainy_event_count, row.demand_score, row.depletion_score,
        row.discharge_decline_score, row.recovery_score, row.rainfall_score,
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
        "rank", "ward_no", "ward_name", "gw_loss_ft_per_week", "gw_loss_ft_per_month",
        "sensor_uids", "assigned_sensor_count", "usable_sensor_count", "water_sensor_count",
        "latest_median_water_level_ft", "discharge_trend_lpm_per_week",
        "discharge_trend_lpm_per_month", "latest_median_discharge_lpm",
        "first_data_at", "last_data_at"
      ];
      const csvRows = rows.map((row, index) => [
        index + 1, row.ward_no, row.ward_name, row.water_level_trend_ft_per_week,
        row.water_level_trend_ft_per_month, row.sensor_uids, row.assigned_sensor_count,
        row.usable_sensor_count, row.water_sensor_count, row.latest_median_water_level_ft,
        row.discharge_trend_lpm_per_week, row.discharge_trend_lpm_per_month,
        row.latest_median_discharge_lpm, row.first_data_at, row.last_data_at
      ]);
      return csvResponse(headers, csvRows, "groundwater_loss_ward_ranking.csv");
    }

    if (
      url.pathname === "/api/good-sensor-weekly-start-levels.xlsx" ||
      url.pathname === "/api/good-sensor-weekly-start-levels.xls" ||
      url.pathname === "/api/good-sensor-weekly-start-levels.csv"
    ) {
      const rows = await getGoodSensorWeeklyStartLevels(sql);
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
          WHERE regexp_replace(ward_no, '\\.0+$', '') = ${normalizedWardNo}
        ` : await sql`
          SELECT uid, ward_no, ward_name, qc_status
          FROM vendor_sensor_qc
          WHERE ward_no IS NOT NULL AND ward_no <> ''
        `;
        const rows = wardNo ? await sql`
          WITH good_sensors AS (
            SELECT uid, ward_no, ward_name
            FROM vendor_sensor_qc
            WHERE qc_status = 'GOOD'
              AND regexp_replace(ward_no, '\\.0+$', '') = ${normalizedWardNo}
          )
          SELECT
            q.ward_no, q.ward_name, q.uid, v.updated_at AS reading_time,
            v.water_level_ft, NULL::double precision AS on_level,
            NULL::double precision AS off_level, NULL::double precision AS runtime_hours
          FROM vendor_water_levels v
          JOIN good_sensors q ON q.uid = v.device_name
          WHERE v.water_level_ft IS NOT NULL
          ORDER BY q.ward_no, q.uid, v.updated_at
        ` : await sql`
          WITH good_sensors AS (
            SELECT uid, ward_no, ward_name
            FROM vendor_sensor_qc
            WHERE qc_status = 'GOOD' AND ward_no IS NOT NULL AND ward_no <> ''
          )
          SELECT
            q.ward_no, q.ward_name, q.uid, v.updated_at AS reading_time,
            v.water_level_ft, NULL::double precision AS on_level,
            NULL::double precision AS off_level, NULL::double precision AS runtime_hours
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
        WHERE regexp_replace(ward_no, '\\.0+$', '') = ${normalizedWardNo}
      ` : await sql`
        SELECT uid, ward_no, ward_name, qc_status
        FROM sensor_qc_summary
        WHERE ward_no IS NOT NULL AND ward_no <> ''
      `;
      const rows = wardNo ? await sql`
        WITH good_sensors AS (
          SELECT uid, ward_no, ward_name
          FROM sensor_qc_summary
          WHERE qc_status = 'GOOD'
            AND regexp_replace(ward_no, '\\.0+$', '') = ${normalizedWardNo}
        ),
        uploaded_uids AS (
          SELECT DISTINCT uid FROM uploaded_type_b_sessions
        ),
        type_b_points AS (
          SELECT
            q.ward_no, q.ward_name, q.uid, b.stop_time AS reading_time,
            b.water_level_stop_ft AS water_level_ft, b.water_level_stop_ft AS on_level,
            b.water_level_start_ft AS off_level,
            COALESCE(b.session_duration_min, EXTRACT(EPOCH FROM (b.stop_time - b.start_time)) / 60) / 60 AS runtime_hours
          FROM uploaded_type_b_sessions b
          JOIN good_sensors q ON q.uid = b.uid
          WHERE b.water_level_stop_ft IS NOT NULL
        ),
        kh_points AS (
          SELECT
            q.ward_no, q.ward_name, q.uid, w.time AS reading_time,
            COALESCE(w.water_level, w.on_level, w.off_level) AS water_level_ft,
            w.on_level, w.off_level, NULL::double precision AS runtime_hours
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
          WHERE qc_status = 'GOOD' AND ward_no IS NOT NULL AND ward_no <> ''
        ),
        uploaded_uids AS (
          SELECT DISTINCT uid FROM uploaded_type_b_sessions
        ),
        type_b_points AS (
          SELECT
            q.ward_no, q.ward_name, q.uid, b.stop_time AS reading_time,
            b.water_level_stop_ft AS water_level_ft, b.water_level_stop_ft AS on_level,
            b.water_level_start_ft AS off_level,
            COALESCE(b.session_duration_min, EXTRACT(EPOCH FROM (b.stop_time - b.start_time)) / 60) / 60 AS runtime_hours
          FROM uploaded_type_b_sessions b
          JOIN good_sensors q ON q.uid = b.uid
          WHERE b.water_level_stop_ft IS NOT NULL
        ),
        kh_points AS (
          SELECT
            q.ward_no, q.ward_name, q.uid, w.time AS reading_time,
            COALESCE(w.water_level, w.on_level, w.off_level) AS water_level_ft,
            w.on_level, w.off_level, NULL::double precision AS runtime_hours
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
          SELECT ward_no, SUM(rainfall_mm) AS recent_90_day_rainfall_mm
          FROM ward_daily_rainfall
          WHERE date >= CURRENT_DATE - INTERVAL '90 days' AND source = 'CHIRPS'
          GROUP BY ward_no
        )
        SELECT gw.*, recent_rainfall.recent_90_day_rainfall_mm
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

    const fallback = await cachedFallback(request);
    if (fallback) {
      fallback.headers.set("x-dashboard-cache-fallback-reason", "runtime-error");
      return fallback;
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
}
