const initializedTables = new Set();

export async function ensureUploadedTables(sql) {
  if (initializedTables.has("uploaded")) return;
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
  initializedTables.add("uploaded");
}

export async function ensureVendorTables(sql) {
  if (initializedTables.has("vendor")) return;
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
  initializedTables.add("vendor");
}

export async function ensureCompactUploadTable(sql) {
  if (initializedTables.has("compact_upload")) return;
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
  initializedTables.add("compact_upload");
}

export async function ensureSensorMetadataColumns(sql) {
  if (initializedTables.has("sensor_metadata_columns")) return;
  await sql`ALTER TABLE sensors ADD COLUMN IF NOT EXISTS motor_hp DOUBLE PRECISION NULL`;
  await sql`ALTER TABLE sensors ADD COLUMN IF NOT EXISTS borewell_depth DOUBLE PRECISION NULL`;
  await sql`ALTER TABLE sensors ADD COLUMN IF NOT EXISTS pump_name TEXT NULL`;
  initializedTables.add("sensor_metadata_columns");
}
