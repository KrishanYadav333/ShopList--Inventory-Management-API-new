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
| **E**levation of privilege | Viewer calls an editor endpoint; editor makes themself owner | Every route declares its required permission; role changes need admin, owner changes need owner; the last owner cannot be removed |

## Authentication

**No passwords.** Workers caps PBKDF2 at 100,000 iterations, below OWASP's 600,000 for PBKDF2-HMAC-SHA256, and the free plan allows only 10 ms of CPU per request. Rather than store weakly hashed passwords, ShopList uses:

1. **OAuth 2.0 with PKCE** via GitHub and Google. Only verified emails are accepted. `state` and the PKCE verifier are stored in a short-lived, signed, HttpOnly cookie.
2. **Passkeys (WebAuthn)** as a phishing-resistant option, added from account settings. Verifying a passkey is one signature check, which fits the CPU budget. User verification is required.

Account linking: a new OAuth identity with an email that matches an existing user is linked **only** if the provider marks the email as verified.

## Two sign-in doors, and the super admin

| Door | For | How it works |
|---|---|---|
| **GitHub** | The owner only | OAuth with PKCE. The callback accepts exactly one GitHub account, matched by numeric id (`SUPER_ADMIN_GITHUB_ID`), in every mode. Everyone else is refused before any user or session exists. |
| **Clerk** | Customers | Clerk proves identity (Google, email, passkeys, MFA). The Worker verifies Clerk's RS256 session token itself, then issues its own ShopList session, so cookies, CSRF checks and revocation stay ours. Only enabled when `SIGNIN_MODE=open`. |

There is exactly **one super admin**: the owner. The role is never stored and cannot be granted through the app. It is true only when **both** hold: the user is linked to the GitHub account in `SUPER_ADMIN_GITHUB_ID`, **and** the current session was created through the GitHub door. A session from the customer door carries no admin power even on the same user row.

`SIGNIN_MODE` unset (or any value other than `open`) is **owner-only**, and fails closed: a typo keeps the site private. In owner-only mode the check runs on every request, so sessions created before a mode change stop working at once.

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

Roles and permissions:

| Permission | viewer | editor | admin | owner |
|---|:-:|:-:|:-:|:-:|
| Read products, stock, ledger, dashboard | ✓ | ✓ | ✓ | ✓ |
| Create, edit, delete products; move stock; reservations; imports | | ✓ | ✓ | ✓ |
| Locations, members, invitations, API keys, webhooks, audit log | | | ✓ | ✓ |
| Billing, delete org, transfer ownership, manage owners | | | | ✓ |

Rules:

- Each route declares one permission, such as `requires('stock:write')`. A test fails if any route lacks a declaration.
- The org id in the URL is checked against the caller's memberships in D1 **before** the Durable Object is touched. The Durable Object id is derived from that verified org id.
- API keys are limited to their scopes and can never manage members, keys or webhooks.

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
| Unit tests for every permission rule, including "viewer cannot write" for each route | Every commit |
| Tenant isolation test: user of org A requests every org B endpoint and must get 404 | Every commit |
| Concurrency test: 50 parallel `-1` movements on a stock of 50 end at exactly 0, never below | Every commit |
| OWASP ZAP baseline scan against the preview deployment | Every pull request |
| Manual review against the ASVS Level 2 checklist | Before each major release |

## Reporting a vulnerability

Email the maintainer (address in the repository's `SECURITY.md` at the root once published) with steps to reproduce. Expect acknowledgement within 3 days. Please do not open a public issue.
