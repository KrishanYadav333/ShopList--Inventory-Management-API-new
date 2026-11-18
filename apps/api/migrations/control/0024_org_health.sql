-- O3: one row per business per day with the score and the four parts that add up to it. Counts only.
CREATE TABLE org_health (
  org_id  TEXT NOT NULL,
  day     TEXT NOT NULL,
  score   INTEGER NOT NULL,
  label   TEXT NOT NULL CHECK (label IN ('healthy', 'watch', 'at_risk')),
  parts   TEXT NOT NULL,
  PRIMARY KEY (org_id, day)
);
CREATE INDEX org_health_day ON org_health(day);
