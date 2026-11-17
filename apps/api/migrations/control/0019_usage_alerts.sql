-- F21: one alert per metric per day, so the owner is told once, not every hour.
CREATE TABLE usage_alerts (
  day     TEXT NOT NULL,
  metric  TEXT NOT NULL,
  PRIMARY KEY (day, metric)
);
