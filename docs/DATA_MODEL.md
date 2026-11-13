# Data Model

Two stores. The **control plane** (D1) knows who people are and which organizations they belong to. Each **data plane** object (one SQLite-backed Durable Object per organization) knows everything about that organization's inventory.

Conventions for both:

- Ids are prefixed random strings: `usr_`, `org_`, `prd_`, `loc_`, `mov_`, `rsv_`, followed by 22 base62 characters (about 131 bits of randomness).
- Timestamps are ISO 8601 UTC strings with milliseconds.
- Money is an **integer number of minor units** (cents) plus an ISO 4217 currency code. Never floating point.
- Quantities are integers. Fractional units (kg, metres) are stored in a declared base unit, such as grams.
- Every mutable row has a `version` integer for optimistic concurrency.
- Deletes are soft (`deleted_at`) for 30 days so they can be undone, then purged.

## Control plane (D1)

```sql
CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name          TEXT NOT NULL,
  avatar_url    TEXT,
  created_at    TEXT NOT NULL,
  disabled_at   TEXT
);

CREATE TABLE oauth_accounts (
  provider          TEXT NOT NULL CHECK (provider IN ('github', 'google')),
  provider_user_id  TEXT NOT NULL,
  user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (provider, provider_user_id)
);

CREATE TABLE passkeys (
  id            TEXT PRIMARY KEY,          -- credential id, base64url
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_key    BLOB NOT NULL,             -- COSE key
  sign_count    INTEGER NOT NULL DEFAULT 0,
  transports    TEXT,
  name          TEXT NOT NULL,             -- "MacBook Touch ID"
  created_at    TEXT NOT NULL,
  last_used_at  TEXT
);

CREATE TABLE sessions (
  token_hash    TEXT PRIMARY KEY,          -- SHA-256 of the cookie value; the raw token is never stored
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at    TEXT NOT NULL,
  expires_at    TEXT NOT NULL,             -- sliding, 30 days max, 12 hours idle
  last_seen_at  TEXT NOT NULL,
  user_agent    TEXT,
  ip_country    TEXT
);
CREATE INDEX sessions_user ON sessions(user_id);

CREATE TABLE organizations (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  slug          TEXT NOT NULL UNIQUE,
  currency      TEXT NOT NULL DEFAULT 'USD',
  created_at    TEXT NOT NULL,
  deleted_at    TEXT
);

CREATE TABLE memberships (
  org_id        TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role          TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'editor', 'viewer')),
  created_at    TEXT NOT NULL,
  PRIMARY KEY (org_id, user_id)
);
CREATE INDEX memberships_user ON memberships(user_id);

CREATE TABLE invitations (
  token_hash    TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email         TEXT NOT NULL COLLATE NOCASE,
  role          TEXT NOT NULL CHECK (role IN ('admin', 'editor', 'viewer')),
  invited_by    TEXT NOT NULL REFERENCES users(id),
  expires_at    TEXT NOT NULL,             -- 7 days
  accepted_at   TEXT
);

CREATE TABLE api_keys (
  id            TEXT PRIMARY KEY,          -- key_...
  org_id        TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  prefix        TEXT NOT NULL,             -- first 8 chars, shown in the UI
  secret_hash   TEXT NOT NULL UNIQUE,      -- SHA-256 of the full key
  scopes        TEXT NOT NULL,             -- JSON array, e.g. ["products:read","stock:write"]
  created_by    TEXT NOT NULL REFERENCES users(id),
  created_at    TEXT NOT NULL,
  last_used_at  TEXT,
  expires_at    TEXT,
  revoked_at    TEXT
);
```

API keys and session tokens are high-entropy random values, so a single SHA-256 is the correct storage hash. Slow hashes such as PBKDF2 are for low-entropy secrets like passwords, which ShopList does not have.

## Data plane (one Durable Object per organization)

```sql
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);  -- schema_version, change_counter, org_id

CREATE TABLE locations (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  code        TEXT NOT NULL UNIQUE,
  is_default  INTEGER NOT NULL DEFAULT 0,
  version     INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL,
  archived_at TEXT
);

CREATE TABLE products (
  id             TEXT PRIMARY KEY,
  sku            TEXT NOT NULL,
  name           TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  description    TEXT CHECK (length(description) <= 5000),
  barcode        TEXT,
  unit           TEXT NOT NULL DEFAULT 'each',
  price_minor    INTEGER NOT NULL CHECK (price_minor >= 0),
  cost_minor     INTEGER CHECK (cost_minor >= 0),
  reorder_point  INTEGER CHECK (reorder_point >= 0),
  image_key      TEXT,                     -- R2 object key
  tags           TEXT NOT NULL DEFAULT '[]',
  version        INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  deleted_at     TEXT
);
CREATE UNIQUE INDEX products_sku ON products(sku) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX products_barcode ON products(barcode) WHERE barcode IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX products_updated ON products(updated_at, id);
CREATE INDEX products_name ON products(name COLLATE NOCASE, id);

CREATE VIRTUAL TABLE products_fts USING fts5(
  name, sku, barcode, description,
  content='products', content_rowid='rowid', tokenize='unicode61 remove_diacritics 2'
);

CREATE TABLE stock_levels (
  product_id   TEXT NOT NULL REFERENCES products(id),
  location_id  TEXT NOT NULL REFERENCES locations(id),
  on_hand      INTEGER NOT NULL DEFAULT 0,
  reserved     INTEGER NOT NULL DEFAULT 0 CHECK (reserved >= 0),
  version      INTEGER NOT NULL DEFAULT 1,
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (product_id, location_id),
  CHECK (reserved <= on_hand OR on_hand < 0)
);
CREATE INDEX stock_low ON stock_levels(location_id, on_hand);

CREATE TABLE stock_movements (
  id           TEXT PRIMARY KEY,
  product_id   TEXT NOT NULL,
  location_id  TEXT NOT NULL,
  delta        INTEGER NOT NULL CHECK (delta <> 0),
  reason       TEXT NOT NULL CHECK (reason IN
                 ('receive','sale','return','adjust','count','transfer_in','transfer_out','damage','import')),
  reference    TEXT,                       -- order number, PO number, transfer id
  note         TEXT CHECK (length(note) <= 500),
  balance      INTEGER NOT NULL,           -- on_hand after this movement
  actor        TEXT NOT NULL,              -- usr_... or key_...
  created_at   TEXT NOT NULL
);
CREATE INDEX movements_product ON stock_movements(product_id, created_at DESC);
CREATE INDEX movements_created ON stock_movements(created_at DESC, id);

CREATE TABLE reservations (
  id           TEXT PRIMARY KEY,
  product_id   TEXT NOT NULL,
  location_id  TEXT NOT NULL,
  quantity     INTEGER NOT NULL CHECK (quantity > 0),
  reference    TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('held','committed','released','expired')),
  created_at   TEXT NOT NULL
);
CREATE INDEX reservations_expiry ON reservations(status, expires_at);

CREATE TABLE audit_log (
  id          TEXT PRIMARY KEY,
  actor       TEXT NOT NULL,
  action      TEXT NOT NULL,               -- product.update, member.invite, ...
  entity      TEXT NOT NULL,
  entity_id   TEXT NOT NULL,
  changes     TEXT,                        -- JSON diff {field: [before, after]}
  request_id  TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX audit_entity ON audit_log(entity, entity_id, created_at DESC);

CREATE TABLE idempotency_keys (
  key          TEXT PRIMARY KEY,
  actor        TEXT NOT NULL,
  request_hash TEXT NOT NULL,              -- SHA-256 of method + path + body
  status       INTEGER NOT NULL,
  response     TEXT NOT NULL,
  created_at   TEXT NOT NULL               -- purged after 24 hours
);

CREATE TABLE counters (
  name  TEXT PRIMARY KEY,                  -- products, low_stock, inventory_value_minor
  value INTEGER NOT NULL
);
```

## Invariants

These must hold after every transaction. Each one has an automated test.

| # | Invariant | Enforced by |
|---|---|---|
| I1 | `stock_levels.on_hand` equals the sum of `stock_movements.delta` for that product and location | Movements and level updates in one `transactionSync`; nightly verification job alerts on drift |
| I2 | `on_hand` never goes below zero unless the org enables "allow negative stock" | Conditional update `WHERE on_hand + :delta >= 0`; zero rows changed means 409 |
| I3 | `reserved` never exceeds `on_hand` | `CHECK` constraint plus the reservation code path |
| I4 | A live SKU is unique within an org | Partial unique index |
| I5 | Movements and audit entries are never updated or deleted | No code path does it; archive moves rows to R2 as a whole |
| I6 | `counters` match the true aggregate | Updated in the same transaction; nightly recount |
| I7 | A given idempotency key always returns the same response | Stored response replayed; different body with same key returns 422 |

## Why `counters` exist

D1 and Durable Object SQLite bill by **rows read**, and `SELECT COUNT(*)` reads every row. The dashboard's totals (product count, inventory value, low-stock count) are therefore maintained incrementally in `counters` inside the same transaction as the change. Reading the dashboard costs 3 rows, not the size of the catalogue.

## Migrations

- **Control plane:** numbered SQL files in `migrations/control/`, applied with `wrangler d1 migrations apply` in CI before the new code deploys. Every migration must be backward compatible with the currently deployed code (expand, then contract in a later release).
- **Data plane:** numbered SQL files compiled into the Worker. On its first request after a deploy, each `InventoryDO` compares `meta.schema_version` with the latest and applies the missing steps inside one transaction before serving. Same expand-then-contract rule.
- **Never** edit an applied migration. Add a new one.

## Retention

| Data | Kept | Then |
|---|---|---|
| Soft-deleted products | 30 days | Purged (movements remain) |
| Stock movements, audit log | 24 months in the object | Archived to R2 as JSON Lines, then removed |
| Idempotency keys | 24 hours | Deleted by cron |
| Expired sessions | 7 days after expiry | Deleted by cron |
| Backups | 30 nightly snapshots in R2 | Oldest deleted |
