-- Platform administration: an audit trail of super-admin actions, and org suspension.
CREATE TABLE platform_audit (
  id          TEXT PRIMARY KEY,
  actor       TEXT NOT NULL,
  action      TEXT NOT NULL,
  target      TEXT,
  detail      TEXT,
  request_id  TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX platform_audit_created ON platform_audit(created_at DESC, id DESC);

-- Distinct from deleted_at (the owner deleted it): suspended_at is set by the super admin.
ALTER TABLE organizations ADD COLUMN suspended_at TEXT;
