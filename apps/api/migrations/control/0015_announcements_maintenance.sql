-- F28: notices from the owner, and a switch that stops writes while keeping reads.
CREATE TABLE announcements (
  id          TEXT PRIMARY KEY,
  message     TEXT NOT NULL,
  severity    TEXT NOT NULL CHECK (severity IN ('info', 'warning')),
  audience    TEXT NOT NULL CHECK (audience IN ('everyone', 'admins', 'org')),
  org_id      TEXT,
  starts_at   TEXT NOT NULL,
  ends_at     TEXT,
  created_at  TEXT NOT NULL,
  ended_at    TEXT
);
CREATE INDEX announcements_live ON announcements(starts_at) WHERE ended_at IS NULL;

CREATE TABLE maintenance (
  id          TEXT PRIMARY KEY,
  org_id      TEXT,              -- NULL = the whole platform
  message     TEXT NOT NULL,
  started_at  TEXT NOT NULL,
  ended_at    TEXT
);
CREATE INDEX maintenance_open ON maintenance(org_id) WHERE ended_at IS NULL;
