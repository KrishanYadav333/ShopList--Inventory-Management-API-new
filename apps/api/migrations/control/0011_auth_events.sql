-- F22: sign-in history. No IP addresses, no raw emails of people we do not know, no tokens.
CREATE TABLE auth_events (
  id          TEXT PRIMARY KEY,
  at          TEXT NOT NULL,
  kind        TEXT NOT NULL,
  user_id     TEXT,
  email_hash  TEXT,
  door        TEXT,
  country     TEXT,
  browser     TEXT,
  reason      TEXT
);
CREATE INDEX auth_events_at ON auth_events(at);
CREATE INDEX auth_events_user ON auth_events(user_id, at DESC);
CREATE INDEX auth_events_kind ON auth_events(kind, at);
