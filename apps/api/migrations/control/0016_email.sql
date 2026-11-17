-- F23: email. Per-person, per-kind choices (a missing row means the kind's default), and a daily send counter.
CREATE TABLE email_prefs (
  user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id   TEXT NOT NULL,
  kind     TEXT NOT NULL,
  email    INTEGER NOT NULL,
  PRIMARY KEY (user_id, org_id, kind)
);
CREATE TABLE email_counts (
  day    TEXT NOT NULL,
  scope  TEXT NOT NULL,   -- an organization id, or '_all' for the platform total
  n      INTEGER NOT NULL,
  PRIMARY KEY (day, scope)
);
