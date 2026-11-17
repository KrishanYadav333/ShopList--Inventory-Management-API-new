-- F24 and F25: links for people with no account. Only the SHA-256 of the token is stored.
CREATE TABLE share_links (
  token_hash  TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('order', 'po')),
  entity_id   TEXT NOT NULL,
  created_by  TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  revoked_at  TEXT
);
CREATE INDEX share_links_entity ON share_links(org_id, kind, entity_id);
