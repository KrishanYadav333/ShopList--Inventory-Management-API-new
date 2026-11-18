-- Owner-console extras for a locally seeded ShopList (see docs/DEMO.md). The nightly and hourly jobs make these in a real
-- deployment; a local server does not run them on demand, so this fills them in for screenshots.
-- Run with: npx wrangler d1 execute shoplist-control --local --file apps/api/scripts/demo-extras.sql

-- Make the demo businesses older than two weeks, so health scores show instead of "New".
UPDATE organizations SET created_at = datetime('now','-45 days') WHERE name = 'Willow & Pine Home Store';
UPDATE organizations SET created_at = datetime('now','-30 days') WHERE name = 'Harbor Coffee Roasters';
UPDATE organizations SET created_at = datetime('now','-21 days') WHERE name = 'Northside Bike Works';

INSERT OR REPLACE INTO org_health(org_id, day, score, label, parts) SELECT id, date('now'), 92, 'healthy', '{"activity":40,"adminSignIn":20,"backups":20,"headroom":12}' FROM organizations WHERE name = 'Willow & Pine Home Store';
INSERT OR REPLACE INTO org_health(org_id, day, score, label, parts) SELECT id, date('now'), 58, 'watch', '{"activity":30,"adminSignIn":10,"backups":20,"headroom":0}' FROM organizations WHERE name = 'Harbor Coffee Roasters';
INSERT OR REPLACE INTO org_health(org_id, day, score, label, parts) SELECT id, date('now'), 34, 'at_risk', '{"activity":15,"adminSignIn":0,"backups":10,"headroom":9}' FROM organizations WHERE name = 'Northside Bike Works';

INSERT INTO cron_runs(id, job, hour_utc, started_at, finished_at, ok, error, detail) VALUES
 ('run_d1','usage',3,datetime('now','-12 minutes'),datetime('now','-12 minutes'),1,NULL,'{}'),
 ('run_d2','digests',3,datetime('now','-12 minutes'),datetime('now','-12 minutes'),1,NULL,'{}'),
 ('run_d3','security-alerts',3,datetime('now','-12 minutes'),datetime('now','-12 minutes'),1,NULL,'{"created":1,"updated":0}'),
 ('run_d4','count-reminders',3,datetime('now','-9 hours'),datetime('now','-9 hours'),1,NULL,'{}'),
 ('run_d5','backups',3,datetime('now','-9 hours'),datetime('now','-9 hours'),1,NULL,'{"ok":3,"failed":0}'),
 ('run_d6','health',3,datetime('now','-9 hours'),datetime('now','-9 hours'),1,NULL,'{"scored":3}'),
 ('run_d7','purge',3,datetime('now','-9 hours'),datetime('now','-9 hours'),1,NULL,NULL),
 ('run_d8','retention',3,datetime('now','-9 hours'),datetime('now','-9 hours'),1,NULL,NULL),
 ('run_d9','prune',3,datetime('now','-9 hours'),datetime('now','-9 hours'),1,NULL,NULL);

INSERT INTO backup_runs(org_id, day, ok, size_bytes, parts, row_count, created_at)
  SELECT id, date('now'), 1, 184320, 1, 2140, datetime('now','-9 hours') FROM organizations WHERE name IN ('Willow & Pine Home Store','Harbor Coffee Roasters','Northside Bike Works');

INSERT INTO security_alerts(id, kind, severity, subject, dedupe_key, count, detail, first_at, last_at, state, updated_at) VALUES
 ('sal_demo1','repeated_refusals','medium','a1b2c3d4e5f6','demo1',7,NULL,datetime('now','-3 hours'),datetime('now','-40 minutes'),'open',datetime('now','-40 minutes')),
 ('sal_demo2','admin_new_country','medium','demo|DE','demo2',1,'{"country":"DE"}',datetime('now','-2 days'),datetime('now','-2 days'),'investigating',datetime('now','-1 days'));
