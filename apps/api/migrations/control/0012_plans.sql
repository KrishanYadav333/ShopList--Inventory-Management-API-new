-- F20: plans, limits and feature switches. A missing limit means unlimited.
CREATE TABLE plans (
  id        TEXT PRIMARY KEY,
  name      TEXT NOT NULL,
  limits    TEXT NOT NULL,
  features  TEXT NOT NULL
);
INSERT INTO plans(id, name, limits, features) VALUES
  ('free', 'Free', '{"products":2000,"members":5,"locations":2,"apiKeys":2,"webhooks":2,"ordersPerMonth":1000,"importsPerDay":10}', '{"orders":true,"purchasing":true,"approvals":true,"reports":true,"apiKeys":true,"webhooks":true,"import":true,"supportAccess":true}'),
  ('standard', 'Standard', '{"products":20000,"members":25,"locations":10,"apiKeys":10,"webhooks":10,"ordersPerMonth":20000,"importsPerDay":50}', '{"orders":true,"purchasing":true,"approvals":true,"reports":true,"apiKeys":true,"webhooks":true,"import":true,"supportAccess":true}'),
  ('custom', 'Custom', '{}', '{"orders":true,"purchasing":true,"approvals":true,"reports":true,"apiKeys":true,"webhooks":true,"import":true,"supportAccess":true}');
ALTER TABLE organizations ADD COLUMN plan_id TEXT NOT NULL DEFAULT 'free';
ALTER TABLE organizations ADD COLUMN plan_overrides TEXT;
-- Businesses that exist today keep working as before: they start on Standard, not Free.
UPDATE organizations SET plan_id = 'standard';
