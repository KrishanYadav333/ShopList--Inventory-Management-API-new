-- O2: sign-in events that deserve a person's attention, with a state and a note.
-- `subject` is a user id or a hash, never a raw email. `dedupe_key` makes one noisy source one alert per day.
CREATE TABLE security_alerts (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,
  severity    TEXT NOT NULL CHECK (severity IN ('high', 'medium')),
  subject     TEXT,
  dedupe_key  TEXT NOT NULL UNIQUE,
  count       INTEGER NOT NULL DEFAULT 1,
  detail      TEXT,
  first_at    TEXT NOT NULL,
  last_at     TEXT NOT NULL,
  state       TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'investigating', 'resolved', 'dismissed')),
  note        TEXT,
  updated_at  TEXT NOT NULL,
  updated_by  TEXT
);
CREATE INDEX security_alerts_state ON security_alerts(state, last_at DESC);
