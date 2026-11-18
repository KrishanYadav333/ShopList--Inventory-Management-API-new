-- A1/A2: requests for access to a business, decided by its admin. Approving one creates a support grant.
-- `kind` and `reason_code` are for impersonation requests (a later step); plain access is kind 'support'.
CREATE TABLE access_requests (
  id                 TEXT PRIMARY KEY,
  org_id             TEXT NOT NULL,
  kind               TEXT NOT NULL DEFAULT 'support' CHECK (kind IN ('support', 'impersonate')),
  requested_by       TEXT NOT NULL,
  reason             TEXT NOT NULL,
  reason_code        TEXT,
  minutes            INTEGER NOT NULL,
  write              INTEGER NOT NULL DEFAULT 0,
  include_customers  INTEGER NOT NULL DEFAULT 0,
  state              TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'approved', 'declined', 'cancelled', 'expired')),
  decided_by         TEXT,
  decided_at         TEXT,
  grant_id           TEXT,
  created_at         TEXT NOT NULL,
  expires_at         TEXT NOT NULL
);
CREATE INDEX access_requests_org ON access_requests(org_id, created_at DESC);
CREATE INDEX access_requests_open ON access_requests(state, expires_at);
ALTER TABLE support_grants ADD COLUMN impersonate_user_id TEXT;
