# Operations

## Free-tier budget

Everything in this design runs on the **Cloudflare Workers Free plan**. These are the allowances it must fit inside (checked November 2026; confirm against the [Workers](https://developers.cloudflare.com/workers/platform/limits/), [D1](https://developers.cloudflare.com/d1/platform/pricing/), [Durable Objects](https://developers.cloudflare.com/durable-objects/platform/limits/) and [Queues](https://developers.cloudflare.com/queues/platform/limits/) docs before relying on them):

| Resource | Free allowance | Resets |
|---|---|---|
| Worker requests | 100,000 / day (static assets are free and do not count) | 00:00 UTC |
| CPU per request | 10 ms (time spent waiting on I/O does not count) | — |
| Subrequests per request | 50 | — |
| D1 rows read / written | 5,000,000 / 100,000 per day | 00:00 UTC |
| D1 storage | 500 MB per database, 5 GB per account, 10 databases | — |
| Durable Objects (SQLite) | 100,000 requests / day; 5,000,000 rows read and 100,000 rows written per day; 5 GB stored | 00:00 UTC |
| Queues | 10,000 operations / day; messages kept 24 hours | 00:00 UTC |
| R2 | 10 GB storage; 1,000,000 Class A and 10,000,000 Class B operations per month | Monthly |

### What one action costs

| Action | Worker requests | Rows read | Rows written |
|---|---|---|---|
| Session check (every API call) | — | 2 (session + membership, both by primary key) | 0 (expiry slides at most hourly) |
| Product list page (50 items) | 1 | about 50 (index range scan, no `COUNT`) | 0 |
| Search | 1 | matching rows only (FTS5) | 0 |
| Dashboard | 1 | about 25 (3 counters + 20 recent + low-stock index) | 0 |
| Stock adjustment | 1 | about 3 | about 6 (level + movement + 2 index entries + audit + counter) |
| Product edit | 1 | about 2 | about 6 (row + indexes + FTS + audit) |

### Daily capacity on the free plan

The binding limit is **rows written: 100,000 / 6 ≈ 16,000 inventory changes per day** across all organizations. A shop making 300 changes a day uses about 2% of that. Worker requests (100,000) allow roughly 90,000 API calls after headroom. Reads are not the bottleneck.

### Staying inside the budget

- No `SELECT COUNT(*)` on hot paths; maintained `counters` instead.
- Every list query uses an index and a `LIMIT`. CI fails any query plan containing a full table scan on a large table.
- Session expiry is extended at most once per hour.
- Imports batch 100 rows per Queue message, so a 20,000-row import is about 200 messages (about 600 Queue operations).
- A daily cron reads usage from the Cloudflare GraphQL Analytics API and alerts at 70% of any allowance.
- When a daily allowance runs out, the API returns `503` with `Retry-After` set to the next reset, and the UI explains it. Reads of cached pages keep working.

## Local development

```bash
npm install --legacy-peer-deps          # npm 10 has a peer-dependency resolver bug with vitest
cd apps/api
npx wrangler d1 migrations apply shoplist-control --local
# terminal 1: the API on :8787 (dev-only flags go on the command line, not in .dev.vars,
# because the test runner also reads .dev.vars)
npx wrangler dev --var APP_ORIGIN:http://localhost:5173 --var DEV_AUTH:true --var INSECURE_DEV_COOKIES:true
# terminal 2: the UI on :5173, proxying /api to :8787
cd ../web && npx vite
```

Open **http://localhost:5173** (not 127.0.0.1; the Origin check allows only the configured origin). The login page shows a development-only email sign-in. `DEV_AUTH` enables it and `INSECURE_DEV_COOKIES` relaxes the `__Host-` Secure cookie so a browser accepts it over plain http; neither is ever set in production or in tests, so the tests exercise the real production cookie.

Load and correctness check against a running local server (400 parallel sales of 10 units must sell exactly 10; 100 identical retries must create one movement; counters must match a recount): `node apps/api/scripts/loadtest.mjs`.

`wrangler dev --remote` no longer supports Durable Objects, so production-runtime behaviour (full-text search, transactions, the 100-parameter limit, parallel writes) is verified with a temporary key-protected Worker that calls the inventory object directly, then deletes itself. The v2 deployment passed 21 such checks on 2026-11-14.

Tests: `npm test` (runs the API suite inside the Workers runtime). Build the UI first with `npm run build -w @shoplist/web`, because the Worker's static assets directory must exist.

## Environments

| Environment | Worker | Data | Deployed by |
|---|---|---|---|
| Local | `wrangler dev` | Local D1 and Durable Object state in `.wrangler/` | Developer |
| Preview | `shoplist-preview` | Separate D1 database and objects, seeded with sample data | Every pull request |
| Production | `shoplist` | Production D1 and objects | Merge to `main` |

Preview and production never share data or secrets.

## Deploying from scratch (free)

Prerequisites: Node.js 20+, a free Cloudflare account, a GitHub account.

```bash
git clone https://github.com/KrishanYadav333/ShopList--Inventory-Management-API-new.git
cd ShopList--Inventory-Management-API-new
npm ci
npx wrangler login

# Control-plane database
npx wrangler d1 create shoplist-control         # copy the id into wrangler.jsonc
npx wrangler d1 migrations apply shoplist-control --remote

# Storage, queue
npx wrangler r2 bucket create shoplist-files
npx wrangler queues create shoplist-jobs

# GitHub OAuth app: https://github.com/settings/developers, callback
#   https://<your-host>/api/v1/auth/oauth/github/callback
# GitHub is the owner's door. SUPER_ADMIN_GITHUB_ID is a plain var in wrangler.jsonc (the owner's numeric
# GitHub id). Sign-in is owner-only unless SIGNIN_MODE=open.
# Clerk is the customers' door (only used when SIGNIN_MODE=open): create an application at clerk.com, then
#   npx wrangler secret put CLERK_SECRET_KEY
#   npx wrangler secret put CLERK_JWT_KEY       # Dashboard > API keys > Show JWT public key (PEM)
# and set CLERK_ISSUER (the Frontend API URL, e.g. https://example-12.clerk.accounts.dev) as a plain var.
npx wrangler secret put GITHUB_CLIENT_ID      # not secret, but kept out of git
npx wrangler secret put GITHUB_CLIENT_SECRET
npx wrangler secret put TURNSTILE_SECRET
openssl rand -base64 32 | npx wrangler secret put COOKIE_SIGNING_KEY

npm run build
npx wrangler deploy
```

The Durable Object class and its SQLite migrations are declared in `wrangler.jsonc` and created on first deploy. A custom domain is optional; the free `*.workers.dev` address works.

## CI/CD (GitHub Actions, free for public repositories)

Pull request pipeline:

1. `npm ci`, typecheck, lint
2. Unit and integration tests with `@cloudflare/vitest-pool-workers` (runs against real local D1 and Durable Objects)
3. Security tests: permissions matrix, tenant isolation, concurrency
4. Build; bundle size check
5. Deploy to preview, apply preview migrations
6. Playwright end-to-end tests against preview, axe accessibility checks, Lighthouse CI budgets, OWASP ZAP baseline
7. Comment the preview URL on the pull request

Merge to `main`:

1. Apply control-plane migrations to production (backward compatible by rule)
2. `wrangler deploy` with gradual rollout: 10% of traffic for 10 minutes, then 100% if the error rate stays under 1%
3. Smoke test: health check, sign-in page, a read through a monitoring API key

Rollback: `wrangler rollback` to the previous version. Because migrations are expand-then-contract, the previous code still works against the new schema.

## Observability

| Signal | Source | Used for |
|---|---|---|
| Structured logs | Workers Logs (JSON with `requestId`, `orgId`, `route`, `status`, `durationMs`) | Debugging; never log tokens, keys or request bodies |
| Metrics | Workers Analytics Engine data points per request | Latency percentiles, error rate, per-org usage |
| Usage vs free allowance | Daily cron reading the Cloudflare GraphQL Analytics API | 70% alert |
| Uptime | External checker hitting `/api/v1/health` every 5 minutes | Paging |
| Client errors | Small error reporter posting to `/api/v1/client-errors` (rate limited) | Frontend bugs |

Every response includes `X-Request-Id`, which the UI shows on errors so a user report leads straight to the log line.

### Service level objectives

| SLO | Target (30-day window) |
|---|---|
| API availability (non-5xx) | 99.9% |
| Read latency p95 | ≤ 80 ms |
| Write latency p95 | ≤ 150 ms |
| Ledger integrity (I1) | 100%; any drift is a sev-1 incident |

## Backups and recovery

| What | How | Recovery point | Recovery time |
|---|---|---|---|
| Control plane (D1) | D1 Time Travel (point-in-time restore; check your plan's retention window) plus a nightly SQL export to R2 | Minutes (Time Travel), 24 h (export) | Under 30 minutes |
| Each org's inventory | Nightly export of every object to R2 as JSON Lines by a cron-driven Queue job, 30 days kept | 24 hours | Under 1 hour per org |
| Ledger | The ledger is itself the history; any stock level can be rebuilt from it | — | — |

A restore is rehearsed quarterly into the preview environment and the result recorded.

## Runbooks

**Daily allowance about to run out**
1. Check which resource from the alert (requests, rows written, Queue operations).
2. Find the top orgs and API keys by usage in Analytics Engine.
3. If one key is abusive, revoke it. If usage is genuine growth, move to Workers Paid (USD 5/month); no code change is needed.

**Ledger drift detected**
1. The nightly job names the org, product and location.
2. Freeze writes for that org (feature flag in the control plane).
3. Rebuild `stock_levels` from `stock_movements` for the affected rows, inside one transaction.
4. Investigate the code path that wrote outside the transaction; add a regression test before unfreezing.

**Suspected account takeover**
1. Revoke all of the user's sessions and passkeys from the admin tool.
2. Review that user's audit entries.
3. Contact the user; restore data from the ledger or backups if needed.

**Leaked API key or webhook secret**
1. Revoke the key or rotate the secret in Settings; takes effect immediately.
2. Review audit entries for that key's actor id.
