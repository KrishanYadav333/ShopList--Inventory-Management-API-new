# Roadmap

Each phase ships to production on its own and leaves the system working. A phase is done only when every acceptance criterion passes in CI or in a recorded manual check.

## Phase 0: v1 (done)

Single shared product list, Worker + D1, public writes capped at 500 products. Live at https://shoplist.technology1.workers.dev.

## Phase 1: Foundation

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

## Phase 2: Identity and tenancy

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

## Phase 3: Correct inventory

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

## Phase 4: Experience

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
