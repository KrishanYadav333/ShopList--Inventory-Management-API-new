# Access requests, impersonation and passkeys (A1 to A3)

Written 2026-11-19. Status (2026-11-19): **A1 and A3 are built and deployed; A3 enforcement is off until you switch it on. A2 (impersonation) is next.** Builds on hands-on support ([04-phase2-platform.md](04-phase2-platform.md), F19) and passkeys (already in Settings).

## What you asked for, and where it stands

| Request | Status |
|---|---|
| Choose a password after an invitation; sign in with email or username plus password, or Google | Done (sign-up asks for a password; Settings has "Set or change password"; sign-in offers every method) |
| Sign out, then sign in as another admin, staff or owner without a hard reload | Done (sign-out does a full page load; finishing a sign-in lands on the hand-off) |
| Uninvited person gets a clear warning | Done (names their email, says to ask the company admin) |
| Owner can request access to any company; the company admin approves | **A1** |
| Company admin can ask for support; the owner then gets access automatically | **A1** |
| Read-only by default; write access only with a tick box, on both sides | **A1** |
| Owner can request to impersonate the company admin in a few cases, with the admin's approval | **A2** |
| Passkey with QR for owner and admin, optional for other staff | **A3** |

## Rules that hold for everything below

1. **Nothing opens without the business admin's consent.** Either they asked for it, or they approved a request.
2. **Read-only is the default.** Changing anything needs a visible tick box, chosen by whoever grants it.
3. **Time-limited and revocable.** 30 minutes, 1 hour or 4 hours (impersonation: 30 or 60 minutes). The admin can end it at any moment.
4. **Everything is recorded twice:** in the platform audit with the owner's real id, and in the business's own history, where it appears as "ShopList support" (or "ShopList support, acting as <admin name>").
5. **Never possible, in any mode:** deleting data, deleting or transferring the business, changing sign-in methods or passkeys, granting access to oneself, reading API-key or webhook secrets.

---

## A1. Access requests and the write tick

**Why.** Today only the business admin can open a window. Support also needs to be able to ask, and the business should see and decide on that ask.

**How it works.**

Two directions, one list:

1. **Owner asks, admin approves.** On the owner's Support page: choose a business, a reason (required), a length, and optionally tick "Also ask to make changes". The business admin gets an in-app notice and an email ("ShopList support asks to look at your business: <reason>"). In Settings, Support access, the admin sees the pending request and can **Approve** (they may shorten it or untick changes) or **Decline**. A request left alone expires after 48 hours. One pending request per business at a time.
2. **Admin asks, owner gets in at once.** The admin chooses a length, writes what is wrong, optionally ticks "Allow changes", and sends. This is already a window today; it now also notifies the owner and shows on the owner's Support page as ready to open. No owner approval is needed because the admin initiated it.
3. **The write tick replaces the old "Look only / Look and help" choice.** Unticked: read-only. Ticked: products, stock, orders, purchasing and counts can be changed (as hands-on support works today, never a delete, never people, settings, keys, approvals or the activity log). A reason is required when the tick is on.

**Screens.**
- Owner, Support page: "Request access" form; a table of requests (pending, approved, declined, expired) and open windows with an Open button.
- Admin, Settings, Support access: "Ask ShopList for help" form; pending requests with Approve and Decline; history.
- Business app banner while the owner is inside shows "Read-only" or "Can make changes".

**API.**
- `POST /admin/orgs/:id/access-requests` (owner): `{ minutes, reason, write }`
- `GET /orgs/:orgId/access-requests` and `POST /orgs/:orgId/access-requests/:rid/decide` (admin): `{ decision: approve | decline, minutes?, write? }`
- `GET /admin/access-requests` (owner)
- Existing `POST /orgs/:orgId/support-grants` gains `write: boolean` in place of `mode`.

**Data.** Migration `0025_access_requests.sql`: `access_requests(id, org_id, kind, requested_by, reason, minutes, write, state, decided_by, decided_at, grant_id, created_at, expires_at)`. `support_grants.mode` stays (`view` / `assist`) and is set from the tick. Notification kinds `access.requested`, `access.decided`.

**Rules and edge cases.**
- Only the business admin (not staff) can approve; a second admin counts. The owner cannot approve their own request.
- Approving creates the grant at that moment; the clock starts then, not when the request was sent.
- Suspending or scheduling deletion of the business cancels pending requests and ends open windows (already true for windows).
- Declined and expired requests can be repeated after 15 minutes, so a decline cannot be bypassed by spamming.

**Tests.** Owner cannot open anything without approval; staff cannot approve; approving with the tick off gives a read-only window; write is refused without the tick and delete is refused with it; a request expires; both sides get notices; both audits record each step.

**Done when.** The whole request, approve, use, end cycle works in both directions with the tick honoured.

**Effort.** 2 days.

---

## A2. Impersonating the business admin (approval needed, few cases)

**Why.** Some problems only show when you see exactly what the admin sees (their settings, team and plan screens).

**Who.** Owner asks; the business admin must approve every time. It is a separate kind of request, never the default.

**How it works.**
- On the Support page the owner picks "View as the admin" instead of plain access, then must choose one of a fixed list of reasons and add a note: *Reproduce a problem only the admin sees*, *Check team or role setup*, *Check plan or limits*, *Help with settings*, *Other (explain)*.
- The admin gets a distinct notice and email ("ShopList support asks to see your business as you see it") and approves or declines in Settings. Approval is per request; it cannot be pre-approved.
- Length is 30 or 60 minutes only.
- Inside, the owner sees the business app as that admin sees it, including the team and settings pages. **Read-only unless the write tick was approved.** Even with the tick: no deletes, no changes to team members or invitations, no API keys or webhooks, no support grants, no deletion or transfer of the business. Secrets are never shown.
- A red banner shows "Acting as <admin name>" on every screen. Changes appear in the business history as "ShopList support, acting as <admin name>". The platform audit keeps the owner's real id.

**API.** The same access-request routes with `kind: 'impersonate'` and a `reasonCode`. The grant records `impersonate_user_id`.

**Data.** `access_requests.kind`, `reason_code`, and `support_grants.impersonate_user_id` (in migration 0025).

**Rules and edge cases.**
- The admin being impersonated is told when it starts and when it ends.
- If the admin changes role or is removed during the window, the window ends.
- The owner cannot impersonate anyone but the business admin, never staff and never another owner.

**Security.** This is the highest-risk feature in the product, so it ships last in A1 to A3 with its own review: tests for every blocked action, a check that the audit names the owner, and a check that an ended or expired window stops working at once.

**Tests.** Cannot start without approval; read-only without the tick; every blocked action refused with the tick on; banner and audit present; ends on revoke, expiry, role change and suspension.

**Done when.** An approved impersonation shows the admin's screens, cannot do anything on the blocked list, and leaves a complete trail on both sides.

**Effort.** 2 days.

---

## A3. Passkeys with QR: required for owner and admin, optional for staff

**What "with QR" means here.** A passkey can live on the computer, or on a phone. When someone chooses "use a phone or tablet", the browser itself shows a QR code and the phone confirms with its fingerprint or face. ShopList already accepts both (the passkey code does not restrict where the key lives). The work is to make this obvious, and to make passkeys required where you want them.

**How it works.**
- **Two clear buttons** in Settings and in the setup screen: "Add a passkey on this device" and "Add a passkey on my phone (scan a QR code)". The second asks the browser to show the QR code first.
- **Owner.** After the GitHub sign-in, the owner must also confirm with a passkey before any `/admin` page or route works. First time: a setup screen to add one (allowed because GitHub already proved identity). The check lasts 12 hours.
- **Business admins.** Every admin must have at least one passkey. After sign-in without one, a setup screen appears. Existing admins get **7 days** from the day this ships to add one; new admins get 7 days from their first sign-in. After that, the business app is closed to them until they add one (account pages stay open so they can fix it). Signing in by passkey counts as the confirmation. Signing in by Google or password asks for a passkey tap before the admin can use the business.
- **Staff.** Optional. Settings shows a "Recommended" note and nothing blocks them.
- **Losing the phone.** Admins can register up to 10 passkeys, so a second device is the recovery. If an admin is locked out, the owner can reset their passkeys from the People page (audited), and the admin adds a new one on their next sign-in.
- **Owner break-glass.** If the owner loses every passkey, a deploy-time setting (`OWNER_PASSKEY_OPTIONAL=true`) lets GitHub alone in again so a new passkey can be added; it is removed again right after. This is documented in OPERATIONS.

**API.**
- `POST /auth/passkeys/register/options` gains `{ where: 'device' | 'phone' }`, which sets the browser hint.
- `POST /auth/passkeys/verify/options` and `/verify`: a signed-in person proves a passkey for the current session (sets `sessions.passkey_at`).
- Owner and admin routes answer `403 passkey_required` when the session has no recent confirmation; the web app turns that into the verify screen.
- `POST /admin/users/:id/reset-passkeys` (owner).

**Data.** Migration `0026_passkey_enforcement.sql`: `sessions.passkey_at`, and `users.passkey_grace_until` (set on first sign-in or at rollout).

**Rules and edge cases.**
- Enforcement is controlled by one setting, `PASSKEY_ENFORCE` (off in tests, on in production once you approve), so it can be switched off in a hurry.
- A passkey sign-in session is already confirmed (the passkey needs the person's fingerprint, face or PIN).
- Browsers without passkey support show a clear message and the owner is told which admins cannot comply.
- The sign-in hand-off keeps working as built; passkey confirmation is a separate step after it.

**Security.** Passkeys stay verified with WebCrypto only, as now. The confirmation is stored on the session, never on the user, so a stolen session cookie from another device does not carry it (the cookie is bound to the session row, as today).

**Tests.** An admin with no passkey is told to add one after the grace period and not before; an owner session without a passkey cannot read `/admin`; a passkey confirmation unlocks both; staff are never blocked; reset-passkeys is owner-only and audited; the break-glass setting works.

**Done when.** You can register a passkey from your phone by scanning the QR code, sign in with it, and see the owner and admin gates work, with staff unaffected.

**Effort.** 2.5 days.

---

## Order and rollout

| Step | What | Why this order |
|---|---|---|
| 1 | A1 requests and the write tick | Everything else uses it |
| 2 | A3 passkeys with QR | Independent, protects the owner and admins before more power is added |
| 3 | A2 impersonation | Highest risk; ships last, on top of A1 and A3 |

Each ships on its own: migration first, deploy, CI green. Enforcement in A3 is switched on only after you have registered your own passkey and tested the recovery path.

## Decisions with defaults

| Question | Default |
|---|---|
| Does an admin-initiated request open the window straight away? | Yes, the owner is notified, no second approval |
| Request expiry; repeat after a decline | 48 hours; 15 minutes |
| Impersonation lengths and reasons | 30 or 60 minutes; the fixed list above |
| Admin passkey grace period | 7 days |
| Owner passkey check lasts | 12 hours |
| Staff passkeys | Optional, recommended |
| Admin passkey needed on every sign-in, or only to enter the business | Every sign-in that did not use a passkey |

## Docs to update when each step ships

`docs/API.md`, `docs/SECURITY.md` (consent model, blocked actions, enforcement), `docs/OPERATIONS.md` (break-glass, resetting a locked-out admin), `docs/ROADMAP.md`, and the route table in `src/docs.ts`.
