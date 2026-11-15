# Access tiers: feature plan

Status: **plan, not built.** Written 2026-11-16. Nothing here is implemented until approved, except
where a row says **Built**.

ShopList has three levels, borrowed from the GoVet ERP design (`ACCESS_TIER_REDESIGN_PLAN.md`):
**Developer** (the platform), **Admin** (one business owner per organization) and **Staff** (roles by
job). This plan adds a fourth, **External**, for people outside the business who need a narrow view.

## 1. Principles

1. **Least privilege by job.** Each role sees only what its job needs. The matrix lives in one place
   (`ROLE_PERMISSIONS` in `packages/shared`). Every route declares one permission, and a test walks
   every role through every route.
2. **Tenant data belongs to the tenant.** The developer runs the platform and does not read a
   business's inventory. The only exception is **support access** that the admin grants, which is
   time-boxed, read-only and logged (§3.4).
3. **The admin assigns roles but never defines them.** Only code changes what a role can do.
4. **Every change is audited.** Org actions go to the org activity log. Platform actions go to the
   platform audit log. Support access goes to both.
5. **Stays on the Cloudflare free plan.** Every feature notes its cost (§8).

## 2. Gaps found while writing this (fix first)

| Gap | Risk | Fix |
|---|---|---|
| Any signed-in person can `POST /orgs` and become admin of a new organization, including invited staff. | Staff create shadow organizations; invite-only means nothing for org creation. | Only the developer creates organizations, through "Onboard a business" (§3.1). Keep self-serve as a later, flag-controlled option. |
| A new client business can only start if someone invites its first admin, and only org admins can invite. | There is no clean way to onboard a new business. | "Onboard a business" creates the org and invites its admin, without making the developer a member. |
| No list of pending invitations, and no way to revoke one. | A wrong-email invite stays live for 7 days. | `GET`/`DELETE /orgs/:id/invitations`, plus "Resend" (§4.1). |
| Every member can see every member's email (`GET /members` is `inventory:read`). | Mild privacy leak to all staff. | Staff see names only; admin sees emails. |
| Sales, stock keepers and viewers see cost prices and inventory value. | Margins leak to staff. | New `cost:read` permission (§6). |

## 3. Developer (platform console, `/admin`)

Signs in only at `/owner` with GitHub. Never a member of any organization.

| # | Feature | What it does | Status | Phase |
|---|---|---|---|---|
| 3.1 | **Onboard a business** | Create an organization and invite its admin by email. The developer is not added as a member. | New | 1 |
| 3.2 | Platform overview | Counts of organizations, users and active sessions | **Built** | — |
| 3.2b | Usage dashboard | Requests per day against the free quota, D1 writes, error rate, webhook queue backlog, orgs near their limits | New | 2 |
| 3.3 | Organizations | List, suspend, restore | **Built** | — |
| 3.3b | Organization detail | Admin contact, member/product/location counts, last activity, plan and limits. "Transfer admin" when the admin has left. | New | 1 |
| 3.4 | **Support access** | The org admin grants a 30 or 60-minute read-only window from Settings. The developer sees the org with a red "support view" banner; writes are refused. Every request is logged and the admin can revoke early. | New | 2 |
| 3.5 | Users | List, disable, enable (signs them out) | **Built** | — |
| 3.5b | User detail | Their orgs and roles, sessions (force sign-out), sign-in history | New | 1 |
| 3.6 | Plans and limits | Per-org caps (products, members, locations, API keys, webhooks) and feature switches (orders, webhooks, API, import), enforced on the server | New | 2 |
| 3.7 | Security center | Failed and refused sign-ins, new-device sign-ins, rate-limit hits, disabled accounts; weekly digest | New | 2 |
| 3.8 | Announcements and maintenance | A banner for all users or one org. A read-only switch for migrations. | New | 3 |
| 3.9 | Platform audit log | Every developer action | **Built** | — |
| 3.9b | Audit export and retention | CSV export, 1-year retention, then delete | New | 3 |
| 3.10 | Backups | Nightly per-org export to R2, restore one org, rehearsal record | New (needs R2) | 3 |

## 4. Admin (business owner, one per organization)

### 4.1 Team

| Feature | Status | Phase |
|---|---|---|
| Invite by email with a role; invited people join on sign-in | **Built** | — |
| Change role, remove member; second admin needs confirmation; last admin protected | **Built** | — |
| Pending invitations: list, resend, revoke | New | 1 |
| Deactivate a member (keeps their history, blocks sign-in to this org) | New | 1 |
| **Location scoping**: limit a staff member to some locations (e.g. a stock keeper at Warehouse A only) | New | 2 |
| Last active time and sessions per member, with "sign out this member" | New | 2 |
| Hand over the admin role to someone else | New | 1 |

### 4.2 Business settings

| Feature | Status | Phase |
|---|---|---|
| Organization name | **Built** | — |
| Currency, timezone, tax rate, order number prefix, units, default reorder point | New | 2 |
| Locations (add, archive) | **Built** | — |

### 4.3 Control and oversight

| Feature | Status | Phase |
|---|---|---|
| Activity log | **Built** | — |
| **Approval rules**: adjustments over N units or worth over X, damage write-offs, and cancelling a paid order go to a queue; a manager or admin approves or rejects | New | 2 |
| Grant and revoke support access for the developer (§3.4) | New | 2 |
| Backup download (JSON) | **Built** | — |
| Restore from a backup file | New | 3 |
| Delete organization | **Built** | — |
| Delete with a 14-day grace period and undo | New | 3 |

### 4.4 Integrations

| Feature | Status | Phase |
|---|---|---|
| API keys (read or write) | **Built** | — |
| Narrower key scopes (orders only, stock only, read reports) | New | 2 |
| Webhooks with signing and delivery log | **Built** | — |

### 4.5 Insight

| Feature | Status | Phase |
|---|---|---|
| Dashboard counters | **Built** | — |
| **Reports**: sales by day and product, stock valuation, movement summary, low stock, dead stock (no sales in N days), shrinkage; CSV export | New | 2 |
| Notifications: low stock, out of stock, new order, approval waiting (in-app first, email later) | New | 2 (in-app), 3 (email) |

## 5. Staff (roles by job)

### 5.1 Everyone on staff

| Feature | Status | Phase |
|---|---|---|
| Profile, sessions, passkeys | **Built** | — |
| Notification inbox | New | 2 |
| "My activity": what I changed today | New | 2 |
| Phone-first screens for their main task | Partly built | 2 |

### 5.2 By role

| Role | Main job | Already can | To add | Phase |
|---|---|---|---|---|
| **Manager** | Runs daily operations | Products, prices, stock, orders, import | Approve requests; reports; **suppliers and purchase orders**; reorder suggestions; schedule cycle counts and assign them | 2 |
| **Sales** | Sells and fulfils | Create, pay, ship, cancel orders | **No cost prices**; customer lookup and history; printable invoice or receipt; share an order-status link; cancelling a paid order needs approval | 2 |
| **Stock keeper** | Moves goods | Receive, adjust, transfer, count | Receive against a purchase order; "my count tasks"; scan-first flow; damage reports go to approval; limited to assigned locations | 2 |
| **Viewer** | Looks only | Read everything except cost | Nothing more, by design | — |

## 6. External (outside the business)

| Who | Access | Status | Phase |
|---|---|---|---|
| **Accountant** (new staff role) | Read-only plus reports and cost prices. Cannot change stock or orders. | New | 2 |
| **Integration** (API key) | Read or write inventory | **Built**; narrower scopes in §4.4 | 2 |
| **Customer** | A private, unguessable link showing one order's status. No account. | New | 3 |
| **Supplier** | A private link to view one purchase order and confirm dispatch. No account. | New | 3 |

## 7. Permission model after this plan

New permissions:

| Permission | Meaning |
|---|---|
| `cost:read` | See cost price, margin and inventory value |
| `reports:read` | Reports and their exports |
| `approvals:decide` | Approve or reject queued requests |
| `purchasing:write` | Suppliers and purchase orders |
| `team:manage` | Members and invitations (split out of `org:manage`) |
| `settings:manage` | Business settings, locations, API keys, webhooks |

| Permission | viewer | sales | stock | accountant | manager | admin |
|---|:-:|:-:|:-:|:-:|:-:|:-:|
| inventory:read | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| cost:read | | | | ✓ | ✓ | ✓ |
| reports:read | | | | ✓ | ✓ | ✓ |
| products:write | | | | | ✓ | ✓ |
| stock:write | | | ✓ | | ✓ | ✓ |
| orders:write | | ✓ | | | ✓ | ✓ |
| purchasing:write | | | | | ✓ | ✓ |
| approvals:decide | | | | | ✓ | ✓ |
| team:manage | | | | | | ✓ |
| settings:manage | | | | | | ✓ |
| org:owner (delete) | | | | | | ✓ |

Location scoping is a separate filter on top of the role: a scoped member's stock writes and
order fulfilment are refused outside their locations.

## 8. Data model changes

| Where | Change |
|---|---|
| D1 `memberships` | `deactivated_at`; `location_ids` (JSON, null = all) |
| D1 `invitations` | `revoked_at`; `location_ids` |
| D1 `organizations` | `settings` JSON (currency, timezone, tax, prefix); `plan`, `limits` JSON; `delete_after` |
| D1 new `support_grants` | org, granted_by, expires_at, revoked_at |
| D1 new `notifications` | user, org, kind, payload, read_at |
| Durable Object new tables | `suppliers`, `purchase_orders`, `po_lines`, `approval_requests`, `customers`, `count_tasks` |
| Role CHECK | add `accountant` (migration, like 0005) |

Free-plan impact: everything is D1 or Durable Object SQLite. Email notifications need a provider (for
example Resend's free tier) and a secret. Nightly backups need an R2 bucket. Reports run on demand
inside the org's Durable Object, so no extra service is needed.

## 9. Phases

**Phase 1: close the gaps (about 1 week)**
- Onboard a business (3.1); block self-serve org creation in invite mode.
- Pending invitations list, resend, revoke; deactivate member; hand over admin.
- Staff see names only; admin sees emails.
- `cost:read`: hide cost and inventory value from sales, stock and viewer.
- Org and user detail pages for the developer.

Done when: an invited staff member cannot create an organization; the developer can onboard a
business without becoming a member; a sales user's API responses contain no cost fields (a test
proves it).

**Phase 2: run the business (about 3–4 weeks)**
- Approval rules and queue; reports; in-app notifications; business settings.
- Suppliers, purchase orders, receive against PO, reorder suggestions.
- Location scoping; accountant role; narrower API key scopes.
- Support access with audit; plans and limits; usage dashboard; security center.

Done when: an adjustment over the threshold waits for approval and is applied only after it; a stock
keeper scoped to Warehouse A gets 403 at Warehouse B; the developer can read an org only inside an
active grant, and the admin sees each request in the activity log.

**Phase 3: polish and reach (as needed)**
- Email notifications; customer order link; supplier PO link; restore from backup; delete grace
  period; announcements and maintenance mode; R2 nightly backups; audit export and retention.

## 10. Decisions needed from you

1. **Support access.** OK for the developer to get read-only access when an admin grants it? Or
   should the developer never see tenant data at all (today's rule)?
2. **Who can create a new business?** Only you (recommended while invite-only), or self-serve signup
   later?
3. **Approvals.** Which actions need approval, and default thresholds (for example adjustments over 20
   units or $500)?
4. **Email.** OK to add an email provider for notifications (free tier, needs an account and key)?
5. **Accountant role and the customer and supplier links.** Wanted, or out of scope?
6. **Billing your clients** (plans and payments): needed now, later, or never?
