-- F29 (interim, in D1 until R2 is available): nightly gzip copies of each business, 30 days kept.
CREATE TABLE backups (
  org_id  TEXT NOT NULL,
  day     TEXT NOT NULL,
  part    INTEGER NOT NULL,
  data    BLOB NOT NULL,
  PRIMARY KEY (org_id, day, part)
);
CREATE TABLE backup_runs (
  org_id      TEXT NOT NULL,
  day         TEXT NOT NULL,
  ok          INTEGER NOT NULL,
  size_bytes  INTEGER NOT NULL DEFAULT 0,
  parts       INTEGER NOT NULL DEFAULT 0,
  row_count   INTEGER NOT NULL DEFAULT 0,
  error       TEXT,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (org_id, day)
);
CREATE INDEX backup_runs_day ON backup_runs(day);
