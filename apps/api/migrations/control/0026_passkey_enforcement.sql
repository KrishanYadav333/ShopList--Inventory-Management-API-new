-- A3: passkeys required for the owner and business admins.
-- sessions.passkey_at: when this session last proved a passkey (a passkey sign-in counts).
-- users.passkey_grace_until: how long an admin without a passkey may still use the app once enforcement is on.
-- platform_settings: the on/off switch, changed from the owner console (no deploy needed).
ALTER TABLE sessions ADD COLUMN passkey_at TEXT;
ALTER TABLE users ADD COLUMN passkey_grace_until TEXT;
CREATE TABLE platform_settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  updated_by  TEXT
);
