CREATE TABLE notifications (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id      TEXT NOT NULL,
  kind        TEXT NOT NULL,
  title       TEXT NOT NULL,
  link        TEXT,
  created_at  TEXT NOT NULL,
  read_at     TEXT
);
CREATE INDEX notifications_user ON notifications(user_id, created_at DESC);
CREATE INDEX notifications_unread ON notifications(user_id) WHERE read_at IS NULL;

CREATE TABLE notification_prefs (
  user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id   TEXT NOT NULL,
  kind     TEXT NOT NULL,
  in_app   INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (user_id, org_id, kind)
);
