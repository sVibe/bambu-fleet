-- Bambu Fleet Dashboard: initial schema. Times are epoch milliseconds.

CREATE TABLE users (
  email TEXT PRIMARY KEY,
  name TEXT,
  role TEXT NOT NULL CHECK (role IN ('viewer', 'operator', 'admin')),
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER
);

CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  created_by TEXT,
  last_seen_at INTEGER,
  version TEXT,
  revoked_at INTEGER
);

CREATE TABLE printers (
  serial TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  model TEXT,
  agent_id TEXT REFERENCES agents(id),
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER,
  archived INTEGER NOT NULL DEFAULT 0
);

-- Ids of applied agent events, so redelivered events are ignored.
CREATE TABLE ingest_events (
  id TEXT PRIMARY KEY,
  agent_id TEXT,
  type TEXT NOT NULL,
  received_at INTEGER NOT NULL
);

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  printer_serial TEXT NOT NULL REFERENCES printers(serial),
  source TEXT NOT NULL DEFAULT 'mqtt' CHECK (source IN ('mqtt', 'cloud')),
  task_id TEXT,
  subtask_id TEXT,
  cloud_task_id TEXT UNIQUE,
  name TEXT NOT NULL,
  gcode_file TEXT,
  plate_index INTEGER,
  status TEXT NOT NULL CHECK (status IN ('printing', 'finished', 'failed', 'cancelled')),
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  duration_s INTEGER,
  progress_at_end REAL,
  layer_at_end INTEGER,
  total_layers INTEGER,
  -- Slicer estimate for the whole plate.
  est_weight_g REAL,
  est_length_m REAL,
  est_time_s INTEGER,
  -- Estimated grams actually consumed (less than est_weight_g for stopped jobs).
  actual_weight_g REAL,
  waste_g REAL,
  attribution TEXT CHECK (attribution IN ('gcode', 'even', 'none')),
  file_md5 TEXT,
  file_name TEXT,
  printer_model_id TEXT,
  thumb_key TEXT,
  -- JSON array: cumulative extrusion fraction at the end of each layer.
  layer_curve TEXT,
  error_code INTEGER,
  -- JSON array of identify_ids skipped during the print.
  skipped_objects TEXT,
  -- JSON: AMS trays at job start.
  ams_snapshot TEXT,
  queue_item_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX jobs_started ON jobs (started_at DESC, id DESC);
CREATE INDEX jobs_printer ON jobs (printer_serial, started_at DESC);
CREATE INDEX jobs_status ON jobs (status, started_at DESC);
CREATE INDEX jobs_task ON jobs (printer_serial, task_id);

CREATE TABLE job_filaments (
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL,
  tray_info_idx TEXT,
  material TEXT,
  color TEXT,
  ams_id INTEGER,
  slot_id INTEGER,
  weight_g REAL,
  length_m REAL,
  waste_g REAL,
  PRIMARY KEY (job_id, idx)
);
CREATE INDEX job_filaments_material ON job_filaments (material);

-- Catalog of parts; object names from jobs are grouped by normalized_name.
CREATE TABLE parts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL UNIQUE,
  notes TEXT,
  -- When an operator merges parts, the old entry points at the surviving one.
  merged_into TEXT REFERENCES parts(id),
  created_at INTEGER NOT NULL
);

CREATE TABLE job_parts (
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  identify_id TEXT NOT NULL,
  part_id TEXT NOT NULL REFERENCES parts(id),
  object_name TEXT NOT NULL,
  skipped INTEGER NOT NULL DEFAULT 0,
  weight_g REAL,
  waste_share_g REAL,
  -- JSON: grams per slicer filament id.
  per_filament TEXT,
  PRIMARY KEY (job_id, identify_id)
);
CREATE INDEX job_parts_part ON job_parts (part_id);

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  entity TEXT,
  entity_id TEXT,
  details TEXT
);
CREATE INDEX audit_log_at ON audit_log (at DESC);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
