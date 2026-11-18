-- Automatic job labels per part: once `threshold` good pieces of the part have been printed, a job
-- label prints with the threshold as its quantity. Pieces over the threshold carry over to the next one.
CREATE TABLE part_auto_labels (
  part_id TEXT PRIMARY KEY REFERENCES parts(id),
  enabled INTEGER NOT NULL DEFAULT 0,
  threshold INTEGER NOT NULL CHECK (threshold >= 1),
  -- Good pieces counted since the last label.
  tally INTEGER NOT NULL DEFAULT 0,
  -- Labels printed so far; the next one gets number labels + 1.
  labels INTEGER NOT NULL DEFAULT 0,
  -- How many labels the last counted job completed. Set in the same statement that counts the job,
  -- so concurrent jobs can't both claim the same label.
  last_labels INTEGER NOT NULL DEFAULT 0,
  -- A job label template, or NULL for the default job label.
  template_id TEXT,
  -- A PrintNode printer, or NULL for the default label printer.
  printer_id INTEGER,
  updated_by TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- One row per automatic label: which part reached its threshold in which job.
CREATE TABLE part_label_runs (
  id TEXT PRIMARY KEY,
  part_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  -- The part's label number: 1 for its first automatic label.
  seq INTEGER NOT NULL,
  qty INTEGER NOT NULL,
  -- The print job, once one was sent; error says why there is none.
  print_job_id TEXT,
  error TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX part_label_runs_part ON part_label_runs (part_id, created_at DESC);

-- Set once a finished job's pieces were added to the tallies, so each job counts exactly once. The value
-- is a token unique to the counting run.
ALTER TABLE jobs ADD COLUMN labels_counted TEXT;

-- Jobs printed before automatic labels existed never count towards one.
UPDATE jobs SET labels_counted = 'before-auto-labels' WHERE status <> 'printing';
