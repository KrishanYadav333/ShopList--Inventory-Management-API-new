# ShopList: Documentation

ShopList is a multi-tenant inventory and order management system that runs entirely on Cloudflare and can be operated on the **Workers Free plan**. These documents describe the system as built, the reasoning behind each decision, and how to run it.

> **Status (2026-11-19):** built and live at https://shoplist-v2.technology1.workers.dev, with 361 tests and CI green. [ROADMAP.md](ROADMAP.md) shows what is done and what is open. The project README, with screenshots, is at the [repository root](../README.md).

## Documents

| Document | Read it when you need to know |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | How the system is put together, why, and how it scales |
| [DATA_MODEL.md](DATA_MODEL.md) | Every table, constraint and invariant |
| [API.md](API.md) | The HTTP contract: endpoints, errors, paging, concurrency, idempotency |
| [SECURITY.md](SECURITY.md) | Threat model, authentication, authorization, tenant isolation |
| [UX.md](UX.md) | Screens, flows, design system, accessibility and performance budgets |
| [OPERATIONS.md](OPERATIONS.md) | Deploying for free, CI/CD, free-tier budget, backups, monitoring, runbooks |
| [ROADMAP.md](ROADMAP.md) | What is built and what is open |
| [HANDOFF.md](HANDOFF.md) | The few things only the owner can do |
| [DEMO.md](DEMO.md) | Demo data, test accounts, regenerating the screenshots |
| [PLAN.md](PLAN.md) | The access-level feature plan in one file; the same plan is split across [plan/](plan/README.md) |
| [plan/09-owner-console.md](plan/09-owner-console.md) | The owner console: status, alerts, health, dashboard |
| [plan/10-access-requests-and-passkeys.md](plan/10-access-requests-and-passkeys.md) | Access requests, the write tick, view-as-admin, passkeys with QR |

## The system in one paragraph

A single Cloudflare Worker serves the React app as static assets (free and unmetered) and the `/api/v1` routes. Accounts, organizations, memberships and sessions live in one **D1** database, the *control plane*. Each organization's inventory (products, stock levels, the stock ledger, audit log and search index) lives in its **own Durable Object with SQLite storage**, the *data plane*. Tenants therefore never share a database, never contend for the same write lock, and cannot read each other's data even if application code has a bug. Slow work such as CSV imports, low-stock alerts and webhooks runs on **Queues**. Sign-in uses **Clerk** for customers (email and password, an emailed code, or Google), **GitHub** for the owner, and **passkeys** (on a device or a phone by QR code), so ShopList itself never stores a password.

## Design principles

1. **Correct before fast.** Stock counts come from an append-only ledger and change only through atomic operations. Losing an update is a bug, not a trade-off.
2. **Isolation by construction.** A tenant's data is physically separate, not filtered by a `WHERE org_id = ?` clause someone might forget.
3. **Free tier is a design constraint, not an afterthought.** Every hot path is costed in rows read, rows written and CPU milliseconds. See [OPERATIONS.md § Free-tier budget](OPERATIONS.md#free-tier-budget).
4. **Boring technology.** SQL, HTTP and React. No custom frameworks.
5. **Every state is designed.** Loading, empty, error, offline, conflict and permission-denied states all have a screen.

## Glossary

| Term | Meaning |
|---|---|
| Organization (org) | A tenant: a business with its own inventory and members |
| Location | A place stock is held, such as a warehouse, shop or van |
| On hand | Units physically at a location |
| Reserved | Units promised to an order but not yet shipped |
| Available | `on_hand - reserved` |
| Movement | One immutable ledger entry that changes stock at a location |
| Control plane | D1 database holding identities, orgs and sessions |
| Data plane | Per-org Durable Object holding that org's inventory |

## Style

No emojis anywhere: code, UI text, docs, commit messages. Use words ("Yes") and plain text in tables and status lines.
