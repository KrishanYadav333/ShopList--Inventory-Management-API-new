# Roadmap

Status on 2026-11-19. Each phase shipped to production on its own and left the system working.

**Where it stands:** everything below is built, deployed and tested (361 tests, CI green). What is left needs the owner's accounts, a domain, or a real device. See [HANDOFF.md](HANDOFF.md).

## Phases

| Phase | What | State |
|---|---|---|
| 0 | v1: one shared product list | Retired and removed on 2026-11-18 (git history keeps it) |
| 1 | Foundation: Hono API, shared Zod schemas, problem+json errors, request ids, security headers, generated API docs at `/api/docs`, CI (typecheck, tests, bundle budget, audit) | Done |
| 2 | Identity and tenancy: GitHub OAuth with PKCE for the owner, Clerk for customers, invitations, roles, tenant isolation, passkeys | Done |
| 3 | Correct inventory: products, locations, append-only ledger, adjust, transfer, count, idempotency, versioning, counters, audit log | Done |
| 4 | Experience: dashboard-style UI, filters in the URL, search, undo, conflict screen, command palette, keyboard shortcuts, phone card layout | Done |
| 5 | Integrations: API keys with scopes, signed webhooks with retries, CSV import and export, load test | Done |
| 6 | Access levels (plan F1 to F30): job roles and the accountant, business settings, location scope, approvals, reports, purchasing, counts, customers, invoices, support access, plans and limits, usage, sign-in history, email, share links, restore, nightly backups, maintenance, scheduled deletion | Done; backups are kept in D1 until R2 is enabled |
| 7 | Extras: per-product tax, receiving up to 10% over, staff activity report, overdue count reminders, per-location restore | Done |
| 8 | Owner console (plan O1 to O5): pages with a labelled sidebar, system status, security alerts, business health, dashboard with an attention list | Done |
| 9 | Access requests, view-as-admin and passkeys (plan A1 to A3): requests in both directions, the write tick, impersonation with approval, passkeys with QR, an owner and admin requirement | Done; the passkey requirement is off until the owner switches it on |
| 10 | Demo data and screenshots | Done: `apps/api/scripts/seed-demo.mjs`, [DEMO.md](DEMO.md) |

The detailed plans are in [plan/README.md](plan/README.md) (also as one file: [PLAN.md](PLAN.md)), [plan/09-owner-console.md](plan/09-owner-console.md) and [plan/10-access-requests-and-passkeys.md](plan/10-access-requests-and-passkeys.md).

## Checked

- axe: 0 violations on the sign-in page, the owner console and the main business pages, at 1280 px and 390 px.
- Lighthouse mobile on `/login`: performance 99, accessibility 100, best practices 92, SEO 100. It was not re-run on the newest pages.
- Load test: 400 parallel sales of 10 units sell exactly 10; 100 identical retries create one movement; counters match a recount. A 20,000-row import runs through the queue.
- Initial bundle about 130 KB gzipped.

## Open, each blocked on something outside the code

| Item | Needs |
|---|---|
| Move sign-in to a production Clerk instance | A domain of your own (a development instance is used now) |
| Nightly backups out of D1 and into R2 | R2 enabled on the account |
| The per-business usage list | Analytics Engine enabled, then one binding line (see [OPERATIONS.md](OPERATIONS.md)) |
| Mail that does not land in spam | SPF and DKIM on a domain you own, in Brevo |
| Passkey requirement for the owner and admins | The owner adds a passkey, then switches it on (Owner console, Security) |
| Real phone and VoiceOver checks | A person with the device |
| Rotating secrets pasted into chat | The owner's choice (deferred) |

## Later, only when a measured need appears

- Shard a hot business's stock by location ([ARCHITECTURE.md § Scaling plan](ARCHITECTURE.md#6-scaling-plan)).
- Product variants (size, colour); offline stock changes on mobile; Shopify and WooCommerce connectors.
- Google sign-in outside Clerk, Turnstile on sign-in, preview deployments.
- A helpdesk with tickets, billing and payments: deliberately left out while plans are set by hand.
