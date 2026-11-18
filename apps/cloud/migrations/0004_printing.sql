-- Label and document printing through PrintNode. Times are epoch milliseconds.

-- Part number printed on labels and encoded in their QR code; the part name is used when it's empty.
ALTER TABLE parts ADD COLUMN part_number TEXT;

-- Printers of the PrintNode account, refreshed from its API. The id is PrintNode's printer id.
CREATE TABLE print_printers (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  -- PrintNode's printer state, e.g. "online".
  state TEXT,
  -- The computer running the PrintNode Client the printer is attached to.
  computer_id INTEGER NOT NULL,
  computer_name TEXT NOT NULL,
  computer_state TEXT,
  -- JSON: PrintNode's capabilities (papers in tenths of a millimetre, dpis, bins…).
  capabilities TEXT,
  -- Set in the dashboard.
  alias TEXT,
  -- Paper name from capabilities to print labels on; chosen by matching the label size when empty.
  paper TEXT,
  rotate INTEGER NOT NULL DEFAULT 0 CHECK (rotate IN (0, 90, 180, 270)),
  -- Set when the printer no longer appears in the PrintNode account.
  removed_at INTEGER,
  synced_at INTEGER NOT NULL
);

-- Everything the dashboard sent to PrintNode, with the latest state PrintNode reported.
CREATE TABLE print_jobs (
  id TEXT PRIMARY KEY,
  printnode_id INTEGER UNIQUE,
  printer_id INTEGER NOT NULL,
  -- Which built-in template or label template was printed.
  template TEXT NOT NULL,
  -- What the label is about, e.g. ('part', <part id>).
  entity TEXT,
  entity_id TEXT,
  title TEXT NOT NULL,
  copies INTEGER NOT NULL DEFAULT 1,
  -- submitting and failed are the dashboard's own (sending, or PrintNode refused it); the rest are
  -- PrintNode's stable states: new, sent_to_client, done, error, expired.
  state TEXT NOT NULL,
  message TEXT,
  -- When PrintNode recorded the state, so late webhook deliveries can't move a job backwards.
  state_at INTEGER,
  requested_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX print_jobs_entity ON print_jobs (entity, entity_id, created_at DESC);
CREATE INDEX print_jobs_created ON print_jobs (created_at DESC);
CREATE INDEX print_jobs_open ON print_jobs (state, created_at);
