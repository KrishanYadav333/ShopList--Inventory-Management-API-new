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
