# What only the owner can do

The code is finished for everything the plans describe. These steps need your accounts, a domain, or a person with a device.

## Do these first

1. **Add your own passkey, then require passkeys.** Sign in at `/owner`, open `/passkey`, choose "on my phone (scan a QR code)", and add a second one on your computer. Then Owner console, Security, "Require passkeys for owner and admins". Admins without one get 7 days. Recovery steps are in [OPERATIONS.md](OPERATIONS.md#requiring-passkeys-owner-and-admins).
2. **Remove the test business** when you are done with it: its Settings, scheduled deletion (14 days, cancellable), or purge it from `/admin`.

## Before real customers

- **Production sign-in.** The Clerk instance in use is a development instance ("Shoplist development"). Create a production instance, which needs a domain you own, then set `CLERK_ISSUER`, `CLERK_SECRET_KEY` and `CLERK_JWT_KEY` and the publishable key. Clerk settings that matter (User & authentication): email on with code and link, username on but not required, password on and required at sign-up, Google on, Device Trust on.
- **Email that is not spam.** Add SPF and DKIM for a domain you own in Brevo, then change `EMAIL_FROM`. Invitations come from a shared sender until then.
- **Uptime checker.** A free outside service pinging `/api/v1/health` every 5 minutes. Only an outside checker can tell you the whole site is down.

## When you can enable them

- **R2**: create a bucket `shoplist-backups`; nightly copies can then move out of D1 (they now sit in the same account).
- **Analytics Engine**: enable at `https://dash.cloudflare.com/<account>/workers/analytics-engine`, then add `"analytics_engine_datasets": [{ "binding": "ANALYTICS", "dataset": "shoplist_requests" }]` to `apps/api/wrangler.jsonc` and deploy. The per-business list on the usage page then fills in.

## Secrets

Decision 2026-11-18: not rotated for now. The Brevo key and the Cloudflare analytics token were pasted into a chat transcript; revisit if that transcript is ever shared. To rotate, create a new one at the provider, run `npx wrangler secret put NAME` from `apps/api`, then delete the old one.

| Secret | Where to make a new one |
|---|---|
| `BREVO_API_KEY` | Brevo, SMTP and API, API keys |
| `CF_ANALYTICS_TOKEN` | Cloudflare, My Profile, API Tokens (only "Account Analytics: Read") |
| `GITHUB_CLIENT_SECRET` | GitHub, Settings, Developer settings, OAuth Apps |
| `CLERK_SECRET_KEY` | Clerk dashboard, API keys |

## Checks that need a person

- A real phone (scan a barcode, adjust stock) and a screen reader (VoiceOver). Automated checks pass, but they cannot replace these.
- Click through the new owner pages and request screens once with real accounts; see the short test pass in [DEMO.md](DEMO.md).

## Done

- v1 to v2 cutover (2026-11-18): the v1 Worker, database and code were removed; the two demo products were not copied.
- A client was invited and signed in (2026-11-17), and the test business with its admin and staff accounts was used to check access requests and sign-in on 2026-11-19.
