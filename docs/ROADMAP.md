# Roadmap

Each phase ships to production on its own and leaves the system working. A phase is done only when every acceptance criterion passes in CI or in a recorded manual check.

## Phase 0: v1 (done)

Single shared product list, Worker + D1, public writes capped at 500 products. Live at https://shoplist.technology1.workers.dev.

## Phase 1: Foundation (mostly done)

> **Status:** Hono API, Zod schemas shared with the UI, problem+json errors, request ids and security headers are built and tested. Still to do: OpenAPI generation at `/api/docs`, Lighthouse CI budgets, GitHub Actions pipeline and preview deployments.

**Goal:** a typed, tested codebase that the rest can be built on.

- Monorepo layout: `apps/web` (React), `apps/api` (Hono Worker), `packages/shared` (Zod schemas, types)
- Hono API with Zod validation, problem+json errors, request ids, structured logs
- OpenAPI generated from the schemas; typed client used by the web app
- CI pipeline from [OPERATIONS.md](OPERATIONS.md#cicd-github-actions-free-for-public-repositories), preview deployments
- Design system tokens and base components; light and dark themes

**Acceptance**
- [ ] `npm test` runs API tests against local D1 and Durable Objects
- [ ] Every pull request gets a working preview URL
- [ ] `/api/docs` shows generated documentation
- [ ] Lighthouse CI and bundle size budgets enforced

## Phase 2: Identity and tenancy (partly done)

> **Status:** GitHub OAuth with PKCE, sessions (hashed tokens), organizations, roles, invitations and tenant isolation are built and tested. Also built: owner-only sign-in by default, a single super admin (platform admin screen, suspend/disable, platform audit log). Customer sign-in through Clerk is built on the server (token verification and session exchange, 12 tests); the browser sign-in screen needs a Clerk application. Clerk sign-in and passkeys are built. Session list and revoke are built. Still to do: Turnstile on sign-in.

**Goal:** real accounts and isolated organizations.

- GitHub and Google OAuth with PKCE; Turnstile on sign-in
- Sessions as specified in [SECURITY.md](SECURITY.md#sessions)
- Organizations, memberships, roles, invitations
- `InventoryDO` per org with schema migration on first request
- Permission declaration required on every route

**Acceptance**
- [ ] Tenant isolation test passes: org A user gets 404 on every org B endpoint
- [ ] Permission matrix test passes for all four roles on every route
- [ ] Session cookie has `__Host-`, HttpOnly, Secure, SameSite=Lax; only its hash is in D1
- [ ] Removing a member blocks their next request

## Phase 3: Correct inventory (done except migration)

> **Status:** Products, locations, ledger, adjust/transfer/count, idempotency, versioning, counters, audit log and integrity check are built and tested (40 tests, including 60 parallel sales against 50 units). Still to do: migrating v1 data into a Demo organization.

**Goal:** stock numbers that can be trusted under concurrency.

- Products with money in minor units, soft delete and restore, versioning with `If-Match`
- Locations; stock levels; append-only movements; adjust, receive, transfer, count
- Idempotency keys; maintained counters; audit log with field diffs
- Migration of v1 data into a "Demo" organization

**Acceptance**
- [ ] 50 parallel `-1` movements on stock of 50 end at exactly 0; the 51st returns 409
- [ ] Nightly integrity job confirms invariant I1 on seeded data
- [ ] Two editors saving the same product: the second gets 412 and the conflict screen
- [ ] Repeating a request with the same `Idempotency-Key` does not create a second movement

## Phase 4: Experience (mostly done)

> **Status:** Dashboard-style UI with sidebar counts, filters in the URL, search, stock adjust with undo, conflict resolution, history, settings, command palette, keyboard shortcuts, phone card layout and error boundary are built. Still to do: barcode camera scanning, bulk actions beyond CSV export, row virtualization, accessibility audit with axe, performance measurement on a real phone.

**Goal:** the UI described in [UX.md](UX.md).

- Dashboard, virtualized product table, filters in the URL, bulk actions
- Command palette and keyboard shortcuts
- Mobile stock adjust with barcode scanning
- Undo for deletes and stock changes; conflict resolution screen
- Every state from the state table
- Full-text search (FTS5)

**Acceptance**
- [ ] Performance budgets met on a mid-range phone profile
- [ ] axe reports zero serious or critical issues; manual VoiceOver pass recorded
- [ ] Scan to saved adjustment in 3 taps on a real phone
- [ ] Search returns in under 150 ms p95 on a 50,000-product seeded org

## Phase 5: Integrations and scale

**Goal:** usable by other systems and ready to grow.

- API keys with scopes; reservations with expiry
- CSV import and export through Queues, with per-row errors
- Webhooks with signing, retries and a delivery log
- Usage monitoring and 70% alerts; nightly backups to R2; restore rehearsal
- Edge caching for read-heavy API keys

**Acceptance**
- [ ] 20,000-row CSV import completes and reports failed rows
- [ ] Webhook signature verified by a reference receiver; retries observed after forced failures
- [ ] Restore of one org from a backup rehearsed and documented
- [ ] Load test: 200 requests per second against one org for 5 minutes with p95 under budget and zero ledger drift

## Later (only when measured need appears)

- Shard a hot org's stock by location ([ARCHITECTURE.md § Scaling plan](ARCHITECTURE.md#6-scaling-plan))
- Purchase orders and suppliers; reorder suggestions from sales velocity
- Product variants (size, color)
- Offline stock changes on mobile
- Shopify and WooCommerce connectors

## Status, 2026-11-14

Built and tested: orders with stock reservations, API keys, CSV import, webhooks, barcode scanning, generated API docs (`/api/docs`, `/api/v1/openapi.json`) and a CI pipeline (`.github/workflows/ci.yml`: typecheck, tests, bundle budget, audit).

Also built since: Clerk customer sign-in and sign-up (invite-only), a separate owner page (`/owner`), passkeys (register, sign in, remove), products table virtualization. v1 was retired and removed.

Measured on the live site: axe reports 0 violations on login, owner, orders, products, history and settings at 1280 px and 390 px. Lighthouse mobile on `/login`: performance 99, accessibility 100, best practices 92 (the one flag is the expected 401 from `/me` when signed out), SEO 100. A 1,500-product table keeps about 20 rows in the DOM while scrolling.

Also built: the session list with sign-out and "sign out everywhere else", a load test and a 20,000-row import check (results in OPERATIONS.md).

Not built: Google sign-in outside Clerk, Turnstile, nightly R2 backups and a restore rehearsal (they need your R2 bucket), automated preview deployments, the v1 to v2 cutover (see OPERATIONS.md), and checks on a physical phone and with VoiceOver, which need a person with the device.

## Status, 2026-11-18

The access-level plan ([plan/README.md](plan/README.md), one-file copy in [PLAN.md](PLAN.md)) is built and live, with 296 tests and CI green: Phase 1 (F1 to F7), Phase 2a (F8 to F18), and F19 to F30 with two exceptions below. That adds job roles and the accountant, business settings, location scoping, approvals, notifications and email (Brevo), reports, purchasing, count tasks, customers and invoices, support access, plans and limits, usage and security pages for the owner, share links for customers and suppliers, restore from a backup file, scheduled deletion, announcements and maintenance, nightly backups, and audit export and retention.

Checked in a real browser on 2026-11-18: axe reports 0 violations on Settings, Purchasing, Reports, Approvals, Counts, Customers, Products, Orders, the owner console and both public share pages; no sideways scroll at 390 px.

Open, each blocked on something outside the code: nightly backups are kept in D1 until R2 is enabled; the per-business half of the usage page needs Workers Analytics Engine enabled (code is ready; add the binding line described in OPERATIONS.md); Lighthouse was not re-run on the new pages; checks on a physical phone and with VoiceOver; the v1 to v2 cutover; and the remaining owner-only steps in [HANDOFF.md](HANDOFF.md). A real client invite and sign-in was confirmed working by the owner.

Also built 2026-11-18: per-product tax rates, receiving up to 10% over on a purchase order, a staff-activity report, daily overdue-count reminders, and per-location restore (backups now include stock per location). 306 tests.

v1 was retired on 2026-11-18 (see OPERATIONS.md, "v1 retired").
