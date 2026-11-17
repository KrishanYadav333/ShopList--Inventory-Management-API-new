-- F19: a business lets the ShopList owner look (read-only) for a short, revocable window.
CREATE TABLE support_grants (
  id                 TEXT PRIMARY KEY,
  org_id             TEXT NOT NULL,
  granted_by         TEXT NOT NULL REFERENCES users(id),
  note               TEXT,
  include_customers  INTEGER NOT NULL DEFAULT 0,
  created_at         TEXT NOT NULL,
  expires_at         TEXT NOT NULL,
  ended_at           TEXT,
  views              INTEGER NOT NULL DEFAULT 0,
  first_view_at      TEXT,
  last_view_at       TEXT
);
CREATE INDEX support_grants_org ON support_grants(org_id, created_at DESC);
CREATE INDEX support_grants_open ON support_grants(expires_at) WHERE ended_at IS NULL;
