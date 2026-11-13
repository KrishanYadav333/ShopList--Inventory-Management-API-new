# ShopList v2: Engineering Documentation

ShopList is a multi-tenant inventory management system that runs entirely on Cloudflare and can be operated on the **Workers Free plan**. These documents are the specification for v2. They describe the target system, the reasoning behind each decision, and the order to build it in.

> **Status:** v1 (live at https://shoplist.technology1.workers.dev) is a single shared product list with no accounts. Everything in these documents describes **v2**, which has not been built yet. Use [ROADMAP.md](ROADMAP.md) to see what is done.

## Documents

| Document | Read it when you need to know |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | How the system is put together, why, and how it scales |
| [DATA_MODEL.md](DATA_MODEL.md) | Every table, constraint and invariant |
| [API.md](API.md) | The HTTP contract: endpoints, errors, paging, concurrency, idempotency |
| [SECURITY.md](SECURITY.md) | Threat model, authentication, authorization, tenant isolation |
| [UX.md](UX.md) | Screens, flows, design system, accessibility and performance budgets |
| [OPERATIONS.md](OPERATIONS.md) | Deploying for free, CI/CD, free-tier budget, backups, monitoring, runbooks |
| [ROADMAP.md](ROADMAP.md) | Build phases with acceptance criteria |

## The system in one paragraph

A single Cloudflare Worker serves the React app as static assets (free and unmetered) and the `/api/v1` routes. Accounts, organizations, memberships and sessions live in one **D1** database, the *control plane*. Each organization's inventory (products, stock levels, the stock ledger, audit log and search index) lives in its **own Durable Object with SQLite storage**, the *data plane*. Tenants therefore never share a database, never contend for the same write lock, and cannot read each other's data even if application code has a bug. Slow work such as CSV imports, low-stock alerts and webhooks runs on **Queues**. Sign-in uses **OAuth (GitHub, Google) and passkeys**, so ShopList never stores a password.

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
