# API v1

The machine-readable contract is generated from the Zod schemas and served at `GET /api/v1/openapi.json`, with interactive docs at `/api/docs`. This document explains the rules every endpoint follows.

## Base URL and versioning

```
https://<host>/api/v1
```

- Breaking changes require `/api/v2`. Adding optional fields or new endpoints is not breaking.
- Clients must ignore unknown response fields.
- A deprecated endpoint returns `Deprecation` and `Sunset` headers for at least 90 days before removal.

## Authentication

| Client | Credential | Header |
|---|---|---|
| Browser | Session cookie `__Host-sl_session` (HttpOnly, Secure, SameSite=Lax) | Sent automatically |
| Server integration | API key `sl_live_<random>` scoped to one org | `Authorization: Bearer sl_live_...` |

Browser requests that change data must also send `Origin` matching the app's host (browsers do this automatically). See [SECURITY.md](SECURITY.md).

## Resources are scoped to an organization

```
/api/v1/orgs/{orgId}/products
```

The server checks the caller's membership and role for `{orgId}` on every request. An org the caller does not belong to returns `404`, not `403`, so ids cannot be probed.

## Endpoints

### Session and account

| Method | Path | Purpose |
|---|---|---|
| GET | `/auth/oauth/github` | Start the owner's GitHub sign-in |
| GET | `/auth/oauth/github/callback` | Finish it; only the owner's account is accepted |
| POST | `/auth/clerk/session` | Exchange a Clerk session token for a ShopList session (customers) |
| POST | `/auth/passkeys/register/options` | Session. Start registering a passkey (WebAuthn creation options and a signed challenge token) |
| POST | `/auth/passkeys/register` | Session. Finish registering; verifies the attestation |
| GET | `/auth/passkeys` | Session. List your passkeys |
| DELETE | `/auth/passkeys/:id` | Session. Remove one of your passkeys |
| POST | `/auth/passkeys/login/options` | Public. Start a sign-in (discoverable credentials, no username) |
| POST | `/auth/passkeys/login` | Public. Verify the assertion and set the session cookie |
| POST | `/auth/logout` | End the current session |
| GET | `/me` | Current user, organizations and roles |
| GET / DELETE | `/me/sessions[/{id}]` | List or revoke own sessions |

### Platform administration (super admin only)

All answer 404 to everyone else (401 when signed out). None returns inventory data.

| Method | Path | Purpose |
|---|---|---|
| GET | `/admin/overview` | User, organization, suspended, disabled and active-session counts; sign-in mode |
| GET | `/admin/orgs` | Organizations with member counts and status (cursor paged) |
| GET | `/admin/users` | Accounts with organization counts, last seen and status (cursor paged) |
| POST | `/admin/users/{id}/disable` · `/enable` | Disable signs the user out immediately; you cannot disable yourself |
| POST | `/admin/orgs/{id}/suspend` · `/restore` | Suspended organizations vanish for their members |
| GET | `/admin/audit` | Every platform action with actor and request id |

### Organizations and members

| Method | Path | Role |
|---|---|---|
| POST | `/orgs` | Any signed-in user (becomes the organization's admin) |
| GET / PATCH / DELETE | `/orgs/{orgId}` | member / admin / admin |
| GET | `/orgs/{orgId}/members` | any member |
| PATCH / DELETE | `/orgs/{orgId}/members/{userId}` | admin |
| POST | `/orgs/{orgId}/invitations` | admin |
| POST | `/invitations/{token}/accept` | Invitee |
| GET / POST / DELETE | `/orgs/{orgId}/api-keys[/{id}]` | admin |

### Inventory

| Method | Path | Role | Notes |
|---|---|---|---|
| GET | `/orgs/{orgId}/products` | any member | Paged; `q`, `location`, `stock=low\|out\|in`, `tag`, `sort` |
| POST | `/orgs/{orgId}/products` | manager | Idempotency-Key required |
| GET | `/orgs/{orgId}/products/{id}` | any member | Returns `ETag` |
| PATCH | `/orgs/{orgId}/products/{id}` | manager | `If-Match` required; partial update |
| DELETE | `/orgs/{orgId}/products/{id}` | manager | Soft delete; `If-Match` required |
| POST | `/orgs/{orgId}/products/{id}/restore` | manager | Undo a delete within 30 days |
| GET | `/orgs/{orgId}/products/lookup?barcode=` | any member | Exact barcode or SKU match, for scanners |
| GET / POST / PATCH | `/orgs/{orgId}/locations[/{id}]` | any member / admin | |
| POST | `/orgs/{orgId}/stock/movements` | stock keeper or manager | Adjust stock; see below |
| POST | `/orgs/{orgId}/stock/transfers` | stock keeper or manager | Move units between locations atomically |
| POST | `/orgs/{orgId}/stock/counts` | stock keeper or manager | Submit a stock count; server writes the difference as a `count` movement |
| GET | `/orgs/{orgId}/stock/movements` | any member | Ledger, paged, filter by product, location, reason, date |
| POST | `/orgs/{orgId}/reservations` | sales or manager | Hold stock for an order, with expiry |
| POST | `/orgs/{orgId}/reservations/{id}/commit` | sales or manager | Converts the hold into a `sale` movement |
| POST | `/orgs/{orgId}/reservations/{id}/release` | sales or manager | Frees the hold |
| GET | `/orgs/{orgId}/dashboard` | any member | Counters, low-stock list, recent movements |
| POST | `/orgs/{orgId}/imports` | manager | Upload CSV, returns a job id (async) |
| GET | `/orgs/{orgId}/imports/{jobId}` | manager | Job status and per-row errors |
| POST | `/orgs/{orgId}/exports` | any member | Start CSV export; result is a short-lived R2 link |
| GET | `/orgs/{orgId}/audit` | admin | Audit log, paged |
| GET / POST / DELETE | `/orgs/{orgId}/webhooks[/{id}]` | admin | Outbound webhook subscriptions |

### Example: adjust stock

```http
POST /api/v1/orgs/org_7Qh.../stock/movements
Idempotency-Key: 5f0b2c1e-6c4f-4d0e-9b0e-3a1f2d7c9e11
Content-Type: application/json

{
  "productId": "prd_2Kx...",
  "locationId": "loc_9aB...",
  "delta": -3,
  "reason": "sale",
  "reference": "ORDER-10442"
}
```

```http
HTTP/1.1 201 Created
Content-Type: application/json

{
  "movement": { "id": "mov_8Tq...", "delta": -3, "balance": 47, "reason": "sale", "createdAt": "2026-11-14T09:12:03.120Z" },
  "stock": { "productId": "prd_2Kx...", "locationId": "loc_9aB...", "onHand": 47, "reserved": 2, "available": 45 }
}
```

Stock is only ever changed by a **delta**, never by setting a new total, so two simultaneous sales both count. Setting a known total is done with a stock count, which the server turns into a delta.

## Errors

Every error uses [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457) `application/problem+json`:

```json
{
  "type": "https://shoplist.dev/errors/insufficient-stock",
  "title": "Not enough stock",
  "status": 409,
  "detail": "Only 2 units of SKU MOUSE-001 are available at Main Warehouse.",
  "instance": "req_01JC...",
  "errors": [{ "field": "delta", "code": "insufficient_stock" }]
}
```

| Status | When |
|---|---|
| 400 | Malformed JSON or failed validation (`errors[]` lists each field) |
| 401 | No valid session or API key |
| 403 | Signed in, member of the org, but the role does not allow this |
| 404 | Not found, or an org the caller is not a member of |
| 409 | Business rule conflict: duplicate SKU, insufficient stock |
| 412 | `If-Match` does not match the current version (someone else changed it) |
| 413 | Body over 64 KB, or upload over 5 MB |
| 422 | Idempotency key reused with a different body |
| 428 | `If-Match` or `Idempotency-Key` missing where required |
| 429 | Rate limited; `Retry-After` header says when to retry |
| 500 | Bug. `instance` is the request id to report |
| 503 | Free-tier daily limit reached or dependency down; `Retry-After` set |

`detail` is written for the person using the app and is safe to show in the UI.

## Pagination

Cursor based, never offset based, so deep pages stay fast and items are not skipped or repeated while data changes.

```
GET /orgs/{orgId}/products?limit=50&sort=-updatedAt
```

```json
{ "data": [ ... ], "nextCursor": "eyJ1IjoiMjAyNi0xMS0xNFQwOToxMjowMy4xMjBaIiwiaSI6InByZF8yS3gifQ", "hasMore": true }
```

- `limit` defaults to 50, maximum 200.
- Pass `cursor=<nextCursor>` for the next page. Cursors are opaque; do not build them.
- Totals are not returned on list endpoints, because counting reads every row. Use `/dashboard` for totals.

## Optimistic concurrency

Every mutable resource has a `version`. `GET` returns it as `ETag: "7"`. Updates and deletes must send `If-Match: "7"`. If someone else changed the record first, the server returns `412` with the current record in the body so the UI can show what changed and let the user choose.

## Idempotency

`POST` endpoints that create things or move stock require `Idempotency-Key` (any unique string up to 255 characters, a UUID is ideal). Retrying with the same key within 24 hours returns the original response without repeating the action. The same key with a different body returns `422`.

## Rate limits

| Caller | Limit |
|---|---|
| Unauthenticated (auth endpoints) | 10 requests per minute per IP, plus Turnstile |
| Session | 120 requests per minute per user |
| API key | 300 requests per minute per key |
| Imports and exports | 5 jobs per hour per org |

Responses carry `RateLimit-Limit`, `RateLimit-Remaining` and `RateLimit-Reset` headers. Exceeding a limit returns `429` with `Retry-After`.

## Webhooks

Events: `product.created`, `product.updated`, `product.deleted`, `stock.changed`, `stock.low`, `stock.out`, `import.completed`.

```json
{ "id": "evt_...", "type": "stock.low", "createdAt": "...", "orgId": "org_...", "data": { ... } }
```

- Signed with HMAC-SHA256 over `timestamp + "." + body` using the subscription's secret, sent as `ShopList-Signature: t=<unix>,v1=<hex>`. Receivers must reject signatures older than 5 minutes.
- Delivered at least once. Deduplicate on `id`.
- Retried with exponential backoff for 24 hours (the free-plan Queues retention), then marked failed and shown in the UI.

## Limits

| Item | Limit |
|---|---|
| Request body | 64 KB |
| CSV import | 5 MB, 20,000 rows |
| Product name | 200 characters |
| Description | 5,000 characters |
| SKU, barcode | 64 characters |
| Locations per org | 50 |
| Members per org | 50 |


## Added with the access-level work

All under `/orgs/{orgId}` unless noted. The generated reference at `/api/docs` is the full list.

| Area | Endpoints |
|---|---|
| Settings | `GET/PATCH /settings` |
| Approvals | `GET /approvals`, `POST /approvals/{id}/approve`, `/reject`, `/withdraw` (a risky write may answer `202 { approval }`) |
| Reports | `GET /reports/{sales, sales-by-product, valuation, movements, low-stock, dead-stock, shrinkage}?from&to&location&days&format=csv` |
| Purchasing | `/suppliers`, `/purchase-orders` (+ `/send`, `/receive`, `/cancel`, `/close`), `/purchasing/reorder`, `/purchasing/reorder/draft` |
| Counts | `/count-tasks` (+ `/lines`, `/submit`, `/cancel`) |
| Customers | `/customers`, `GET /orders/{id}/document?type=invoice\|receipt` |
| Team | `/invitations` (list, resend, revoke), `/members/{id}/deactivate`, `/reactivate`, `/admin-handover`; `PATCH /members/{id}` takes `locationIds` |
| Me | `GET /me/notifications`, `/me/notifications/unread-count`, `POST /me/notifications/read`, `/me/notification-preferences` |
| Platform (developer only) | `POST /admin/orgs` (onboard), `GET /admin/orgs/{id}`, `/admin/users/{id}`, `POST /admin/orgs/{id}/transfer-admin`, `/resend-invitation`, `POST /admin/users/{id}/sign-out` |

## Added with the platform work (Phase 2b and 3)

| Area | Endpoints |
|---|---|
| Sign-in history | `GET /auth/events` (your last 20 events), `POST /auth/not-me` (signs you out everywhere, tells your admins) |
| Plan | `GET /orgs/{orgId}/plan` (limits, switched-on features; admins also get usage). A limit answers `403 plan_limit`; a switched-off feature answers `404` |
| Support access | `POST/GET /orgs/{orgId}/support-grants`, `DELETE /orgs/{orgId}/support-grants/{id}`. The owner uses the header `X-Support-Grant: <id>`. Body field `mode`: `view` (default, read-only: every non-GET answers `403 support_read_only`) or `assist` (needs a `note` giving the reason; allows changes to products, stock, orders, purchasing and counts; every DELETE answers `403 support_no_delete`) |
| Deletion | `DELETE /orgs/{orgId}` with `{ "confirmName": "<business name>" }` schedules deletion in 14 days (read-only until then; writes answer `403 org_read_only`); `POST /orgs/{orgId}/cancel-deletion` |
| Notices | `GET /announcements` (notices and maintenance that apply to you) |
| Audit export | `GET /orgs/{orgId}/audit?format=csv&from=YYYY-MM-DD&to=YYYY-MM-DD` (5,000 rows at most, `X-Truncated: true` when cut) |
| Platform (owner only) | `GET /admin/security`, `GET/PATCH /admin/plans`, `PATCH /admin/orgs/{id}/plan`, `GET /admin/support`, `POST /admin/orgs/{id}/cancel-deletion`, `GET/POST/DELETE /admin/announcements`, `GET/POST/DELETE /admin/maintenance`, `GET /admin/audit?format=csv` |

While maintenance is on, every write outside `/admin` and `/auth` answers `503 maintenance` with `Retry-After`; reads keep working.

`PATCH /me/notification-preferences` takes `{ orgId, kind, inApp?, email? }`; `kind` may be `digest` (the 08:00 summary, email only). `GET /email/unsubscribe?t=` is public and signed.

| Links | `POST/DELETE /orgs/{orgId}/orders/{id}/share`, `POST/DELETE /orgs/{orgId}/purchase-orders/{id}/share`; public: `GET /s/o/{token}`, `GET /s/po/{token}`, `POST /s/po/{token}/confirm`, `POST /s/po/{token}/dispatched` |

`GET /admin/usage` (owner): 30 days of platform usage, today's warnings against the free limits, and the busiest businesses when Analytics Engine is on. Needs the secrets `CF_ANALYTICS_TOKEN` (Account Analytics: Read) and `CF_ACCOUNT_ID`.

`GET /admin/backups` (metadata only), `POST /admin/backups/run`, `POST /admin/backups/{orgId}/{day}/restore` (loads a nightly copy into a new business and optionally invites its admin). Copies are made by the 03 UTC cron.

### Owner console additions

| Route | Purpose |
|---|---|
| `GET /admin/status` | Last result of every housekeeping job, failures in 7 days, last backup, email sent and failed today |
| `GET /admin/overview` | Counters (businesses, new, suspended, scheduled for deletion, people, sessions) and an `attention` list: failed backups, failed or stopped jobs, open security alerts, at-risk businesses, usage over 70%, open support windows, expired unaccepted invitations. A source that cannot be read appears as `error: true`; the rest still load |
| `GET /admin/health` | Each business with its health status, score and the four parts (activity, admin seen, backups, headroom) |
| `GET /admin/security/alerts?state=` | Security alerts, open first |
| `PATCH /admin/security/alerts/{id}` | Set `state` (`open`, `investigating`, `resolved`, `dismissed`) and an optional `note` (500 characters) |

### Access requests

| Route | Purpose |
|---|---|
| `POST /admin/orgs/{id}/access-requests` | Owner asks a business for access: `{ minutes: 30|60|240, reason, write?, includeCustomers? }`. 409 `request_pending` if one is waiting; 429 `too_soon` for 15 minutes after a decline or expiry |
| `GET /admin/access-requests` | Owner: requests across businesses |
| `DELETE /admin/access-requests/{rid}` | Owner withdraws a pending request |
| `GET /orgs/{orgId}/access-requests` | Business admin: requests from ShopList support |
| `POST /orgs/{orgId}/access-requests/{rid}/decide` | Business admin: `{ decision: approve|decline, minutes?, write?, includeCustomers? }`. Approving can only narrow (less time, no changes, no customer details), never widen. Creates the support window |
| `POST /orgs/{orgId}/support-grants` | Business admin opens a window at once: `{ minutes, note?, write?, includeCustomers? }`. `write` needs a `note` of 3+ characters |
