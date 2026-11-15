-- Access levels by job instead of a single ladder.
--   admin   (was owner)   the client business owner, one per organization (soft guard in the API)
--   manager (was admin and editor)   runs day-to-day inventory, products, stock and orders
--   sales   new   works orders only
--   stock   new   moves stock only
--   viewer  unchanged
-- Neither table is referenced by a foreign key, so each can be rebuilt in place.
CREATE TABLE memberships_new (
  org_id      TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role        TEXT NOT NULL CHECK (role IN ('admin', 'manager', 'sales', 'stock', 'viewer')),
  created_at  TEXT NOT NULL,
  PRIMARY KEY (org_id, user_id)
);
INSERT INTO memberships_new SELECT org_id, user_id, CASE role WHEN 'owner' THEN 'admin' WHEN 'admin' THEN 'manager' WHEN 'editor' THEN 'manager' ELSE 'viewer' END, created_at FROM memberships;
DROP TABLE memberships;
ALTER TABLE memberships_new RENAME TO memberships;
CREATE INDEX memberships_user ON memberships(user_id);

CREATE TABLE invitations_new (
  token_hash   TEXT PRIMARY KEY,
  org_id       TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email        TEXT NOT NULL COLLATE NOCASE,
  role         TEXT NOT NULL CHECK (role IN ('admin', 'manager', 'sales', 'stock', 'viewer')),
  invited_by   TEXT NOT NULL REFERENCES users(id),
  expires_at   TEXT NOT NULL,
  accepted_at  TEXT
);
INSERT INTO invitations_new SELECT token_hash, org_id, email, CASE role WHEN 'admin' THEN 'manager' WHEN 'editor' THEN 'manager' ELSE 'viewer' END, invited_by, expires_at, accepted_at FROM invitations;
DROP TABLE invitations;
ALTER TABLE invitations_new RENAME TO invitations;
CREATE INDEX invitations_org ON invitations(org_id);
