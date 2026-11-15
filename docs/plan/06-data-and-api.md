# 06 · Data and API reference

Everything the plan adds, in one place. Feature files explain *why*; this file lists *what*.

Rules for every change:
- **Additive only.** New tables and nullable or defaulted columns. Old code keeps working after a
  migration runs, so a migration can be applied before the deploy that uses it.
- **D1 migrations** live in `apps/api/migrations/control/` and are applied with
  `wrangler d1 migrations apply` before deploying.
- **Durable Object migrations** are appended steps in `inventory-do.ts` (current last step: 4). Each
  runs once per business, the first time that business's object wakes up after the deploy.
- Role CHECK changes rebuild the table (the 0005 pattern), because SQLite cannot alter a CHECK.

## 1. D1 (control plane) migrations

| # | Feature | Change |
|---|---|---|
| 0006 | F2 | `invitations`: add `id TEXT UNIQUE`, `created_at TEXT`, `revoked_at TEXT`; backfill `id`, `created_at` |
| 0007 | F3, F9 | `memberships`: add `deactivated_at TEXT`, `location_ids TEXT` (JSON or NULL); `invitations`: add `location_ids TEXT` |
| 0008 | F8, F20, F27 | `organizations`: add `settings TEXT NOT NULL DEFAULT '{}'`, `plan_id TEXT NOT NULL DEFAULT 'free'`, `plan_overrides TEXT`, `delete_after TEXT` |
| 0009 | F17 | Rebuild `memberships` and `invitations` with `accountant` in the role CHECK |
| 0010 | F11 | `notifications`, `notification_prefs` |
| 0011 | F20 | `plans` (seeded with free, standard) |
| 0012 | F22 | `auth_events` |
| 0013 | F19 | `support_grants` |
| 0014 | F24, F25 | `share_links(token_hash PK, org_id, kind, ref_id, created_by, created_at, expires_at, revoked_at)` |
| 0015 | F28 | `announcements`, `maintenance(scope, org_id, on_since, by)` |

New D1 tables in full:

```sql
CREATE TABLE notifications (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL, link TEXT, payload TEXT,
  created_at TEXT NOT NULL, read_at TEXT
);
CREATE INDEX notifications_user ON notifications(user_id, created_at DESC);
CREATE INDEX notifications_unread ON notifications(user_id) WHERE read_at IS NULL;

CREATE TABLE notification_prefs (
  user_id TEXT NOT NULL, org_id TEXT NOT NULL, kind TEXT NOT NULL,
  in_app INTEGER NOT NULL DEFAULT 1, email INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, org_id, kind)
);

CREATE TABLE plans (id TEXT PRIMARY KEY, name TEXT NOT NULL, limits TEXT NOT NULL, features TEXT NOT NULL);

CREATE TABLE auth_events (
  id TEXT PRIMARY KEY, created_at TEXT NOT NULL, kind TEXT NOT NULL, door TEXT,
  user_id TEXT, email_hash TEXT, country TEXT, browser TEXT, reason TEXT
);
CREATE INDEX auth_events_time ON auth_events(created_at DESC);
CREATE INDEX auth_events_user ON auth_events(user_id, created_at DESC);

CREATE TABLE support_grants (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  granted_by TEXT NOT NULL REFERENCES users(id), note TEXT, include_customers INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, expires_at TEXT NOT NULL, ended_at TEXT
);
```

## 2. Durable Object (per business) migrations

| Step | Feature | Change |
|---|---|---|
| 5 | F8 | `settings` copy in `meta` (key `settings`), refreshed on change |
| 6 | F10 | `approval_requests` |
| 7 | F12 | `daily_stats` + backfill from `stock_movements` and shipped orders |
| 8 | F13 | `suppliers`, `purchase_orders`, `po_lines`; products: `supplier_id`, `supplier_sku`, `supplier_price_minor`, `on_order INTEGER NOT NULL DEFAULT 0`; movements: `ref_type`, `ref_id` |
| 9 | F15 | `count_tasks`, `count_task_lines` |
| 10 | F16 | `customers`; orders: `customer_id`, `subtotal_minor`, `tax_minor`, `total_minor`; order_lines: `tax_rate_bp`; backfill customers from existing orders |

Key tables:

```sql
CREATE TABLE approval_requests (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL, summary TEXT NOT NULL,
  requested_by TEXT NOT NULL, state TEXT NOT NULL CHECK (state IN
    ('pending','approved','applied','rejected','withdrawn','expired','failed')),
  decided_by TEXT, note TEXT, result_ref TEXT,
  created_at TEXT NOT NULL, decided_at TEXT, expires_at TEXT NOT NULL
);
CREATE INDEX approvals_state ON approval_requests(state, created_at DESC);

CREATE TABLE daily_stats (
  day TEXT NOT NULL, product_id TEXT NOT NULL, location_id TEXT NOT NULL,
  sold_qty INTEGER NOT NULL DEFAULT 0, sold_minor INTEGER NOT NULL DEFAULT 0, tax_minor INTEGER NOT NULL DEFAULT 0,
  received_qty INTEGER NOT NULL DEFAULT 0, returned_qty INTEGER NOT NULL DEFAULT 0,
  adjusted_qty INTEGER NOT NULL DEFAULT 0, damaged_qty INTEGER NOT NULL DEFAULT 0,
  count_delta INTEGER NOT NULL DEFAULT 0, transfer_in INTEGER NOT NULL DEFAULT 0, transfer_out INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, product_id, location_id)
);

CREATE TABLE suppliers (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT, phone TEXT, lead_time_days INTEGER,
  note TEXT, created_at TEXT NOT NULL, archived_at TEXT
);
CREATE TABLE purchase_orders (
  id TEXT PRIMARY KEY, number TEXT NOT NULL UNIQUE, supplier_id TEXT NOT NULL REFERENCES suppliers(id),
  location_id TEXT NOT NULL, state TEXT NOT NULL CHECK (state IN
    ('draft','sent','partially_received','received','cancelled','closed')),
  expected_at TEXT, note TEXT, created_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE po_lines (
  id TEXT PRIMARY KEY, po_id TEXT NOT NULL REFERENCES purchase_orders(id), product_id TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0), received INTEGER NOT NULL DEFAULT 0,
  unit_cost_minor INTEGER NOT NULL
);

CREATE TABLE count_tasks (
  id TEXT PRIMARY KEY, location_id TEXT NOT NULL, scope TEXT NOT NULL, blind INTEGER NOT NULL DEFAULT 1,
  assigned_to TEXT, due_at TEXT, state TEXT NOT NULL CHECK (state IN ('open','submitted','cancelled')),
  created_by TEXT NOT NULL, created_at TEXT NOT NULL, submitted_at TEXT
);
CREATE TABLE count_task_lines (
  task_id TEXT NOT NULL, product_id TEXT NOT NULL, counted INTEGER, expected INTEGER,
  PRIMARY KEY (task_id, product_id)
);

CREATE TABLE customers (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT, phone TEXT, address TEXT, tax_id TEXT,
  note TEXT, created_at TEXT NOT NULL, archived_at TEXT
);
CREATE UNIQUE INDEX customers_email ON customers(email COLLATE NOCASE) WHERE email IS NOT NULL;
```

New invariants (checked by `verifyIntegrity`, like I1, I3, I6 today):
- **I7** `products.on_order` = Σ (`po_lines.quantity − received`) over POs in `sent` or `partially_received`.
- **I8** `daily_stats` totals per product = the same totals computed from the ledger.
- **I9** `orders.total_minor` = `subtotal_minor + tax_minor` (exclusive mode) and line sums match.

## 3. Shared code (`packages/shared`)

- `ROLES` + `accountant`; `PERMISSIONS` list and `ROLE_PERMISSIONS` per [01-model.md](01-model.md).
- `orgSettings` Zod schema (F8); `approvalRule` schemas (F10); `purchaseOrderInput`, `receiveInput`
  (F13); `countTaskInput` (F15); `customerInput`, tax helpers with tests (F16); report query schema (F12).
- `shapeProduct`, `shapeOrder` helpers live in the API, not shared, so the browser never decides.

## 4. Endpoints added

`P` = permission. All org routes are under `/api/v1/orgs/:orgId`.

| Method | Path | P | Feature |
|---|---|---|---|
| POST | `/admin/orgs` | super | F1 |
| POST | `/admin/orgs/:id/resend-invitation` | super | F1 |
| GET | `/admin/orgs/:id` | super | F6 |
| POST | `/admin/orgs/:id/transfer-admin` | super | F3 |
| GET | `/admin/users/:id` | super | F6 |
| POST | `/admin/users/:id/sign-out` | super | F6 |
| GET, PATCH | `/admin/plans` | super | F20 |
| PATCH | `/admin/orgs/:id/plan` | super | F20 |
| GET | `/admin/usage` | super | F21 |
| GET | `/admin/security` | super | F22 |
| GET | `/admin/support` | super | F19 |
| GET, POST, DELETE | `/admin/announcements`, `/admin/maintenance` | super | F28 |
| GET | `/invitations` | team:manage | F2 |
| POST | `/invitations/:id/resend` | team:manage | F2 |
| DELETE | `/invitations/:id` | team:manage | F2 |
| POST | `/members/:userId/deactivate`, `/reactivate` | team:manage | F3 |
| POST | `/admin-handover` | team:manage | F3 |
| PATCH | `/members/:userId` (`locationIds`) | team:manage | F9 |
| GET | `/settings` | inventory:read | F8 |
| PATCH | `/settings` | settings:manage | F8 |
| GET | `/plan` | settings:manage | F20 |
| GET | `/approvals` | inventory:read (own) / approvals:decide (all) | F10 |
| POST | `/approvals/:id/approve`, `/reject` | approvals:decide | F10 |
| POST | `/approvals/:id/withdraw` | requester | F10 |
| GET | `/reports/:name` | reports:read | F12 |
| GET, POST, PATCH | `/suppliers[/:id]` | inventory:read / purchasing:write | F13 |
| GET, POST, PATCH | `/purchase-orders[/:id]` | inventory:read / purchasing:write | F13 |
| POST | `/purchase-orders/:id/send`, `/cancel`, `/close` | purchasing:write | F13 |
| POST | `/purchase-orders/:id/receive` | stock:write | F13 |
| GET | `/purchasing/reorder` | purchasing:write | F14 |
| POST | `/purchasing/reorder/draft` | purchasing:write | F14 |
| GET, POST | `/count-tasks[/:id]` | inventory:read / counts:assign | F15 |
| POST | `/count-tasks/:id/lines`, `/submit` | stock:write (assignee) | F15 |
| POST | `/count-tasks/:id/cancel` | counts:assign | F15 |
| GET, POST, PATCH | `/customers[/:id]` | customers:read / orders:write | F16 |
| GET | `/orders/:id/document` | orders:write or customers:read | F16 |
| POST, DELETE | `/orders/:id/share` | orders:write | F24 |
| POST, DELETE | `/purchase-orders/:id/share` | purchasing:write | F25 |
| POST, GET, DELETE | `/support-grants[/:id]` | settings:manage | F19 |
| POST | `/restore` | settings:manage | F26 |
| GET | `/me/notifications`, `/me/notifications/unread-count` | user | F11 |
| POST | `/me/notifications/read` | user | F11 |
| GET, PATCH | `/me/notification-preferences` | user | F11 |
| GET | `/me/security-events` | user | F22 |
| GET | `/s/o/:token`, `/s/po/:token` (public pages) | public | F24, F25 |
| POST | `/s/po/:token/confirm`, `/dispatched` | public, rate-limited | F25 |

## 5. Screens added

| Screen | Who | Feature |
|---|---|---|
| Platform → Onboard a business; Business detail; User detail | Developer | F1, F6 |
| Platform → Plans, Usage, Security, Support, Announcements | Developer | F19–F22, F28 |
| Settings → Team (members + pending invitations, deactivate, locations, hand over) | Admin | F2, F3, F9 |
| Settings → Business (identity, money, time, numbering, stock, approvals) | Admin | F8, F10 |
| Settings → Plan (usage bars) | Admin | F20 |
| Settings → Support access | Admin | F19 |
| Settings → Notifications, Security | Everyone | F11, F22 |
| Approvals (queue / my requests) | Deciders / requesters | F10 |
| Reports | Accountant, manager, admin | F12 |
| Purchasing → Suppliers, Purchase orders, Reorder | Manager, admin; stock keeper receives | F13, F14 |
| Count tasks (assign / my tasks) | Manager / stock keeper | F15 |
| Customers; Order → Print invoice / receipt | Sales, manager, admin | F16 |
| Notification bell panel | Everyone | F11 |
| Public order status, public PO page | External | F24, F25 |

All new screens follow the existing dashboard style (`dashboard.css` unchanged, additions in
`app.css`), work at 390 px wide, and pass axe with zero serious or critical issues.
