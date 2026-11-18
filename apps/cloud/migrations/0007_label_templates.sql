-- Label templates made in the label editor. The built-in part and job labels live in code and aren't
-- stored; settings print.default_template.part and .job name the template each kind prints by default.
CREATE TABLE label_templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  -- What it's filled from: 'part' (part page) or 'job' (job page and history).
  source TEXT NOT NULL CHECK (source IN ('part', 'job')),
  width_mm REAL NOT NULL,
  height_mm REAL NOT NULL,
  -- JSON array of elements, as in @fleet/labels' LabelTemplate.
  elements TEXT NOT NULL,
  -- Goes up with every save, so two people editing at once can't overwrite each other unseen.
  version INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  -- Deleted templates are kept so print history can still name them.
  deleted_at INTEGER
);
CREATE INDEX label_templates_source ON label_templates (source, deleted_at, name);
