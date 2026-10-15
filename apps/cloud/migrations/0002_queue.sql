-- Phase 4: assisted job queue. Times are epoch milliseconds.

-- Sliced .gcode.3mf files uploaded for the queue, stored in R2 under r2_key and identified by MD5.
CREATE TABLE files (
  md5 TEXT PRIMARY KEY,
  filename TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  size INTEGER NOT NULL,
  printer_model_id TEXT,
  -- JSON array of plate summaries parsed in the browser (filaments, parts, grams, time).
  plates_json TEXT NOT NULL,
  uploaded_by TEXT NOT NULL,
  uploaded_at INTEGER NOT NULL
);

CREATE TABLE queue_items (
  id TEXT PRIMARY KEY,
  file_md5 TEXT NOT NULL REFERENCES files(md5),
  plate_index INTEGER NOT NULL,
  title TEXT NOT NULL,
  -- Number of times the plate should be printed; a finished run below this count re-queues the item.
  quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity >= 1),
  completed INTEGER NOT NULL DEFAULT 0,
  -- Higher runs first.
  priority INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'assigned', 'dispatched', 'printing', 'done', 'failed', 'cancelled')),
  assigned_printer TEXT REFERENCES printers(serial),
  -- The job of the current (or last) run, linked when the printer reports it started.
  job_id TEXT REFERENCES jobs(id),
  dispatched_at INTEGER,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX queue_items_status ON queue_items (status, priority DESC, created_at);
CREATE INDEX queue_items_dispatched ON queue_items (assigned_printer, status);
CREATE INDEX queue_items_job ON queue_items (job_id);
CREATE INDEX jobs_queue_item ON jobs (queue_item_id);
