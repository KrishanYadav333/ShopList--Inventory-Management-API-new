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
| POST | `/auth/passkeys/options` | Get WebAuthn registration or sign-in options |
| POST | `/auth/passkeys/verify` | Verify a passkey, set session cookie |
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
| POST | `/orgs` | Any signed-in user (becomes owner) |
| GET / PATCH / DELETE | `/orgs/{orgId}` | viewer / admin / owner |
| GET | `/orgs/{orgId}/members` | viewer |
| PATCH / DELETE | `/orgs/{orgId}/members/{userId}` | admin (owners only by owner) |
| POST | `/orgs/{orgId}/invitations` | admin |
| POST | `/invitations/{token}/accept` | Invitee |
| GET / POST / DELETE | `/orgs/{orgId}/api-keys[/{id}]` | admin |

### Inventory

| Method | Path | Role | Notes |
|---|---|---|---|
| GET | `/orgs/{orgId}/products` | viewer | Paged; `q`, `location`, `stock=low\|out\|in`, `tag`, `sort` |
| POST | `/orgs/{orgId}/products` | editor | Idempotency-Key required |
| GET | `/orgs/{orgId}/products/{id}` | viewer | Returns `ETag` |
| PATCH | `/orgs/{orgId}/products/{id}` | editor | `If-Match` required; partial update |
| DELETE | `/orgs/{orgId}/products/{id}` | editor | Soft delete; `If-Match` required |
| POST | `/orgs/{orgId}/products/{id}/restore` | editor | Undo a delete within 30 days |
| GET | `/orgs/{orgId}/products/lookup?barcode=` | viewer | Exact barcode or SKU match, for scanners |
| GET / POST / PATCH | `/orgs/{orgId}/locations[/{id}]` | viewer / admin | |
| POST | `/orgs/{orgId}/stock/movements` | editor | Adjust stock; see below |
| POST | `/orgs/{orgId}/stock/transfers` | editor | Move units between locations atomically |
| POST | `/orgs/{orgId}/stock/counts` | editor | Submit a stock count; server writes the difference as a `count` movement |
| GET | `/orgs/{orgId}/stock/movements` | viewer | Ledger, paged, filter by product, location, reason, date |
| POST | `/orgs/{orgId}/reservations` | editor | Hold stock for an order, with expiry |
| POST | `/orgs/{orgId}/reservations/{id}/commit` | editor | Converts the hold into a `sale` movement |
| POST | `/orgs/{orgId}/reservations/{id}/release` | editor | Frees the hold |
| GET | `/orgs/{orgId}/dashboard` | viewer | Counters, low-stock list, recent movements |
| POST | `/orgs/{orgId}/imports` | editor | Upload CSV, returns a job id (async) |
| GET | `/orgs/{orgId}/imports/{jobId}` | editor | Job status and per-row errors |
| POST | `/orgs/{orgId}/exports` | viewer | Start CSV export; result is a short-lived R2 link |
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
