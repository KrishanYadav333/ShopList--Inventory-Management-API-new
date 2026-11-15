-- Invitations get a public id, a created time and can be revoked. Members can be deactivated without losing history.
ALTER TABLE invitations ADD COLUMN id TEXT;
ALTER TABLE invitations ADD COLUMN created_at TEXT;
ALTER TABLE invitations ADD COLUMN revoked_at TEXT;
UPDATE invitations SET id = 'inv_' || lower(hex(randomblob(8))), created_at = COALESCE(created_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
CREATE UNIQUE INDEX invitations_id ON invitations(id);
ALTER TABLE memberships ADD COLUMN deactivated_at TEXT;
