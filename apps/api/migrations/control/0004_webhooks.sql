-- Outbound webhooks. The signing secret has to be readable to sign requests, so it is stored as-is
-- (D1 is encrypted at rest); it is shown to the user once and never returned by the API again.
CREATE TABLE webhooks (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  url         TEXT NOT NULL,
  events      TEXT NOT NULL,            -- JSON array of event types, or ["*"]
  secret      TEXT NOT NULL,
  active      INTEGER NOT NULL DEFAULT 1,
  created_by  TEXT NOT NULL REFERENCES users(id),
  created_at  TEXT NOT NULL
);
CREATE INDEX webhooks_org ON webhooks(org_id, active);

-- Only final outcomes are recorded (delivered, or failed after all retries); the newest 100 per webhook are kept.
CREATE TABLE webhook_deliveries (
  id           TEXT PRIMARY KEY,
  webhook_id   TEXT NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  event_id     TEXT NOT NULL,
  event_type   TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('delivered', 'failed')),
  http_status  INTEGER,
  attempts     INTEGER NOT NULL,
  created_at   TEXT NOT NULL
);
CREATE INDEX webhook_deliveries_hook ON webhook_deliveries(webhook_id, created_at DESC);
