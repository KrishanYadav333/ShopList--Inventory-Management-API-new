# ShopList: access levels and feature plan

**Status: Phase 1 (F1–F7) is built and deployed (2026-11-16). Later phases are plan only** unless a line says *Built*.
The plan was approved with the defaults listed in [08-decisions.md](08-decisions.md).
Written 2026-11-16. Build starts after you approve it (see [08-decisions.md](08-decisions.md)).

## What this plan is for

ShopList already works as a multi-business inventory and order system. What it lacks is a clear
answer to "**who can do what, and what does each person actually need to do their job?**"

Today there are three levels in the code (Developer, Admin, Staff by job). This plan defines
**every feature each level needs**, why it is needed, how it will work, and how we will know it
works. It also fixes five gaps found while mapping the current routes.

## How to read it

| File | What is in it | Read if you want to know… |
|---|---|---|
| [01-model.md](01-model.md) | The four levels, every role, the final permission matrix, what each role sees on screen, and how enforcement works | Who can do what |
| [02-phase1-foundations.md](02-phase1-foundations.md) | Phase 1, features F1–F7: close the security and onboarding gaps | What we build first and why |
| [03-phase2-operations.md](03-phase2-operations.md) | Phase 2a, features F8–F18: run the business (settings, approvals, reports, purchasing, counts, customers, invoices) | The day-to-day features for admins and staff |
| [04-phase2-platform.md](04-phase2-platform.md) | Phase 2b, features F19–F22: the developer's platform tools (support access, plans and limits, usage, security center) | Your own console |
| [05-phase3-reach.md](05-phase3-reach.md) | Phase 3, features F23–F30: email, customer and supplier links, restore, backups, maintenance | Later polish |
| [06-data-and-api.md](06-data-and-api.md) | Every table, column, migration and endpoint in one place | The technical reference |
| [07-testing-and-rollout.md](07-testing-and-rollout.md) | How each phase is tested, released safely, and kept on the free plan | How we avoid breaking production |
| [08-decisions.md](08-decisions.md) | The questions only you can answer, with the default this plan assumes | What you need to decide before we start |

Every feature has the same sections: **Why**, **Who**, **How it works** (user flow), **Screens**,
**API**, **Data**, **Rules and edge cases**, **Security**, **Tests**, **Done when**, **Effort**.

Effort sizes: **S** = half a day to a day, **M** = 2–3 days, **L** = 4–6 days (one developer).

## The levels in one picture

```
Developer (you)            the platform: businesses, users, limits, security, support
   │  never a member of a client business; reads tenant data only inside an admin-granted window
   ▼
Admin (one per business)   the business owner: team, settings, approvals, reports, integrations
   │  assigns roles, never defines them
   ▼
Staff (by job)             manager · sales · stock keeper · accountant · viewer
   │  each sees and does only what the job needs, optionally limited to some locations
   ▼
External (no account)      customer order link · supplier purchase-order link · API integrations
```

## Feature list and phases

| ID | Feature | Main level | Phase | Effort |
|---|---|---|---|---|
| F1 | Onboard a business; stop self-serve org creation | Developer | 1 | M |
| F2 | Pending invitations: list, resend, revoke | Admin | 1 | S |
| F3 | Member lifecycle: deactivate, reactivate, hand over admin | Admin | 1 | M |
| F4 | Member privacy: only the admin sees emails | Admin, Staff | 1 | S |
| F5 | Cost visibility (`cost:read`) | All staff | 1 | M |
| F6 | Developer: organization and user detail pages | Developer | 1 | M |
| F7 | Permission split (`team:manage`, `settings:manage`, `org:delete`) | Internal | 1 | S |
| F8 | Business settings (currency, timezone, tax, numbering, defaults, business details) | Admin | 2a | M |
| F9 | Location scoping for staff | Admin, Staff | 2a | M |
| F10 | Approval rules and approval queue | Admin, Manager, Staff | 2a | L |
| F11 | In-app notifications | Everyone | 2a | M |
| F12 | Reports (with daily rollups) | Admin, Manager, Accountant | 2a | L |
| F13 | Suppliers and purchase orders, receiving | Manager, Stock keeper | 2a | L |
| F14 | Reorder suggestions | Manager | 2a | M |
| F15 | Cycle count tasks (with blind counts) | Manager, Stock keeper | 2a | M |
| F16 | Customers, tax, printable invoice and receipt | Sales | 2a | L |
| F17 | Accountant role | Accountant | 2a | S |
| F18 | Narrower API key scopes | Admin | 2a | S |
| F19 | Support access (admin-granted, read-only, logged) | Developer, Admin | 2b | M |
| F20 | Plans, limits and feature switches | Developer | 2b | M |
| F21 | Usage dashboard | Developer | 2b | M |
| F22 | Security center and sign-in history | Developer, everyone | 2b | M |
| F23 | Email notifications | Everyone | 3 | M |
| F24 | Customer order-status link | External | 3 | S |
| F25 | Supplier purchase-order link | External | 3 | S |
| F26 | Restore from a backup file | Admin | 3 | M |
| F27 | Delete with a 14-day grace period | Admin, Developer | 3 | S |
| F28 | Announcements and maintenance mode | Developer | 3 | S |
| F29 | Nightly backups to R2 | Developer | 3 | M |
| F30 | Audit export and retention | Developer, Admin | 3 | S |

**Totals (rough):** Phase 1 ≈ 1.5 weeks. Phase 2a ≈ 5–6 weeks. Phase 2b ≈ 2 weeks.
Phase 3 ≈ 2 weeks. Phases 2a and 2b can be interleaved; each feature ships on its own.

## Build order inside each phase

Each feature is merged and deployed alone, behind tests, so production is never half-done:

1. D1 and Durable Object migrations (additive only, so old code still works).
2. Shared schemas and the permission matrix.
3. API routes and tests.
4. Screens.
5. Docs and the changelog.
6. Deploy, then a live smoke test.
