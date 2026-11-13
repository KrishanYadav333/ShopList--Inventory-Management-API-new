-- Allow Clerk as an identity provider. SQLite cannot alter a CHECK constraint, so rebuild the table.
CREATE TABLE oauth_accounts_new (
  provider          TEXT NOT NULL CHECK (provider IN ('github', 'google', 'clerk')),
  provider_user_id  TEXT NOT NULL,
  user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (provider, provider_user_id)
);
INSERT INTO oauth_accounts_new SELECT provider, provider_user_id, user_id FROM oauth_accounts;
DROP TABLE oauth_accounts;
ALTER TABLE oauth_accounts_new RENAME TO oauth_accounts;
CREATE INDEX oauth_accounts_user ON oauth_accounts(user_id);

-- Remember which door a session came through. Super-admin power is only valid for sessions that came
-- through the owner's door (github), never through the customer door (clerk).
ALTER TABLE sessions ADD COLUMN provider TEXT NOT NULL DEFAULT 'unknown';
