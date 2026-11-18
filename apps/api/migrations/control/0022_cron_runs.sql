-- O4: one row each time a housekeeping job finishes, so the owner can see that the hourly job is really running.
-- No secrets and no customer data: `error` is cut to 200 characters and `detail` holds counts only.
CREATE TABLE cron_runs (
  id           TEXT PRIMARY KEY,
  job          TEXT NOT NULL,
  hour_utc     INTEGER NOT NULL,
  started_at   TEXT NOT NULL,
  finished_at  TEXT NOT NULL,
  ok           INTEGER NOT NULL,
  error        TEXT,
  detail       TEXT
);
CREATE INDEX cron_runs_job ON cron_runs(job, started_at DESC);
