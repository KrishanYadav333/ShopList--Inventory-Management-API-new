# ShopList: access levels and feature plan (complete document)

**Status (2026-11-18): Phase 1 (F1–F7), Phase 2a (F8–F18), F19, F20, F22, F27, F28 and F30 are built and deployed. Still to build: F21 (needs a read-only Cloudflare API token), F23 (needs an email provider and domain), F24, F25, F26, F29 (needs an R2 bucket).**
The plan was approved with the defaults listed in the "Decisions needed before building" section.
Written 2026-11-16. Build starts after you approve it (see the "Decisions needed before building" section).

## What this plan is for

ShopList already works as a multi-business inventory and order system. What it lacks is a clear
answer to "**who can do what, and what does each person actually need to do their job?**"

Today there are three levels in the code (Developer, Admin, Staff by job). This plan defines
**every feature each level needs**, why it is needed, how it will work, and how we will know it
works. It also fixes five gaps found while mapping the current routes.


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

**Deviations from the plan as built:** the usage dashboard (F21) is not built; plan defaults can be edited through the API (`PATCH /admin/plans/{id}`) but the console only edits per-business overrides; the support grant is opened by the owner from the console and the passkey re-check (D1) is off; a platform-wide notice for the owner uses the `_platform` notification scope; per-product tax overrides and product-level supplier fields were not built (tax is one rate per business; a product's usual supplier is whoever it was last ordered from); over-receipt on a purchase order is refused rather than allowed up to 10%; staff-activity report was left to the activity log; overdue count reminders need a scheduler and are not built; count and approval items link from notifications but there is no email yet.

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

## Contents of this document

1. 01 · The access model
2. 02 · Phase 1: foundations (F1–F7)
3. 03 · Phase 2a: running the business (F8–F18)
4. 04 · Phase 2b: the developer's platform tools (F19–F22)
5. 05 · Phase 3: reach and resilience (F23–F30)
6. 06 · Data and API reference
7. 07 · Testing, rollout and the free plan
8. 08 · Decisions needed before building

# 01 · The access model

This file defines **who exists**, **what each one may do**, **what each one sees**, and **how the
server enforces it**. Every feature file refers back to it.

## 1. Principles

1. **Least privilege by job.** A role gets exactly what its job needs. A sales person does not need
   to change products; a stock keeper does not need to take payments.
2. **Tenant data belongs to the tenant.** A business's products, stock, prices, customers and orders
   are its own. The developer runs the platform but does not read them, except inside a support
   window that the business's admin opens (F19). This is today's rule, made workable.
3. **The admin assigns roles but never defines them.** What a role can do is set in code
   (`ROLE_PERMISSIONS` in `packages/shared`), reviewed and tested. An admin cannot invent a role or
   widen one. This stops "permission creep", where each business slowly builds unsafe custom roles.
4. **The server decides, the screen only follows.** Hiding a button is a convenience. Every rule is
   enforced in the API and proved by a test. A hidden button that a crafted request can still
   trigger counts as a bug.
5. **Everything that changes data is recorded.** Business actions go to the organization's activity
   log (inside its Durable Object). Platform actions go to the platform audit log (D1). Support
   access goes to both.
6. **Fail closed.** An unknown role, permission, setting or mode means "no".
7. **Stay on the Cloudflare free plan.** Each feature lists its cost in requests, writes and storage.

## 2. The four levels

### 2.1 Developer (super admin)

- **Who:** you. Exactly one account, identified by GitHub numeric id `SUPER_ADMIN_GITHUB_ID`.
- **Signs in:** only at `/owner`, with GitHub. A session from any other door (Clerk, passkey) never
  carries developer power, even on the same account. *Built.*
- **Job:** onboard businesses, keep the platform healthy and safe, set limits, help when asked.
- **Cannot:** read a business's data outside a support window, change a business's data at all,
  or appear in a business's member list.
- **Your own test business:** your account may be the admin of a business you made for yourself
  (like the current "Demo"). That membership is ordinary and works through ordinary sessions.
  Developer power and tenant membership never mix in one request.

### 2.2 Admin (business owner)

- **Who:** the owner of one client business. **One per organization.** A second admin is allowed
  only with explicit confirmation (for a co-owner). The last admin can never be removed or demoted.
  *Built.*
- **Job:** run their business on ShopList: team, settings, approvals, money, integrations.
- **Can:** everything inside their own organization.
- **Cannot:** see other businesses, change what a role means, or reach platform tools.

### 2.3 Staff (roles by job)

| Role | Label on screen | The job | Typical person |
|---|---|---|---|
| `manager` | Manager | Runs daily operations | Store or operations manager |
| `sales` | Sales | Sells and fulfils orders | Counter staff, order desk |
| `stock` | Stock keeper | Moves goods | Warehouse or stockroom staff |
| `accountant` | Accountant | Reads numbers, never changes operations | Bookkeeper, auditor (new in F17) |
| `viewer` | Viewer | Looks only | Owner's partner, investor, trainee |

Any staff member can additionally be **limited to some locations** (F9). For example, a stock keeper
at "Warehouse A" can see stock everywhere but can only move stock at Warehouse A.

### 2.4 External (no account)

| Who | Gets | Feature |
|---|---|---|
| A customer | A private link showing one order's status | F24 |
| A supplier | A private link to one purchase order, where they can confirm dispatch | F25 |
| Another system | An API key with narrow scopes | Built; narrower scopes in F18 |

External links are unguessable (32 random bytes), expire, can be revoked, are rate-limited, and
show the minimum: no prices for the supplier other than their own PO, no other orders for the customer.

## 3. Permissions

A **permission** is one capability. Routes declare exactly one. Roles are lists of permissions.

| Permission | Meaning | Today |
|---|---|---|
| `inventory:read` | See products, stock levels, locations, orders, history, dashboard counts | Built |
| `cost:read` | See cost price, margin and inventory value | New (F5) |
| `products:write` | Create, edit, delete, restore products; CSV import | Built |
| `stock:write` | Receive, adjust, transfer, count stock | Built |
| `orders:write` | Create orders, record payment, ship, cancel | Built |
| `customers:read` | See customer details (email, phone, address) | New (F16) |
| `purchasing:write` | Suppliers and purchase orders | New (F13) |
| `counts:assign` | Create and assign count tasks | New (F15) |
| `approvals:decide` | Approve or reject requests in the approval queue | New (F10) |
| `reports:read` | Reports and their exports | New (F12) |
| `team:manage` | Members, invitations, roles, location scoping | Split from `org:manage` (F7) |
| `settings:manage` | Business settings, locations, API keys, webhooks, support grants | Split from `org:manage` (F7) |
| `audit:read` | The organization's activity log | Split from `org:manage` (F7) |
| `org:delete` | Delete the organization | Renamed from `org:owner` (F7) |

### 3.1 The final matrix

| Permission | viewer | sales | stock | accountant | manager | admin |
|---|:-:|:-:|:-:|:-:|:-:|:-:|
| inventory:read | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| cost:read | | | | ✓ | ✓ | ✓ |
| customers:read | | ✓ | | ✓ | ✓ | ✓ |
| products:write | | | | | ✓ | ✓ |
| stock:write | | | ✓ | | ✓ | ✓ |
| orders:write | | ✓ | | | ✓ | ✓ |
| purchasing:write | | | | | ✓ | ✓ |
| counts:assign | | | | | ✓ | ✓ |
| approvals:decide | | | | | ✓ | ✓ |
| reports:read | | | | ✓ | ✓ | ✓ |
| audit:read | | | | ✓ | | ✓ |
| team:manage | | | | | | ✓ |
| settings:manage | | | | | | ✓ |
| org:delete | | | | | | ✓ |

Notes on choices that are not obvious:
- **Accountant gets `audit:read`, the manager does not.** The activity log shows who changed what,
  including managers' own changes. An accountant or auditor checking the books needs it; the person
  being audited should not control or browse it. The admin has it anyway.
- **Stock keeper does not get `customers:read`.** They pick and pack against an order number; they
  do not need a customer's email or phone.
- **Manager does not get `team:manage`.** Hiring and role changes stay with the owner. If a business
  wants a manager to invite people, the admin can add a second admin (with confirmation).
- **Some actions need approval even when the permission allows them** (F10). The permission says
  "may ask"; the approval rule says "and someone with `approvals:decide` must agree".

### 3.2 API keys

Keys never get `team:manage`, `settings:manage`, `audit:read` or `org:delete`, whatever their scopes.
Scopes after F18: `read`, `products:write`, `stock:write`, `orders:write`, `reports:read`,
`cost:read`. Old keys with `inventory:write` keep working and mean the three write scopes.

## 4. What each role sees on screen

The sidebar and buttons follow the matrix. Hidden items are also refused by the API.

| Screen / item | viewer | sales | stock | accountant | manager | admin |
|---|:-:|:-:|:-:|:-:|:-:|:-:|
| Orders list and detail | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| "New order", pay, ship, cancel | | ✓ | | | ✓ | ✓ |
| Customer email, phone, address on orders | | ✓ | | ✓ | ✓ | ✓ |
| Products list | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Cost, margin, inventory value | | | | ✓ | ✓ | ✓ |
| New, edit, delete, import products | | | | | ✓ | ✓ |
| Adjust, receive, transfer, count | | | ✓ | | ✓ | ✓ |
| Stock history | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Purchasing (suppliers, POs, reorder) | | | view POs to receive | ✓ view | ✓ | ✓ |
| Count tasks | | | my tasks | | assign and review | assign and review |
| Approvals queue | | my requests | my requests | | decide | decide |
| Reports | | | | ✓ | ✓ | ✓ |
| Activity log | | | | ✓ | | ✓ |
| Settings: my profile, sessions, passkeys, notifications | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Settings: team, invitations | | | | | | ✓ |
| Settings: business, locations, API keys, webhooks, backup, support access, delete | | | | | | ✓ |
| Platform console (`/admin`) | Developer only, through `/owner` | | | | | |

## 5. How enforcement works (and stays correct)

1. **Route declaration.** Every route is registered with exactly one access value: `public`,
   `user`, `super`, or a permission. *Built.* A test fails if any organization route is missing one.
2. **Membership check before data.** The Worker reads the caller's membership row from D1 (role,
   `deactivated_at`, `location_ids`), checks the organization is live, then checks
   `can(role, permission)`. Only then is the organization's Durable Object called. *Built,
   extended by F3 and F9.*
3. **Caller context into the Durable Object.** The Durable Object receives `{ userId, role,
   permissions, locationIds, approvalRules }` and applies the rules that need its data (location
   checks on a movement, approval thresholds on an adjustment). The Worker computed it; the object
   trusts it because only the Worker can call it.
4. **Response shaping.** Fields a role may not see (cost, customer contact details) are removed in one
   function per entity (`shapeProduct`, `shapeOrder`) before responses leave the Worker. It is used by
   every route that returns that entity, including lists, CSV export and the dashboard.
5. **Tests from the matrix.** A test reads `ROLE_PERMISSIONS` and, for every role and every
   organization route, sends a request and expects 2xx or 403 to match. Adding a route without
   updating the matrix fails the build.

## 6. Activity log entries

Every new action in this plan writes one entry with: actor (user id, or `support:<developer>`,
or `key:<prefix>`, or `system`), action, entity, entity id, field-level changes, request id, time.
Approvals record both the requester and the approver. Support access records every request made in
the window, including reads.

---

# 02 · Phase 1: foundations (F1–F7)

**Goal:** close the gaps that make the levels leaky, and give the developer and admins the basic
tools to run people properly. Nothing new for day-to-day staff work except cost hiding.

**Order:** F7 first (internal refactor everything else builds on), then F1, F2, F3, F4, F5, F6.
**Estimate:** about 1.5 weeks.

---

## F7 · Permission split

**Why.** `org:manage` currently bundles three different powers: managing people, managing settings
and reading the activity log. The new matrix gives the accountant the log without people or settings.
`org:owner` is renamed `org:delete` because "owner" no longer exists as a role.

**How it works.** No visible change. Routes move to the narrower permission:

| Route group | Before | After |
|---|---|---|
| Members, invitations | `org:manage` | `team:manage` |
| Org name, locations, API keys, webhooks | `org:manage` | `settings:manage` |
| Activity log | `org:manage` | `audit:read` |
| Delete organization | `org:owner` | `org:delete` |

**API keys.** The rule "keys may never use `team:manage`, `settings:manage`, `audit:read`,
`org:delete`" replaces today's "never `org:*`".

**Tests.** The existing role-walk test is extended to the new permissions. Docs test updated.
**Done when:** all tests pass with no behaviour change for any existing role. **Effort:** S.

---

## F1 · Onboard a business; stop self-serve org creation

**Why.** Two real problems:
1. Any signed-in person can call `POST /orgs` and become admin of a brand-new organization. That
   includes invited staff, so "invite-only" does not cover organization creation.
2. There is no clean way to bring in a new client business. Only an org's admin can invite, so the
   first admin of a new business has nobody to invite them, unless the developer creates the org and
   becomes its admin, which breaks the "developer is not a tenant member" rule.

**Who.** The developer creates the business. The new admin accepts.

**How it works.**
1. You open **Platform → Businesses → Onboard a business**.
2. You enter the business name, the admin's email, the currency (default USD), and optionally a
   plan (F20; default "Free").
3. The server creates the organization with **no members** and status `pending`, plus an invitation
   for that email with role `admin`. It returns the invitation link.
4. You send the link (or simply tell them to sign in; F-built auto-accept handles it).
5. The admin signs in with Google or email (Clerk). The pending invitation is accepted automatically,
   they become the admin, and the organization's status becomes `active`.
6. In **invite mode**, `POST /orgs` from an ordinary session returns `403 org_creation_closed`. In
   **open mode** (never production) self-serve stays available for testing.
7. A signed-in person with no organization sees "You are not part of a business yet. Ask your admin
   to invite you, or contact the ShopList owner." instead of the "create an organization" form.

**Screens.**
- Platform console: "Onboard a business" form; Businesses list gains a **Status** column
  (Pending, Active, Suspended) and "Resend invitation" for pending ones.
- Home page (no organization): the new message, no form, in invite mode.

**API.**
- `POST /admin/orgs` (super) `{ name, adminEmail, currency?, plan? }` → `201 { organization, invitation: { link, expiresAt } }`
- `POST /admin/orgs/:id/resend-invitation` (super) → new link, old one revoked.
- `POST /orgs` → `403 org_creation_closed` unless `SIGNIN_MODE=open`.

**Data.** `organizations.status` is derived, not stored: `pending` when there are no members and an
open admin invitation exists; `suspended` from `suspended_at`; otherwise `active`. The invitation
reuses the existing `invitations` table (`invited_by` = the developer's user id).

**Rules and edge cases.**
- The admin email cannot be the developer's own email (that account is GitHub-only): `409 email_in_use`.
- If the email already belongs to a disabled user: refuse with a clear message.
- If the invitation expires (7 days), the business stays `pending`; "Resend" makes a fresh one.
- A pending business with no members for 30 days is listed under "Stale" so you can delete it.
- Your own test businesses created earlier stay as they are (you are their admin).

**Security.** Only `super` sessions (GitHub door) can call `/admin/orgs`. Platform audit entry:
`org.onboarded` with name and the admin email's domain only (not the full address).

**Tests.**
- An invited staff member gets 403 on `POST /orgs` in invite mode.
- Onboarding creates an org with zero members; the developer is not a member; the developer gets
  404 on `/orgs/:id/products`.
- The invited admin signs in through Clerk and lands as `admin`; status becomes `active`.
- A non-super session gets 404 on `/admin/orgs`.

**Done when:** you can onboard a business end to end without being its member, and nobody else can
create one. **Effort:** M.

---

## F2 · Pending invitations: list, resend, revoke

**Why.** Today an invitation cannot be seen or cancelled after it is created. A typo in an email
leaves a live invitation for 7 days.

**Who.** Admin (`team:manage`).

**How it works.** Settings → Team shows two lists: **Members** and **Pending invitations** (email,
role, invited by, expires in N days). Each pending row has **Copy link**, **Resend** and **Revoke**.

- **Resend** revokes the old token and creates a new one with a fresh 7-day expiry (tokens are only
  stored as hashes, so the old link cannot be shown again).
- **Revoke** marks it revoked; the link and auto-accept stop working at once.
- Inviting an email that already has a pending invitation for this organization replaces it instead
  of creating a duplicate.
- Inviting an existing member returns `409 already_member`.

**API.**
- `GET /orgs/:id/invitations` → pending, unexpired, unrevoked only.
- `POST /orgs/:id/invitations/:invId/resend` → `{ link, expiresAt }`
- `DELETE /orgs/:id/invitations/:invId`

**Data.** `invitations` gains `id` (public identifier; the token hash stays the key), `revoked_at`,
`created_at`. Migration fills `id` and `created_at` for existing rows.

**Security.** The invitation token is never returned by the list endpoint. The id is not the token.

**Tests.** Revoked invitation cannot be accepted by link or by sign-in; resend invalidates the old
link; duplicates replaced; a manager gets 403 on all three routes.
**Done when:** an admin can see and cancel every outstanding invitation. **Effort:** S.

---

## F3 · Member lifecycle: deactivate, reactivate, hand over admin

**Why.** Staff leave. Removing them deletes the membership row, but their name must remain on the
history they created, and sometimes they come back. Owners also sell or hand over businesses.

**Who.** Admin; the developer for the "admin has left" case.

**How it works.**
- **Deactivate** a member: they keep their place in history and the member list (marked
  "Deactivated"), but every request to this organization returns 404 for them, and their sessions
  stop working for this organization at once. Other organizations they belong to are unaffected.
- **Reactivate**: restores access with the same role.
- **Remove** (existing): for people added by mistake. Requires that they have no recorded actions;
  otherwise the screen suggests Deactivate.
- **Hand over admin**: the admin picks an active member and types the business name to confirm. In
  one transaction, that member becomes admin and the current admin becomes manager.
- **Developer transfer**: if the only admin is disabled or unreachable, the developer can make
  another existing member the admin from the business detail page (F6). This changes a role only;
  no tenant data is shown or touched.

**API.**
- `POST /orgs/:id/members/:userId/deactivate`, `POST …/reactivate` (`team:manage`)
- `POST /orgs/:id/admin-handover { userId, confirmName }` (`team:manage`)
- `POST /admin/orgs/:id/transfer-admin { userId }` (super)

**Data.** `memberships.deactivated_at`.

**Rules.**
- The last active admin cannot be deactivated.
- A deactivated member cannot be given a role until reactivated.
- Pending approvals requested by a deactivated member stay in the queue, labelled.
- Count tasks assigned to them are unassigned (F15).

**Tests.** Deactivated member gets 404 on the next request; reactivation restores it; handover swaps
roles atomically; the developer transfer works without the developer gaining membership.
**Done when:** people can leave and return without losing history, and a business can never be left
without an admin. **Effort:** M.

---

## F4 · Member privacy

**Why.** `GET /members` is open to every role today, including email addresses. Staff do not need
each other's emails.

**How it works.** With `team:manage` the list has name, email, role, status and last active. Without
it, the list has name and role only (needed for "who did this" in history and for assigning count
tasks).

**API.** Same route; the response is shaped by permission.
**Tests.** A sales user's response has no `email` field. **Effort:** S.

---

## F5 · Cost visibility

**Why.** Cost price, margin and inventory value are commercially sensitive. Today every member,
including sales and viewers, can see them.

**Who.** `cost:read`: accountant, manager, admin.

**How it works.** For everyone else:
- `costMinor` is removed from every product response (list, detail, lookup, dashboard "needs
  attention", order lines, webhooks configured by them are unaffected because only admins configure
  webhooks).
- `inventoryValueMinor` is removed from the dashboard and the sidebar's "Inventory value" panel is hidden.
- The product dialog hides the Cost field; CSV export omits the cost column.
- Reports that show margin or valuation require `cost:read` (F12).
- Writes: a manager editing a product can set cost; nobody without `cost:read` can send `costMinor`
  (400 `field_not_allowed`), so a sales user cannot overwrite it blindly.

**Implementation.** One `shapeProduct(product, perms)` function in the Worker used by every route
returning products. The Durable Object always returns the full record; shaping happens on the way out.

**Tests.** For each product-returning route, a sales user's response contains no `costMinor` and no
`inventoryValueMinor`; a manager's does.
**Done when:** no response to a role without `cost:read` contains cost data. **Effort:** M.

---

## F6 · Developer: business and user detail pages

**Why.** The platform console has lists but no detail. To support a business you need to see its
health without seeing its data.

**Business detail page** (`/admin/orgs/:id`):
- Name, status, created, plan and limits (F20), admin's name and email, member count by role.
- Counts only: products, locations, open orders, API keys, webhooks. Last activity time.
- Actions: suspend or restore *(built)*, resend admin invitation (F1), transfer admin (F3),
  change plan (F20), delete (F27).
- It never shows product names, prices, customers or orders.

**User detail page** (`/admin/users/:id`):
- Name, email, sign-in methods (GitHub, Clerk, passkeys count), created, disabled state.
- Businesses and roles. Active sessions (device, country, last active) with "sign out everywhere".
- Recent sign-in events (F22).
- Actions: disable or enable *(built)*, sign out everywhere.

**API.** `GET /admin/orgs/:id`, `GET /admin/users/:id`, `POST /admin/users/:id/sign-out`.
Counts come from a new Durable Object method `stats()` returning numbers only.

**Tests.** Detail responses contain no product or customer fields; non-super gets 404.
**Done when:** you can answer "is this business healthy and who runs it?" without tenant data.
**Effort:** M.

---

## Phase 1 exit checklist

- [ ] All seven features merged, each with tests.
- [ ] Role walk test covers every route and role.
- [ ] Docs (SECURITY, API, DATA_MODEL) updated.
- [ ] Deployed; live smoke test of onboarding a test business with a second email of yours.

---

# 03 · Phase 2a: running the business (F8–F18)

**Goal:** give each job the tools it actually needs: settings for the admin; approvals, reports,
purchasing and counts for the manager; customers and invoices for sales; tasks and scoped access for
the stock keeper; read-only numbers for the accountant.

**Order:** F8 → F17 → F9 → F11 → F10 → F12 → F13 → F14 → F15 → F16 → F18.
Settings first (others read them), the accountant role early (small, and reports need it),
notifications before approvals (approvals notify), rollups before reorder suggestions (they use them).
**Estimate:** 5–6 weeks.

---

## F8 · Business settings

**Why.** Currency is fixed at USD today and there is nowhere to put tax, numbering or the business's
own details, which invoices (F16) and reports (F12) need.

**Who.** Admin (`settings:manage`). Everyone reads the parts that affect display (currency, timezone).

**Settings (Settings → Business):**

| Group | Field | Default | Used by |
|---|---|---|---|
| Identity | Legal name, address, phone, email, tax id (e.g. GSTIN, VAT no.), logo (later) | empty | Invoices, PO links |
| Money | Currency (ISO code) | USD | Every price display |
| Money | Tax mode: none, inclusive, exclusive | none | Orders, invoices |
| Money | Default tax rate (basis points, e.g. 1800 = 18%) | 0 | Orders |
| Time | Timezone (IANA, e.g. Asia/Kathmandu) | UTC | Reports' day boundaries, dates |
| Numbering | Order prefix (e.g. `SO-`), PO prefix (`PO-`), invoice prefix (`INV-`) | `#`, `PO-`, `INV-` | Numbers |
| Stock | Default reorder point for new products; allow negative stock (off) | 0, off | Products, movements |
| Approvals | Rules (F10) | off | Approvals |

**Changing currency** after data exists is allowed only while the business has no orders, because
existing prices would silently change meaning. After that, the field is locked with an explanation.

**API.** `GET /orgs/:id/settings` (`inventory:read`, identity fields shaped for staff),
`PATCH /orgs/:id/settings` (`settings:manage`, validated, partial).
**Data.** `organizations.settings` JSON (validated by a Zod schema in `shared`), copied into the
Durable Object on change so it can apply rules without a D1 read per request.
**Tests.** Validation; currency lock; timezone affects report day boundaries; a manager gets 403 on PATCH.
**Effort:** M.

---

## F17 · Accountant role

**Why.** Bookkeepers and auditors need numbers (costs, valuation, reports, the activity log) without
the ability to change stock or orders.

**How it works.** A new role `accountant` with the permissions in the permission matrix in "The access model" (section 3.1).
Admins can invite or assign it like any other role.

**Data.** Migration adds `accountant` to the role CHECK on `memberships` and `invitations` (same
pattern as migration 0005).

**Tests.** Role walk test includes the new role automatically. **Effort:** S.

---

## F9 · Location scoping for staff

**Why.** A business with a shop and a warehouse does not want warehouse staff adjusting shop stock,
or a branch's sales staff shipping from another branch.

**Who.** The admin sets it per member. It applies to staff roles; admins are never scoped.

**How it works.**
- Settings → Team → a member → **Locations**: "All locations" (default) or a checklist.
- A scoped member can **see** stock at every location (so they can say "it's in the warehouse"),
  but every **write** is limited:
  - stock movements and counts: `locationId` must be in their list;
  - transfers: the **source** location must be in their list (they can send to anywhere);
  - orders: the fulfilment location must be in their list;
  - receiving a PO: the PO's location must be in their list.
- The UI pre-selects their location and hides others in location pickers for writes.

**API.** `PATCH /orgs/:id/members/:userId { locationIds: string[] | null }` (`team:manage`).
Violations: `403 location_not_allowed`.
**Data.** `memberships.location_ids` (JSON array or null); invitations can carry it too.
The Worker passes `locationIds` in the caller context; the Durable Object checks it in the same
transaction as the write.
**Edge cases.** Archiving a location removes it from everyone's list; a member left with an empty
list is treated as "no write access" (not "all"), and the admin is warned.
**Tests.** Scoped stock keeper: 201 at A, 403 at B, transfer A→B allowed, B→A refused; order at B refused.
**Effort:** M.

---

## F11 · In-app notifications

**Why.** People need to know when something needs them: stock is low, an order arrived, an approval
waits, a count task was assigned. Today nothing tells them.

**Who.** Everyone, each for what is relevant to their role.

**Events and who receives them (defaults; each person can switch kinds off):**

| Event | Sent to |
|---|---|
| Product went low or out of stock | manager, admin, and stock keepers scoped to that location |
| New order (from API or another user) | sales, manager |
| Order waiting for stock became ready to ship | sales, manager |
| Approval request created | everyone with `approvals:decide` |
| My approval request was decided | the requester |
| Count task assigned to me / overdue | the assignee; overdue also to the assigner |
| PO received in full or partly | the manager who created it |
| Invitation accepted | admin |
| Webhook failing repeatedly | admin |

**How it works.**
- A bell icon in the top bar with an unread count. Clicking opens a panel: newest first, grouped by
  day, each item links to the thing (order, product, approval).
- "Mark all as read". Items older than 60 days are deleted automatically.
- Settings → Notifications: per kind on or off. (Email delivery is F23.)
- The page refreshes the count every 60 seconds while visible (no WebSockets needed; cheap).

**Architecture.** The Durable Object already records events in its **outbox** for webhooks. The
queue consumer that delivers webhooks will also turn relevant events into notification rows, choosing
recipients from D1 memberships (role, location scope, preferences). This keeps the write path fast:
the user's request never waits for notifications.

**API.** `GET /me/notifications?cursor=` , `GET /me/notifications/unread-count`,
`POST /me/notifications/read { ids? }` (all if empty), `GET/PATCH /me/notification-preferences`.
**Data.** D1 `notifications(id, user_id, org_id, kind, title, link, payload, created_at, read_at)`,
D1 `notification_prefs(user_id, org_id, kind, enabled)`.
**Free plan.** One notification row per recipient per event. A busy shop with 300 orders a day and 3
sales staff is about 1,000 writes a day, well inside D1's 100,000.
**Tests.** Recipients chosen by role and scope; preferences respected; read state per user; a user
never sees another organization's notifications.
**Effort:** M.

---

## F10 · Approval rules and the approval queue

**Why.** Some actions are risky enough that one person should not do them alone: large stock
write-downs (shrinkage hides theft), damage write-offs, and cancelling an order after payment
(refund fraud). Managers and owners want to see and sign off on these.

**Who.** Requesters: anyone with the underlying permission but without `approvals:decide`.
Deciders: manager, admin. Admin configures the rules.

**Rules the admin can turn on (Settings → Business → Approvals):**

| Rule | Trigger | Default when switched on |
|---|---|---|
| Large adjustment | A negative adjustment of more than N units **or** worth more than X (at cost) | N = 20, X = 500.00 |
| Damage write-off | Any movement with reason `damage` | always |
| Count variance | A count that changes stock by more than N units or X% | N = 20 |
| Cancel paid order | Cancelling an order already marked paid | always |
| Price drop | Lowering a product's price by more than X% | 30% |

People with `approvals:decide` are never asked for approval; their action applies directly and is
logged as usual.

**How it works.**
1. A stock keeper records "-35 units, damage". The server sees a rule applies.
2. Instead of applying it, the server stores an **approval request** with the exact validated input
   and returns `202 Accepted { approval }`. The screen says "Sent for approval" with a link.
3. Managers and the admin get a notification. **Approvals** in the sidebar shows a badge.
4. The decider sees what was asked, by whom, the current stock, and the effect. They **Approve**
   (optionally with a note) or **Reject** (note required).
5. On approve, the server re-checks the action against **current** data (stock may have changed) and
   applies it through the same code path as a direct action, in one transaction. The ledger and
   activity log record both the requester and the approver.
6. If the re-check fails (for example the product was deleted), the request becomes `failed` with the
   reason, and the requester is notified.
7. The requester sees "My requests" with statuses. They can **withdraw** a pending request.
8. Requests expire after 7 days if nobody decides.

**States.** `pending → approved → applied`, `pending → rejected`, `pending → withdrawn`,
`pending → expired`, `approved → failed`.

**API.**
- Existing write routes may return `202 { approval }` instead of `201`.
- `GET /orgs/:id/approvals?state=&mine=` (requesters see their own; deciders see all)
- `POST /orgs/:id/approvals/:aid/approve { note? }`, `…/reject { note }`, `…/withdraw`
**Data.** Durable Object `approval_requests(id, kind, payload JSON, summary, requested_by, state,
decided_by, note, created_at, decided_at, expires_at, result_ref)`. Rules live in settings (F8).
**Rules and edge cases.**
- A requester cannot approve their own request, even if they later become a manager.
- Idempotency: approving twice applies once.
- The payload is validated again at approval time with the current schema.
- Large-adjustment value uses cost at the time of the request; if cost is unknown, only the unit
  threshold applies.
**Security.** Approval decisions are `approvals:decide` and audited; the payload cannot be edited
by the decider (approve or reject only, so the decider cannot change what is applied).
**Tests.** Each rule triggers; deciders bypass; approve applies exactly once; stale approve fails
cleanly; self-approval refused; expiry job works.
**Effort:** L.

---

## F12 · Reports

**Why.** Owners and managers make decisions from numbers: what sells, what sits, what goes missing,
what stock is worth. The accountant needs the same numbers for the books.

**Who.** `reports:read` (accountant, manager, admin). Money columns based on cost need `cost:read`
(all three have it).

**Reports (each with a date range, location filter, and CSV export):**

| Report | Shows | Question it answers |
|---|---|---|
| Sales summary | Per day: orders shipped, units, revenue, tax; totals | How much did we sell? |
| Sales by product | Units and revenue per product, ranked; margin when cost known | What sells? |
| Stock valuation | On hand × cost per product and location, as of now | What is our stock worth? |
| Movement summary | Units in and out by reason (receive, sale, return, adjust, damage, count, transfer) | Where did stock go? |
| Low and out of stock | Products under reorder point, with days of cover | What do we need? |
| Dead stock | Products with stock but no sale in N days (30/60/90), with value tied up | What isn't moving? |
| Shrinkage | Damage, negative adjustments and count losses, by product and person | What are we losing, and where? |
| Staff activity | Actions per person per day (orders, movements, approvals) | Who did what? (admin only) |

**Screens.** Reports page with a list of reports; each opens a filter bar, a summary row, a simple
chart (bars for days, no chart library: CSS bars) and a table. "Export CSV" downloads exactly what is
shown.

**Architecture: daily rollups.** Computing reports from the raw ledger gets slow as it grows. The
Durable Object will maintain a small table `daily_stats(day, product_id, location_id, sold_qty,
sold_minor, tax_minor, received_qty, returned_qty, adjusted_qty, damaged_qty, count_delta,
transfer_in, transfer_out)`, updated **in the same transaction** as each movement or shipment, so
it is always exact. "Day" uses the business's timezone (F8). A one-time backfill builds it from the
existing ledger when the migration runs. Reports read the rollup (hundreds of rows) instead of the
ledger (possibly hundreds of thousands).

**Limits.** Date range up to 366 days per request. CSV export up to 50,000 rows.
**API.** `GET /orgs/:id/reports/:name?from=&to=&location=&format=json|csv`.
**Tests.** Rollup equals a fresh computation from the ledger (an invariant check like I1); timezone
boundaries; permissions; CSV matches JSON.
**Effort:** L.

---

## F13 · Suppliers and purchase orders

**Why.** Stock arrives from suppliers. Today it is typed in as "receive" with no link to what was
ordered, so nobody knows what is on the way, what arrived short, or what it cost.

**Who.** Manager and admin create suppliers and POs (`purchasing:write`). Stock keepers receive
against them (`stock:write`). Accountant reads.

**How it works.**
1. **Suppliers**: name, contact, email, phone, lead time (days), notes. Products get an optional
   preferred supplier, supplier SKU and supplier price.
2. **Create a PO**: choose supplier and receiving location; add lines (product, quantity, unit cost;
   cost pre-filled from the supplier price). Optional expected date and note. Status `draft`.
3. **Send**: status `sent`. The PO shows a printable view (and in F25 a supplier link). The
   quantities now count as **on order** on the product screen.
4. **Receive**: a stock keeper opens the PO (or scans a product while a PO is open), enters received
   quantities per line. Each receipt writes `receive` movements referencing the PO, in one
   transaction. Partial receipts are allowed; status becomes `partially_received`, then `received`
   when all lines are complete. Over-receipt beyond 10% needs `approvals:decide` or an approval.
5. **Cost update**: each receipt updates the product's cost to the received unit cost (last cost).
   (Weighted average cost is a setting for later; see decisions.)
6. **Cancel or close short**: a manager can cancel a draft/sent PO or close a partly received one
   ("supplier won't send the rest"); remaining quantities stop counting as on order.

**Numbers.** `PO-0001` style, from the prefix in settings.
**API.** `/orgs/:id/suppliers` (CRUD), `/orgs/:id/purchase-orders` (list, create, get, patch while
draft), `POST …/:poId/send`, `POST …/:poId/receive { lines: [{ lineId, quantity }] }`,
`POST …/:poId/cancel`, `POST …/:poId/close`.
**Data.** Durable Object tables `suppliers`, `purchase_orders`, `po_lines`; products gain
`supplier_id`, `supplier_sku`, `supplier_price_minor`, `on_order` (maintained counter).
**Tests.** Partial and full receipts; on-order counter invariant; scoped stock keeper limited to the
PO's location; cancelled POs cannot be received; receipts idempotent.
**Effort:** L.

---

## F14 · Reorder suggestions

**Why.** "What should I order, and how much?" is the question every shop owner asks weekly.

**Who.** Manager, admin.

**How it works.** **Purchasing → Reorder** lists products where *available + on order* is below the
reorder point, or where projected stock runs out within the supplier's lead time. For each:

- **Average daily sales** over the last 30 days (from `daily_stats`).
- **Days of cover** = available ÷ average daily sales.
- **Suggested quantity** = average daily sales × (lead time + 14 days of cover) − (available + on order),
  rounded up, never below zero; if there are no sales, it tops up to the reorder point.

The manager ticks lines and clicks **Create purchase orders**: one draft PO per supplier, which they
review and send. Formula constants (14 days) are a business setting.

**API.** `GET /orgs/:id/purchasing/reorder`, `POST /orgs/:id/purchasing/reorder/draft { productIds }`.
**Tests.** Formula on fixed data; products without a supplier listed separately; drafts grouped by supplier.
**Effort:** M.

---

## F15 · Count tasks

**Why.** Full stocktakes stop the business. Counting a few products often (cycle counting) catches
errors early. It needs to be assigned and tracked, and counts are more honest when the counter does
not see the expected number.

**Who.** Manager and admin assign (`counts:assign`); stock keepers count.

**How it works.**
1. The manager creates a task: location, which products (all, a tag, a list, or "not counted in 30
   days"), assignee, due date, and **blind** (on by default: the counter does not see expected
   quantities).
2. The assignee sees it under **My tasks**, opens it on a phone, scans or searches each product and
   enters the counted quantity.
3. Submitting writes `count` movements only for differences, through the existing counts logic
   (and approvals for big variances, F10).
4. The manager sees a summary: products counted, variances, value of the variance.
5. Overdue tasks notify the assignee and assigner (F11).

**API.** `/orgs/:id/count-tasks` (create, list, get), `POST …/:taskId/lines { productId, counted }`
(save progress), `POST …/:taskId/submit`, `POST …/:taskId/cancel`.
**Data.** Durable Object `count_tasks`, `count_task_lines (expected snapshot at submit time, counted)`.
**Edge cases.** Stock that moves during counting: expected is taken at submit, not at creation, and
movements in between are shown to the manager.
**Tests.** Blind tasks never return expected quantities to the assignee; only the assignee or a
manager can submit; variances become exact count movements.
**Effort:** M.

---

## F16 · Customers, tax and printable invoices and receipts

**Why.** Sales staff repeat-type the same customers, cannot see a customer's history, and cannot give
a customer a proper invoice. Many countries require tax shown on invoices.

**Who.** Sales, manager, admin. Contact details need `customers:read`.

**How it works.**
- **Customers**: name, email, phone, address, tax id, note. Created automatically from the first
  order with a new email, or by hand. The order form searches customers as you type.
- **Customer page**: their orders, total spent, last order date.
- **Tax** (from settings, F8): each order line stores the tax rate applied; the order stores
  subtotal, tax and total. In inclusive mode prices already include tax; in exclusive mode tax is added.
- **Invoice and receipt**: an order's **Print** button opens a clean printable page (business
  details, customer, lines, tax, totals, invoice number, date) that uses the browser's own
  "Save as PDF". No PDF library, so no bundle growth. Invoice number = prefix + order number.
  "Receipt" is the same page titled Receipt, shown once paid.
- Old orders without a customer are linked by a one-time migration that groups by email (or name
  when there is no email).

**API.** `/orgs/:id/customers` (CRUD, search), orders accept `customerId`, `GET /orgs/:id/orders/:oid/document?type=invoice|receipt`.
**Data.** Durable Object `customers`; `orders.customer_id`, `subtotal_minor`, `tax_minor`, `total_minor`; `order_lines.tax_rate_bp`.
**Tests.** Tax math in both modes (rounding per line, half-up); invoice totals equal order totals;
stock keepers get no contact fields.
**Effort:** L.

---

## F18 · Narrower API key scopes

**Why.** An online store integration needs to create orders, not edit products. A reporting tool
needs to read, not write. Today a key is either read or read+write everything.

**How it works.** Creating a key shows checkboxes: Read inventory (always), Write products, Write
stock, Write orders, Read reports, See costs. Optional location limit and expiry (built).
Existing `inventory:write` keys keep working as "all three writes".

**Tests.** Each scope allows exactly its routes; old keys unchanged. **Effort:** S.

---

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

---

# 05 · Phase 3: reach and resilience (F23–F30)

**Goal:** reach people outside the app (email, customers, suppliers) and make the platform
recoverable. Each item is independent; build them in any order once Phase 2 is done.
**Estimate:** about 2 weeks.

---

## F23 · Email notifications

**Why.** In-app notifications only help people who have the app open. Owners want a morning summary;
an approval request should reach a manager who is not logged in.

**How it works.**
- Each notification kind (F11) gets a second switch: "Email me". Defaults: approvals and your own
  decided requests by email; everything else in-app only.
- **Daily digest** (optional, per person): one email at 08:00 in the business's timezone listing
  low stock, pending approvals, overdue counts and yesterday's sales (sales only for people with
  `reports:read`).
- Invitations (F1, F2) are emailed automatically instead of only showing a link.
- Every email has a one-click unsubscribe for that kind.

**Architecture.** A queue consumer sends through an email provider's HTTP API (decision D4; suggested
Resend, free tier 3,000 emails per month, 100 per day). A sending domain with SPF and DKIM is needed
for deliverability. Emails are plain, accessible HTML plus text; no tracking pixels.
**Limits.** Per-business daily cap so one business cannot use the whole allowance.
**Tests.** Rendering snapshots; unsubscribe tokens; caps; the provider client is mocked.
**Effort:** M. **Needs:** email provider account, API key, and a domain you control.

---

## F24 · Customer order-status link

**Why.** Customers ask "where is my order?". A link answers without a call.

**How it works.** On an order, sales clicks **Share status link**. The link shows: business name,
order number, date, status (received, paid, ready, shipped, cancelled), line items and quantities, and
totals. It does **not** show other orders, cost, staff names or internal notes. Optional: include the
invoice download. Links expire 90 days after the order is shipped or cancelled and can be revoked.

**Security.** 32-byte random token, stored hashed; page served with `noindex`, no-referrer, and
rate-limited per IP.
**API.** `POST /orgs/:id/orders/:oid/share` → link; `DELETE …/share`; public `GET /s/o/:token`.
**Effort:** S.

---

## F25 · Supplier purchase-order link

**Why.** Suppliers need the PO; emailing PDFs by hand is slow and error-prone.

**How it works.** On a sent PO, **Share with supplier** creates a link showing the business name and
address, PO number, lines with the supplier's SKU, quantities and agreed unit cost, expected date and
note. The supplier can click **Confirm** and **Mark dispatched** with an optional tracking note; each
click updates the PO and notifies the manager. Nothing else is visible or changeable.
**API.** `POST /orgs/:id/purchase-orders/:poId/share`, public `GET /s/po/:token`,
`POST /s/po/:token/confirm`, `POST /s/po/:token/dispatched`.
**Effort:** S.

---

## F26 · Restore from a backup file

**Why.** The JSON backup (built) is only useful if it can be loaded back.

**How it works.** Settings → Backup → **Restore**: upload a ShopList backup file. The server
validates it, then shows a preview ("1,502 products and 3 locations; 40 products already exist and will
be updated"). Two modes:
- **Merge** (default): creates missing products and locations, updates matching SKUs, and sets
  quantities with `count` movements so the ledger explains every change.
- **Into a new business**: for the developer, restores into a fresh organization (used for the
  restore rehearsal in F29).
Large files are processed in batches through the queue, with progress.
**Rules.** Admin only; a file from another business is accepted (it is the admin's data) but shows a
warning; the version field must be supported.
**Effort:** M.

---

## F27 · Delete with a 14-day grace period

**Why.** Deleting a business today hides it immediately and permanently from users. A mistake or a
malicious admin can wipe a business.

**How it works.** Delete asks the admin to type the business name. The business enters
`scheduled_for_deletion` with a date 14 days away; everyone gets a banner and the business is
read-only. The admin (or you) can **Cancel deletion**. After 14 days a daily job removes D1 rows and
deletes the Durable Object's storage. A final backup is offered for download first.
**Effort:** S.

---

## F28 · Announcements and maintenance mode

**Why.** You need to tell users about planned changes, and to stop writes safely during risky
migrations.

**How it works.**
- **Announcements**: text, severity (info, warning), audience (everyone, admins only, one business),
  start and end time. Shown as a dismissible banner.
- **Maintenance mode**: platform-wide or one business. All writes return `503 maintenance` with
  `Retry-After`; reads keep working; a banner explains. Turned on and off from the console and
  logged.
**Effort:** S.

---

## F29 · Nightly backups to R2

**Why.** Today recovery relies on Cloudflare's built-in point-in-time recovery and manual JSON
downloads. A separate copy, kept 30 days, protects against mistakes and bugs.

**How it works.** A scheduled job at 02:00 UTC exports the D1 control plane and each business's
Durable Object (products, locations, stock, ledger, orders, customers, POs, settings) as compressed
JSON Lines into R2, one object per business per day. Objects older than 30 days are deleted by an R2
lifecycle rule. The console shows the last backup time and size per business and alerts on failure.
A **restore rehearsal** each quarter restores one business into a new test business (F26) and
records the result in the docs.
**Free plan.** R2 free tier: 10 GB storage, 1 million writes per month. A few hundred businesses fit easily.
**Needs:** an R2 bucket (decision D5).
**Effort:** M.

---

## F30 · Audit export and retention

**Why.** Logs grow forever today. Businesses and auditors may need exports; privacy law favours not
keeping data longer than needed.

**How it works.** Activity log and platform audit log get **Export CSV** for a date range. Retention:
business activity log kept 2 years by default (setting, 1–7 years), platform audit 1 year, sign-in
events 90 days, notifications 60 days. A daily job deletes older rows in small batches.
**Effort:** S.

---

# 06 · Data and API reference

Everything the plan adds, in one place. Feature files explain *why*; this file lists *what*.

Rules for every change:
- **Additive only.** New tables and nullable or defaulted columns. Old code keeps working after a
  migration runs, so a migration can be applied before the deploy that uses it.
- **D1 migrations** live in `apps/api/migrations/control/` and are applied with
  `wrangler d1 migrations apply` before deploying.
- **Durable Object migrations** are appended steps in `inventory-do.ts` (current last step: 4). Each
  runs once per business, the first time that business's object wakes up after the deploy.
- Role CHECK changes rebuild the table (the 0005 pattern), because SQLite cannot alter a CHECK.

## 1. D1 (control plane) migrations

| # | Feature | Change |
|---|---|---|
| 0006 | F2 | `invitations`: add `id TEXT UNIQUE`, `created_at TEXT`, `revoked_at TEXT`; backfill `id`, `created_at` |
| 0007 | F3, F9 | `memberships`: add `deactivated_at TEXT`, `location_ids TEXT` (JSON or NULL); `invitations`: add `location_ids TEXT` |
| 0008 | F8, F20, F27 | `organizations`: add `settings TEXT NOT NULL DEFAULT '{}'`, `plan_id TEXT NOT NULL DEFAULT 'free'`, `plan_overrides TEXT`, `delete_after TEXT` |
| 0009 | F17 | Rebuild `memberships` and `invitations` with `accountant` in the role CHECK |
| 0010 | F11 | `notifications`, `notification_prefs` |
| 0011 | F20 | `plans` (seeded with free, standard) |
| 0012 | F22 | `auth_events` |
| 0013 | F19 | `support_grants` |
| 0014 | F24, F25 | `share_links(token_hash PK, org_id, kind, ref_id, created_by, created_at, expires_at, revoked_at)` |
| 0015 | F28 | `announcements`, `maintenance(scope, org_id, on_since, by)` |

New D1 tables in full:

```sql
CREATE TABLE notifications (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL, link TEXT, payload TEXT,
  created_at TEXT NOT NULL, read_at TEXT
);
CREATE INDEX notifications_user ON notifications(user_id, created_at DESC);
CREATE INDEX notifications_unread ON notifications(user_id) WHERE read_at IS NULL;

CREATE TABLE notification_prefs (
  user_id TEXT NOT NULL, org_id TEXT NOT NULL, kind TEXT NOT NULL,
  in_app INTEGER NOT NULL DEFAULT 1, email INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, org_id, kind)
);

CREATE TABLE plans (id TEXT PRIMARY KEY, name TEXT NOT NULL, limits TEXT NOT NULL, features TEXT NOT NULL);

CREATE TABLE auth_events (
  id TEXT PRIMARY KEY, created_at TEXT NOT NULL, kind TEXT NOT NULL, door TEXT,
  user_id TEXT, email_hash TEXT, country TEXT, browser TEXT, reason TEXT
);
CREATE INDEX auth_events_time ON auth_events(created_at DESC);
CREATE INDEX auth_events_user ON auth_events(user_id, created_at DESC);

CREATE TABLE support_grants (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  granted_by TEXT NOT NULL REFERENCES users(id), note TEXT, include_customers INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, expires_at TEXT NOT NULL, ended_at TEXT
);
```

## 2. Durable Object (per business) migrations

| Step | Feature | Change |
|---|---|---|
| 5 | F8 | `settings` copy in `meta` (key `settings`), refreshed on change |
| 6 | F10 | `approval_requests` |
| 7 | F12 | `daily_stats` + backfill from `stock_movements` and shipped orders |
| 8 | F13 | `suppliers`, `purchase_orders`, `po_lines`; products: `supplier_id`, `supplier_sku`, `supplier_price_minor`, `on_order INTEGER NOT NULL DEFAULT 0`; movements: `ref_type`, `ref_id` |
| 9 | F15 | `count_tasks`, `count_task_lines` |
| 10 | F16 | `customers`; orders: `customer_id`, `subtotal_minor`, `tax_minor`, `total_minor`; order_lines: `tax_rate_bp`; backfill customers from existing orders |

Key tables:

```sql
CREATE TABLE approval_requests (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL, summary TEXT NOT NULL,
  requested_by TEXT NOT NULL, state TEXT NOT NULL CHECK (state IN
    ('pending','approved','applied','rejected','withdrawn','expired','failed')),
  decided_by TEXT, note TEXT, result_ref TEXT,
  created_at TEXT NOT NULL, decided_at TEXT, expires_at TEXT NOT NULL
);
CREATE INDEX approvals_state ON approval_requests(state, created_at DESC);

CREATE TABLE daily_stats (
  day TEXT NOT NULL, product_id TEXT NOT NULL, location_id TEXT NOT NULL,
  sold_qty INTEGER NOT NULL DEFAULT 0, sold_minor INTEGER NOT NULL DEFAULT 0, tax_minor INTEGER NOT NULL DEFAULT 0,
  received_qty INTEGER NOT NULL DEFAULT 0, returned_qty INTEGER NOT NULL DEFAULT 0,
  adjusted_qty INTEGER NOT NULL DEFAULT 0, damaged_qty INTEGER NOT NULL DEFAULT 0,
  count_delta INTEGER NOT NULL DEFAULT 0, transfer_in INTEGER NOT NULL DEFAULT 0, transfer_out INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, product_id, location_id)
);

CREATE TABLE suppliers (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT, phone TEXT, lead_time_days INTEGER,
  note TEXT, created_at TEXT NOT NULL, archived_at TEXT
);
CREATE TABLE purchase_orders (
  id TEXT PRIMARY KEY, number TEXT NOT NULL UNIQUE, supplier_id TEXT NOT NULL REFERENCES suppliers(id),
  location_id TEXT NOT NULL, state TEXT NOT NULL CHECK (state IN
    ('draft','sent','partially_received','received','cancelled','closed')),
  expected_at TEXT, note TEXT, created_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE po_lines (
  id TEXT PRIMARY KEY, po_id TEXT NOT NULL REFERENCES purchase_orders(id), product_id TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0), received INTEGER NOT NULL DEFAULT 0,
  unit_cost_minor INTEGER NOT NULL
);

CREATE TABLE count_tasks (
  id TEXT PRIMARY KEY, location_id TEXT NOT NULL, scope TEXT NOT NULL, blind INTEGER NOT NULL DEFAULT 1,
  assigned_to TEXT, due_at TEXT, state TEXT NOT NULL CHECK (state IN ('open','submitted','cancelled')),
  created_by TEXT NOT NULL, created_at TEXT NOT NULL, submitted_at TEXT
);
CREATE TABLE count_task_lines (
  task_id TEXT NOT NULL, product_id TEXT NOT NULL, counted INTEGER, expected INTEGER,
  PRIMARY KEY (task_id, product_id)
);

CREATE TABLE customers (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT, phone TEXT, address TEXT, tax_id TEXT,
  note TEXT, created_at TEXT NOT NULL, archived_at TEXT
);
CREATE UNIQUE INDEX customers_email ON customers(email COLLATE NOCASE) WHERE email IS NOT NULL;
```

New invariants (checked by `verifyIntegrity`, like I1, I3, I6 today):
- **I7** `products.on_order` = Σ (`po_lines.quantity − received`) over POs in `sent` or `partially_received`.
- **I8** `daily_stats` totals per product = the same totals computed from the ledger.
- **I9** `orders.total_minor` = `subtotal_minor + tax_minor` (exclusive mode) and line sums match.

## 3. Shared code (`packages/shared`)

- `ROLES` + `accountant`; `PERMISSIONS` list and `ROLE_PERMISSIONS` per the "01-model.md" section.
- `orgSettings` Zod schema (F8); `approvalRule` schemas (F10); `purchaseOrderInput`, `receiveInput`
  (F13); `countTaskInput` (F15); `customerInput`, tax helpers with tests (F16); report query schema (F12).
- `shapeProduct`, `shapeOrder` helpers live in the API, not shared, so the browser never decides.

## 4. Endpoints added

`P` = permission. All org routes are under `/api/v1/orgs/:orgId`.

| Method | Path | P | Feature |
|---|---|---|---|
| POST | `/admin/orgs` | super | F1 |
| POST | `/admin/orgs/:id/resend-invitation` | super | F1 |
| GET | `/admin/orgs/:id` | super | F6 |
| POST | `/admin/orgs/:id/transfer-admin` | super | F3 |
| GET | `/admin/users/:id` | super | F6 |
| POST | `/admin/users/:id/sign-out` | super | F6 |
| GET, PATCH | `/admin/plans` | super | F20 |
| PATCH | `/admin/orgs/:id/plan` | super | F20 |
| GET | `/admin/usage` | super | F21 |
| GET | `/admin/security` | super | F22 |
| GET | `/admin/support` | super | F19 |
| GET, POST, DELETE | `/admin/announcements`, `/admin/maintenance` | super | F28 |
| GET | `/invitations` | team:manage | F2 |
| POST | `/invitations/:id/resend` | team:manage | F2 |
| DELETE | `/invitations/:id` | team:manage | F2 |
| POST | `/members/:userId/deactivate`, `/reactivate` | team:manage | F3 |
| POST | `/admin-handover` | team:manage | F3 |
| PATCH | `/members/:userId` (`locationIds`) | team:manage | F9 |
| GET | `/settings` | inventory:read | F8 |
| PATCH | `/settings` | settings:manage | F8 |
| GET | `/plan` | settings:manage | F20 |
| GET | `/approvals` | inventory:read (own) / approvals:decide (all) | F10 |
| POST | `/approvals/:id/approve`, `/reject` | approvals:decide | F10 |
| POST | `/approvals/:id/withdraw` | requester | F10 |
| GET | `/reports/:name` | reports:read | F12 |
| GET, POST, PATCH | `/suppliers[/:id]` | inventory:read / purchasing:write | F13 |
| GET, POST, PATCH | `/purchase-orders[/:id]` | inventory:read / purchasing:write | F13 |
| POST | `/purchase-orders/:id/send`, `/cancel`, `/close` | purchasing:write | F13 |
| POST | `/purchase-orders/:id/receive` | stock:write | F13 |
| GET | `/purchasing/reorder` | purchasing:write | F14 |
| POST | `/purchasing/reorder/draft` | purchasing:write | F14 |
| GET, POST | `/count-tasks[/:id]` | inventory:read / counts:assign | F15 |
| POST | `/count-tasks/:id/lines`, `/submit` | stock:write (assignee) | F15 |
| POST | `/count-tasks/:id/cancel` | counts:assign | F15 |
| GET, POST, PATCH | `/customers[/:id]` | customers:read / orders:write | F16 |
| GET | `/orders/:id/document` | orders:write or customers:read | F16 |
| POST, DELETE | `/orders/:id/share` | orders:write | F24 |
| POST, DELETE | `/purchase-orders/:id/share` | purchasing:write | F25 |
| POST, GET, DELETE | `/support-grants[/:id]` | settings:manage | F19 |
| POST | `/restore` | settings:manage | F26 |
| GET | `/me/notifications`, `/me/notifications/unread-count` | user | F11 |
| POST | `/me/notifications/read` | user | F11 |
| GET, PATCH | `/me/notification-preferences` | user | F11 |
| GET | `/me/security-events` | user | F22 |
| GET | `/s/o/:token`, `/s/po/:token` (public pages) | public | F24, F25 |
| POST | `/s/po/:token/confirm`, `/dispatched` | public, rate-limited | F25 |

## 5. Screens added

| Screen | Who | Feature |
|---|---|---|
| Platform → Onboard a business; Business detail; User detail | Developer | F1, F6 |
| Platform → Plans, Usage, Security, Support, Announcements | Developer | F19–F22, F28 |
| Settings → Team (members + pending invitations, deactivate, locations, hand over) | Admin | F2, F3, F9 |
| Settings → Business (identity, money, time, numbering, stock, approvals) | Admin | F8, F10 |
| Settings → Plan (usage bars) | Admin | F20 |
| Settings → Support access | Admin | F19 |
| Settings → Notifications, Security | Everyone | F11, F22 |
| Approvals (queue / my requests) | Deciders / requesters | F10 |
| Reports | Accountant, manager, admin | F12 |
| Purchasing → Suppliers, Purchase orders, Reorder | Manager, admin; stock keeper receives | F13, F14 |
| Count tasks (assign / my tasks) | Manager / stock keeper | F15 |
| Customers; Order → Print invoice / receipt | Sales, manager, admin | F16 |
| Notification bell panel | Everyone | F11 |
| Public order status, public PO page | External | F24, F25 |

All new screens follow the existing dashboard style (`dashboard.css` unchanged, additions in
`app.css`), work at 390 px wide, and pass axe with zero serious or critical issues.

---

# 07 · Testing, rollout and the free plan

## 1. Testing: what every feature must ship with

| Layer | What | Tool |
|---|---|---|
| Permission walk | For every role and every org route: expected 2xx or 403 from `ROLE_PERMISSIONS`. New routes join automatically. | Vitest in the Workers runtime (existing) |
| Feature tests | The "Tests" list in each feature, including edge cases and refusals | Vitest (existing) |
| Response shaping | For each role, no forbidden field (cost, contact details, emails) appears in any response, including lists, exports and webhooks | Vitest, a shared helper that scans JSON for forbidden keys |
| Invariants | `verifyIntegrity` extended with I7–I9; run after every feature test file and in the load test | Existing pattern |
| Migrations | Each D1 migration run on a scratch SQLite copy with old-format rows, checking the mapping (as done for 0005). Each Durable Object step tested from the previous step with data. | Python `sqlite3` script; Vitest |
| Concurrency | Approvals approved twice, receipts submitted twice, counts during movements | Vitest with parallel requests |
| Browser | One end-to-end script per phase: sign in as each role, do its main job, check hidden items are hidden | Puppeteer against local `wrangler dev` (existing approach) |
| Accessibility | axe on every new screen at 1280 and 390 px: zero serious or critical | axe-core (existing approach) |
| Performance | Load test extended with reports and approvals; reports p95 under 300 ms on a 50,000-movement business | `loadtest.mjs` (existing) |

**Bundle budget.** All JavaScript is about 170 KB gzipped against a 174 KB budget today. New screens
(reports, purchasing, counts, approvals, platform console) will be **lazy-loaded routes**, like the
Clerk sign-in page already is, so the first screen does not grow. The budget check changes to
"initial route ≤ 174 KB, each lazy chunk ≤ 60 KB".

## 2. Rollout: how each feature reaches production safely

1. **Migration first.** Apply the additive D1 migration before deploying the code that uses it.
   Old code ignores new columns, so there is no broken window.
2. **Deploy** the Worker and web app together (one `wrangler deploy`).
3. **Feature switch** (after F20 exists): new business features start switched on only for your test
   business, then for everyone.
4. **Live smoke test**: a short script checks health, one read and one refused write per role on a
   test business.
5. **Rollback**: redeploy the previous version with `wrangler rollback`. Because migrations are
   additive, the old code still works on the new schema. Durable Object steps are also additive.
6. **Changelog**: each release adds a line to `docs/CHANGELOG.md` and, from F28 on, an optional
   announcement.

Production data changes (like migration 0005) are always:
- checked read-only first (counts by role, etc.),
- tested on a scratch copy with the same shapes,
- applied, then re-checked with the same read-only query.

## 3. Free-plan budget

| Resource | Free limit | Expected after this plan (10 businesses, 30 staff, 300 orders/day) |
|---|---|---|
| Worker requests | 100,000 / day | ~20,000 (UI polling for notifications is the biggest new item: 1 per minute per open tab) |
| Worker CPU | 10 ms per request | Unchanged; heavy work (reports, imports, restore) runs in the Durable Object or the queue |
| D1 writes | 100,000 / day | ~3,000 (notifications, sign-in events, sessions) |
| D1 storage | 5 GB | Tiny; notifications and events are pruned |
| Durable Object storage | 5 GB total on free | Ledger growth ~1 KB per movement; 1 million movements ≈ 1 GB |
| Queue | 10,000 operations / day (free) | Webhooks + notifications + emails ≈ 2,000 |
| R2 (F29) | 10 GB, 1 M writes / month | 10 businesses × 30 days of backups ≈ a few hundred MB |
| Email (F23) | Provider free tier, e.g. 100 / day | Per-business caps keep within it |

The usage dashboard (F21) shows the real numbers and warns at 70%.

## 4. Definition of done (every feature)

- [ ] Tests listed in the feature pass, plus the permission walk and shaping scan.
- [ ] Typecheck, all tests, bundle budget, `npm audit` (high) green in CI.
- [ ] axe clean on new screens at both widths.
- [ ] Docs updated: SECURITY (if permissions changed), API, DATA_MODEL, this plan's status.
- [ ] Deployed, migration applied, live smoke test passed.
- [ ] No Co-Authored-By lines in commits.

---

# 08 · Decisions needed before building

Each decision has the **default this plan assumes**. If you agree with a default, nothing changes.
If not, tell me the number and your choice; I will update the affected features before building.

| # | Question | Default assumed | Affects |
|---|---|---|---|
| D1 | May you (the developer) see a business's data when its admin grants support access? | **Yes**, read-only, time-boxed (max 4 h), logged on both sides, admin can end it any time. Without a grant you see nothing, as today. Extra passkey check on your side: **off** | F19 |
| D2 | Who creates new businesses? | **Only you**, through "Onboard a business", while sign-in is invite-only. Self-serve signup stays off. | F1 |
| D3 | Which approval rules exist, and their defaults? | The five in F10, **all switched off** for a new business until its admin turns them on; defaults when on: 20 units / 500.00 for adjustments, all damage, count variance 20 units, cancel after payment, price drop over 30% | F10 |
| D4 | Email notifications? | **Yes, in Phase 3**, through Resend (free tier) from a domain you own. Until then, in-app only. | F23 |
| D5 | Nightly backups to R2? | **Yes, in Phase 3**. You create the R2 bucket (it needs a payment method on file, but stays free within 10 GB). | F29 |
| D6 | Accountant role, customer links, supplier links? | **All three yes**: accountant in Phase 2a, links in Phase 3 | F17, F24, F25 |
| D7 | Usage dashboard data source? | Cloudflare GraphQL Analytics with a **read-only** API token you create, plus Workers Analytics Engine for per-business counts | F21 |
| D8 | Billing your clients (charging money)? | **Not now.** Plans and limits (F20) are built so payments can be added later without rework. | F20 |
| D9 | Product cost method? | **Last received cost.** Weighted average is a later setting. | F13, F12 |
| D10 | Can a manager invite staff? | **No**, only the admin (`team:manage`). A business that wants this adds a second admin. | Model |
| D11 | Do location-scoped staff see stock at other locations? | **Yes, read-only**; they can only write at their own locations | F9 |
| D12 | Tax handling | Single default rate per business plus a per-product override; inclusive or exclusive mode; rounding per line, half-up | F16 |
| D13 | Do stock keepers see customer names on orders they pick? | **Name yes, contact details no** | F5, F16 |
| D14 | Retention | Activity log 2 years (setting), platform audit 1 year, sign-in events 90 days, notifications 60 days | F30, F22, F11 |
| D15 | Free plan limits for a business | 2,000 products, 5 members, 2 locations, 2 API keys, 2 webhooks; all features on | F20 |

## What happens next

1. You read the plan and answer any decisions you disagree with (or say "defaults are fine").
2. I update the plan with your answers and mark it **Approved** in the "README.md" section.
3. We build **Phase 1** (F7, F1, F2, F3, F4, F5, F6), one feature per commit, each deployed and
   smoke-tested, and report after each.
4. Phase 2a, 2b and 3 follow the same way. You can reorder or drop features between phases.
