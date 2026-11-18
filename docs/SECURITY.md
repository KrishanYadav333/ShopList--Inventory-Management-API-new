# Security

Target: [OWASP ASVS 4.0](https://owasp.org/www-project-application-security-verification-standard/) Level 2, the level expected of applications that handle business data.

## Assets

| Asset | Why it matters |
|---|---|
| Inventory data and the stock ledger | A business's operational record; corruption means wrong orders and lost money |
| Cost prices, supplier references | Commercially sensitive |
| Member identities (names, emails) | Personal data under GDPR and similar laws |
| Session tokens, API keys, webhook secrets | Grant access to everything above |

## Threat model (STRIDE)

| Threat | Example | Control |
|---|---|---|
| **S**poofing | Stolen session cookie used from another machine | HttpOnly + Secure + `__Host-` cookie; 12-hour idle timeout; session list with "sign out everywhere"; passkeys resist phishing |
| **T**ampering | Two editors overwrite each other; a client sends a fake stock total | `If-Match` versioning; stock changes only by validated deltas inside a transaction; append-only ledger |
| **R**epudiation | "I never deleted that product" | Audit log of every change with actor, request id and field-level diff; no code path can edit it |
| **I**nformation disclosure | User of org A reads org B's products | Separate Durable Object per org, chosen from the server-side membership, never from client input alone; cross-org ids return 404 |
| **D**enial of service | Bot floods sign-in or the API burns the free daily quota | Turnstile on auth; per-IP, per-user and per-key rate limits; request size limits; page size caps; no unbounded queries |
| **E**levation of privilege | Viewer calls a write endpoint; a manager makes themself admin | Every route declares its required permission; only the admin changes roles; a second admin needs explicit confirmation; the last admin cannot be removed |

## Authentication

**No passwords stored by ShopList.** Workers caps PBKDF2 at 100,000 iterations, below OWASP's 600,000 for PBKDF2-HMAC-SHA256, and the free plan allows only 10 ms of CPU per request. Identity comes from GitHub (owner), Clerk (customers) or a passkey.

**Passkeys (WebAuthn)** are verified in the Worker with WebCrypto only (`src/webauthn.ts`), one ECDSA check per sign-in:
- ES256 credentials, discoverable (no username typed), user verification required (biometric or device PIN). Attestation is not requested (`none`).
- A signed, purpose-bound challenge that expires after 2 minutes. A sign-in challenge cannot be used to register, and a registration challenge is bound to the user who asked for it.
- The origin, relying party id hash, ceremony type, user-presence and user-verified flags are all checked. The sign counter must increase when the authenticator uses one (rollback means a cloned key).
- Unknown credential, bad signature and disabled account give the same answer, so credential ids cannot be probed.
- A passkey session is a normal session. It **never** carries super-admin power, even on the owner's account. Only the GitHub door does.
- Not done: single-use challenges (a captured response is replayable for up to 2 minutes, but capturing one needs a TLS break) and attestation verification. Add both if you ever need to restrict which authenticators are allowed.

Account linking: a new OAuth identity with an email that matches an existing user is linked **only** if the provider marks the email as verified.

## Two sign-in doors, and the super admin

| Door | For | How it works |
|---|---|---|
| **GitHub** | The owner only | OAuth with PKCE. The callback accepts exactly one GitHub account, matched by numeric id (`SUPER_ADMIN_GITHUB_ID`), in every mode. Everyone else is refused before any user or session exists. |
| **Clerk** | Customers | Clerk proves identity (Google, email code). The Worker verifies Clerk's RS256 session token itself, then issues its own ShopList session, so cookies, CSRF checks and revocation stay ours. Available in `invite` and `open` modes. |
| **Passkey** | Existing users | Added from Settings after a first sign-in. Never grants admin power. |

The two pages are separate: `/login` is for customers, `/owner` is the owner's unlinked GitHub page.

There is exactly **one super admin**: the owner. The role is never stored and cannot be granted through the app. It is true only when **both** hold: the user is linked to the GitHub account in `SUPER_ADMIN_GITHUB_ID`, **and** the current session was created through the GitHub door. A session from the customer door carries no admin power even on the same user row.

`SIGNIN_MODE` has three values, and anything else (including a typo) means **owner-only**, so it fails closed:

| Value | Who can sign in |
|---|---|
| unset / unknown | Only the owner, through GitHub. |
| `invite` | The owner, plus customers through Clerk **only if** they already have an account or the owner or an admin has a pending, unexpired invitation for their verified email. Nobody else gets an account created. This is the production setting. |
| `open` | Anyone with a verified Clerk email. Never set in production configuration; a test enforces that. |

In owner-only mode the check runs on every request, so sessions created before a mode change stop working at once.

Clerk token verification (`src/clerk.ts`):
- The algorithm is pinned to RS256; `none` and HS256 (including the public-key-as-HMAC-secret downgrade) are rejected.
- The signature is checked against the configured public key. `iss` must equal `CLERK_ISSUER`, `exp` and `nbf` are enforced with 5 seconds of leeway, `azp` must be this app's origin, and `sub` must be a Clerk user id.
- Nothing reaches Clerk's API for a token that fails verification.
- The user's primary email must be **verified by Clerk**; banned or locked users are refused.
- A Clerk identity can never attach to an account that has a GitHub identity (the owner's), even with the same verified email.

What the super admin can do:
- Manage **accounts and organizations only**: list them, suspend or restore an organization, disable or re-enable a user (which signs them out immediately), and read a platform audit log.
- No admin route touches inventory, and inventory routes require organization membership, so the super admin cannot read any organization's products or stock. A test proves it.
- The admin area answers 404 to everyone else. The super admin cannot disable their own account.
- A disabled account cannot sign in again until re-enabled, through either door.

The app cannot enforce a second factor for the GitHub door: enable a passkey or two-factor authentication on the owner's GitHub account. A passkey step-up inside ShopList is a possible later addition.

## Sessions

- Token: 32 random bytes from `crypto.getRandomValues`, base64url encoded.
- Cookie: `__Host-sl_session=<token>; Path=/; HttpOnly; Secure; SameSite=Lax`.
- Storage: only `SHA-256(token)` is stored in D1. A database leak does not reveal usable tokens.
- Lifetime: 12 hours idle, 30 days absolute. The expiry slides at most once per hour to limit writes.
- Rotation: a new token is issued at sign-in and on any privilege change.
- Revocation: logout deletes the row. Users can view and revoke all their sessions.

## API keys

- Format `sl_live_` + 32 random bytes in base62. Shown once at creation, then only the 8-character prefix.
- Stored as `SHA-256(key)`, which is correct for high-entropy secrets.
- Scoped to one org and a list of permissions, with optional expiry. `last_used_at` is shown so stale keys can be removed.
- Leaked-key response: revoke in the UI takes effect on the next request.

## Authorization

Access is in three levels, the same idea as a clinic ERP.

| Level | Who | Scope |
|---|---|---|
| **Developer** (super admin) | You, the platform owner | The platform only: organizations, users, platform audit log. Cannot read any organization's inventory. Not a stored role; see "Two sign-in doors". |
| **Admin** | The client business owner. One per organization | Everything in their own organization, plus team, invitations, locations, API keys, webhooks, the activity log and deleting the organization. |
| **Staff roles** | People the admin invites, by job | Only what the job needs. The admin picks an existing role; nobody can redefine a role. |

| Permission | viewer | sales | stock keeper | accountant | manager | admin |
|---|:-:|:-:|:-:|:-:|:-:|:-:|
| Read products, stock, orders, history, dashboard | Yes | Yes | Yes | Yes | Yes | Yes |
| Cost price, margin, inventory value (`cost:read`) | | | | Yes | Yes | Yes |
| Customer contact details (`customers:read`) | | Yes | | Yes | Yes | Yes |
| Create, edit, delete products; CSV import | | | | | Yes | Yes |
| Receive, adjust, transfer and count stock | | | Yes | | Yes | Yes |
| Create, pay, ship and cancel orders; add customers | | Yes | | | Yes | Yes |
| Suppliers and purchase orders; reorder suggestions | | | receive only | | Yes | Yes |
| Create and assign count tasks | | | | | Yes | Yes |
| Approve or reject requests | | | | | Yes | Yes |
| Reports and their CSV export | | | | Yes | Yes | Yes |
| Activity log | | | | Yes | | Yes |
| Team, invitations, locations, API keys, webhooks, business settings | | | | | | Yes |
| Delete the organization | | | | | | Yes |

Some actions need a second person even when the permission allows them (approval rules, admin-configured, off by default): damage write-offs, large stock reductions, large count variances, cancelling a paid order, large price drops. The request waits as the exact validated input and is applied once, against current data, when a manager or the admin approves.

Rules:

- The permission table lives in one place (`ROLE_PERMISSIONS` in `packages/shared`). Each route declares exactly one permission, such as `requires('stock:write')`, and a test fails if any route lacks one. A test also walks every role through the routes and checks the expected 200 or 403.
- **One admin per organization.** Inviting or promoting a second admin is refused (`second_admin`) unless the request says `confirmSecondAdmin: true`, which the screen asks for with a confirm box. The last admin cannot be demoted or removed.
- The org id in the URL is checked against the caller's memberships in D1 **before** the Durable Object is touched. The Durable Object id is derived from that verified org id.
- Cost price and inventory value are removed from every response for roles without `cost:read` (manager and admin have it). Colleagues' emails and last-seen times are shown only to people who manage the team.
- Businesses are created by the platform owner ("Onboard a business"), not by users. Members can be deactivated (they keep their history), and the admin role can be handed over; the last active admin is protected.
- API keys act as a manager for inventory (write scope) or a viewer (read scope), and can never manage members, keys or webhooks.
- When someone signs in with a verified email that has a pending invitation, they join that organization with the invited role automatically.

## Platform controls (Phase 2b and 3)

- **Sign-in history.** Every success and refusal on every door writes one `auth_events` row: time, kind, door, country, browser family, reason. Never an IP address, token, or the email of someone we do not know (only a salted, truncated hash, so repeats can be counted). Rate-limit rows are one per client per minute. Rows are deleted after 90 days.
- **Support access.** The owner sees a business only inside a window its admin opened (30 min, 1 h or 4 h, ended at any time, replaced by a new one). Enforced on the server: only the owner's GitHub-door session can use a grant; every non-GET is refused before routing; only inventory screens and reports are reachable (never team, settings, keys, webhooks or the activity log); cost is visible, customer contact details only if the admin ticked the box. Each page is written to the platform audit and to the business's own activity log; the admin sees a count. The business can switch the feature off (plan), and scheduling deletion or suspending the business ends it.
- **Plans.** Limits and switches are resolved on the server for every request, for people and API keys alike. A switched-off feature is a `404`, so it cannot be probed.
- **Scheduled deletion.** The business name must be typed; 14 days read-only; the admin or the owner can cancel; then a daily job empties the Durable Object and removes the rows (the organization row stays as a tombstone for the audit trail).
- **Maintenance.** Writes return `503`; reads, sign-in and the owner console keep working so it can always be turned off.
- **Email.** Sent through Brevo with the key and the sender address held as Worker secrets (`BREVO_API_KEY`, `EMAIL_FROM`). Emails carry the same text as the in-app notice, never cost or contact data beyond that. Approvals, security reports and support windows are emailed by default; everything else, and the morning summary, only if the person opts in. Every non-invitation email has a signed one-click unsubscribe for that kind. At most 50 emails a day per business and 250 in total. A failed send never fails the request.
- **Share links.** 32 random bytes, only the SHA-256 stored, 90 days, revocable. Unknown, revoked, expired and wrong-kind links all answer the same 404. Pages are `noindex`, `no-store`, `no-referrer`. A customer sees items, quantities and totals; a supplier sees their own purchase order with the unit cost they agreed. Neither sees ids, staff, internal notes, contact details or cost of goods; the supplier can only confirm or mark dispatched (repeating a click changes nothing).
- **Nightly backups.** gzip copies of every business in D1, 30 days. The owner can see when and how big, and can load a copy into a *new* business that has no members until an admin is invited; there is no route that returns a copy's contents. Loading refuses a business that already has products or orders.
- **Retention.** Activity log 2 years (1 to 7, per business), platform audit 1 year, sign-in events 90 days, notifications 60 days. A daily cron at 03:15 UTC does the deleting.

## Web application security

| Control | Setting |
|---|---|
| CSRF | `SameSite=Lax` cookie, plus the server rejects any non-GET request whose `Origin` is not the app's own origin |
| XSS | React escapes output; `dangerouslySetInnerHTML` is banned by lint rule; strict CSP |
| Static asset headers | The HTML and JS/CSS are served by Workers static assets and never reach the Worker, so the same headers are set by `apps/web/public/_headers`; the API sets its own in middleware |
| Content-Security-Policy | `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob: https://avatars.githubusercontent.com https://lh3.googleusercontent.com; connect-src 'self'; frame-src https://challenges.cloudflare.com; frame-ancestors 'none'; base-uri 'none'; form-action 'self'` |
| Other headers | `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy: camera=(self), geolocation=()` (camera is for barcode scanning) |
| CORS | Not enabled for cookie-authenticated routes. API-key routes allow any origin but never accept cookies. |
| Input validation | Zod schema on every body, query and path parameter; unknown fields rejected; strings length-limited |
| SQL injection | Only parameterised statements; a lint rule bans template strings inside `.exec` and `.prepare` |
| CSV injection | Exported cells starting with `=`, `+`, `-`, `@` are prefixed with `'` |
| File uploads | Images only (checked by magic bytes, not extension), 5 MB max, stored in R2 under random keys, served with `Content-Disposition` and correct type |
| Webhooks out | HTTPS targets only; private, loopback and link-local addresses refused to prevent SSRF; 5-second timeout |

## Secrets

- Stored with `wrangler secret put`, never in the repo or `wrangler.jsonc`.
- Needed: `GITHUB_CLIENT_SECRET`, `GOOGLE_CLIENT_SECRET`, `TURNSTILE_SECRET`, `COOKIE_SIGNING_KEY`.
- CI uses a Cloudflare API token limited to Workers, D1, R2 and Queues on this one account.
- Rotation: every secret can be rotated without downtime. `COOKIE_SIGNING_KEY` accepts the previous key for 24 hours after rotation.

## Privacy

- Collected: name, email and avatar from the identity provider; IP country (not full IP) on sessions.
- Users can export their data and delete their account. Deletion removes personal data and replaces `actor` in audit entries with a pseudonymous id.
- No third-party analytics or trackers in the app.

## Supply chain

- Lockfile committed; `npm ci` in CI.
- Dependabot for weekly updates; `npm audit --audit-level=high` blocks merges.
- GitHub secret scanning and push protection enabled.
- No runtime CDN scripts. Fonts and icons are bundled.

## Security testing

| Test | When |
|---|---|
| Unit tests for every permission rule, including every role against every kind of route | Every commit |
| Tenant isolation test: user of org A requests every org B endpoint and must get 404 | Every commit |
| Concurrency test: 50 parallel `-1` movements on a stock of 50 end at exactly 0, never below | Every commit |
| OWASP ZAP baseline scan against the preview deployment | Every pull request |
| Manual review against the ASVS Level 2 checklist | Before each major release |

## Reporting a vulnerability

Email the maintainer (address in the repository's `SECURITY.md` at the root once published) with steps to reproduce. Expect acknowledgement within 3 days. Please do not open a public issue.
