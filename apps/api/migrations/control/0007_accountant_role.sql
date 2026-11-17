-- Adds the accountant role (read-only, with costs and the activity log). SQLite cannot alter a CHECK, so rebuild both tables.
CREATE TABLE memberships_new (
  org_id          TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role            TEXT NOT NULL CHECK (role IN ('admin', 'manager', 'sales', 'stock', 'accountant', 'viewer')),
  created_at      TEXT NOT NULL,
  deactivated_at  TEXT,
  PRIMARY KEY (org_id, user_id)
);
INSERT INTO memberships_new SELECT org_id, user_id, role, created_at, deactivated_at FROM memberships;
DROP TABLE memberships;
ALTER TABLE memberships_new RENAME TO memberships;
CREATE INDEX memberships_user ON memberships(user_id);

CREATE TABLE invitations_new (
  token_hash   TEXT PRIMARY KEY,
  org_id       TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email        TEXT NOT NULL COLLATE NOCASE,
  role         TEXT NOT NULL CHECK (role IN ('admin', 'manager', 'sales', 'stock', 'accountant', 'viewer')),
  invited_by   TEXT NOT NULL REFERENCES users(id),
  expires_at   TEXT NOT NULL,
  accepted_at  TEXT,
  id           TEXT,
  created_at   TEXT,
  revoked_at   TEXT
);
INSERT INTO invitations_new SELECT token_hash, org_id, email, role, invited_by, expires_at, accepted_at, id, created_at, revoked_at FROM invitations;
DROP TABLE invitations;
ALTER TABLE invitations_new RENAME TO invitations;
CREATE INDEX invitations_org ON invitations(org_id);
CREATE UNIQUE INDEX invitations_id ON invitations(id);
