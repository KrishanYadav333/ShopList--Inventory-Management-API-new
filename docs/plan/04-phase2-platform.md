# 04 · Phase 2b: the developer's platform tools (F19–F22)

**Goal:** let you run ShopList as a service: help a business when it asks, set what each business may
use, see the platform's health, and spot attacks, all without reading tenant data by default.

**Order:** F22 (sign-in events are needed by others) → F20 → F21 → F19.
**Estimate:** about 2 weeks.

---

## F22 · Security center and sign-in history

**Why.** Today nothing records refused sign-ins, so you cannot see someone trying to get in, and a
user cannot see "was that me?".

**What is recorded** (D1 `auth_events`): time, kind (`signin_ok`, `signin_refused`, `signout`,
`session_revoked`, `passkey_added`, `passkey_removed`, `user_disabled`, `rate_limited`), user id when
known, a hash of the email when not, door (github, clerk, passkey), country, browser family, reason
code. **Never** IP addresses in full, tokens, or raw emails of unknown people.

**For you (Platform → Security):**
- Counts for the last 24 h / 7 d: successful sign-ins, refused sign-ins by reason (not invited,
  owner-only, disabled, invalid token), rate-limit hits.
- A list of notable events: many refusals for one email hash, a sign-in from a new country for an
  admin, a disabled user trying again, any refusal on the GitHub door (someone else trying your door).
- A daily summary notification to you (in-app now, email in F23).

**For every user (Settings → Security):** their last 20 sign-in events and "This wasn't me", which
signs them out everywhere and notifies their admin.

**Free plan.** One write per sign-in or refusal. Rate-limit events are sampled (at most one per IP
per minute) so an attack cannot burn the write quota. Rows older than 90 days are deleted by the
daily job.
**Tests.** Each refusal path writes one event; events never contain raw IPs or unknown emails;
sampling caps writes during a flood test.
**Effort:** M.

---

## F20 · Plans, limits and feature switches

**Why.** You need to stop one business from exhausting the free platform (for example importing a
million products), and you may later offer paid tiers. Feature switches also let you roll out new
features (purchasing, approvals) business by business.

**How it works.**
- Each business has a **plan** (`free`, `standard`, `custom`) and optional **overrides**.
- Limits: products, members, locations, API keys, webhooks, orders per month, imports per day.
- Feature switches: orders, purchasing, approvals, reports, API keys, webhooks, import, support access.
- Default `free` plan (suggested): 2,000 products, 5 members, 2 locations, 2 API keys, 2 webhooks,
  all features on. You can change these per plan in the console.
- When a business reaches a limit, the action is refused with `403 plan_limit` and a plain message
  ("Your plan allows 5 members. Ask the ShopList owner to raise it."); the admin sees usage bars in
  Settings → Plan.
- When a feature is switched off, its sidebar item and routes disappear for that business (`404`).

**API.** `GET/PATCH /admin/plans`, `PATCH /admin/orgs/:id/plan { plan, overrides }`,
`GET /orgs/:id/plan` (admin: usage and limits).
**Data.** D1 `plans(id, name, limits JSON, features JSON)`, `organizations.plan_id`,
`organizations.plan_overrides`. The Durable Object receives limits with the caller context; it
already keeps counters (product count) so checks are free.
**Tests.** Each limit refuses at the boundary and not before; switching off a feature 404s its routes.
**Effort:** M.

---

## F21 · Usage dashboard

**Why.** The free plan has hard daily limits (100,000 requests, 100,000 D1 writes, 10 ms CPU). You
need to see how close you are before users hit errors.

**What it shows (Platform → Usage):**
- Today and the last 30 days: Worker requests, errors, CPU time p50/p99, D1 reads and writes, queue
  messages, Durable Object requests. With a line at the free limit and a warning at 70%.
- Per business: requests per day (top 20), product count, members, last active.
- Alerts (in-app): any daily metric above 70% of its free limit.

**Where the numbers come from.**
- Platform totals: Cloudflare's GraphQL Analytics API, read with an API token that has only
  "Account Analytics: Read" (a secret). No writes, no cost.
- Per business: Workers Analytics Engine, one data point per API request (org id, route group,
  status). Its free allowance is separate from D1.

**Tests.** The analytics client is tested against recorded responses; the Analytics Engine write is
fire-and-forget and never fails a request.
**Effort:** M. **Needs:** a read-only Cloudflare API token (decision D7).

---

## F19 · Support access (admin-granted, read-only, logged)

**Why.** When a business says "my stock numbers look wrong", you need to look. Today the rule says
you can never see tenant data, which makes support impossible. This feature keeps the rule as the
default and adds a controlled exception that the business owns.

**How it works.**
1. The admin opens **Settings → Support access** and clicks **Allow ShopList support**, chooses a
   duration (30 minutes, 1 hour, 4 hours) and optionally writes what the problem is.
2. You get a notification. The business appears under **Platform → Support** with "Open (expires in
   58 min)".
3. You open it. ShopList shows that business's screens with a red banner: "Support view of
   <Business>. Read-only. Ends at 15:42. Every page you open is logged."
4. You can read everything a **viewer with cost and reports** could (products, stock, orders, history,
   reports), but **no write** of any kind, no team or settings pages, no customer contact details
   unless the admin ticked "include customer details".
5. Every request you make in the window is written to the business's activity log
   (`support:<you>` read `/orders/…`) and the platform audit log.
6. The admin can **End now** at any time. When the window ends, access stops immediately.
7. After the window, the admin sees a summary: "ShopList support viewed 14 pages between 14:42 and 15:20."

**Security.**
- Only a developer session (GitHub door) can use a grant. A grant cannot be created by the developer.
- Read-only is enforced on the server: any non-GET from a support session is refused before routing.
- Grants are per business, short, revocable, and logged at both ends.
- Optional extra (decision D1): require a passkey check on your side before opening a support view.

**API.** `POST /orgs/:id/support-grants { minutes, note, includeCustomers }` (`settings:manage`),
`DELETE /orgs/:id/support-grants/:gid`, `GET /orgs/:id/support-grants` (history),
`GET /admin/support` (active grants). Support reads use the normal org routes with a
`X-Support-Grant` header that the Worker validates.
**Data.** D1 `support_grants(id, org_id, granted_by, note, include_customers, created_at,
expires_at, ended_at)`.
**Tests.** Without a grant: 404 everywhere. With a grant: GETs work, every write is 403, settings and
team are 403, contact fields are shaped away unless allowed; expiry and early end cut access on the
next request; every request writes an audit entry.
**Effort:** M.
