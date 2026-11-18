# What only the owner can do

The code is finished for everything the plan describes. These steps need your accounts or your decision.

## Secrets to rotate (they were pasted into a chat)
Decision 2026-11-18: the owner chose not to rotate these for now. The Brevo key and Cloudflare token are in a chat transcript; revisit if the transcript is ever shared.

Create a new one, set it with `npx wrangler secret put NAME` (from `apps/api`), then delete the old one at the provider.

| Secret | Where to make a new one |
|---|---|
| `BREVO_API_KEY` | Brevo → SMTP & API → API keys |
| `CF_ANALYTICS_TOKEN` | Cloudflare → My Profile → API Tokens (only "Account Analytics: Read") |
| `GITHUB_CLIENT_SECRET` | GitHub → Settings → Developer settings → OAuth Apps |
| `CLERK_SECRET_KEY` | Clerk dashboard → API keys |

## Clerk dashboard
Done: phone number and username are off, so clients sign in with email only.

## Test a real client
Done 2026-11-17: the owner invited a client email and the client signed in successfully.

## When you can enable them
- **R2**: create a bucket `shoplist-backups`; nightly copies can then move out of D1 (they currently sit in the same account).
- **Analytics Engine**: enable at `https://dash.cloudflare.com/<account>/workers/analytics-engine`, then add `"analytics_engine_datasets": [{ "binding": "ANALYTICS", "dataset": "shoplist_requests" }]` to `apps/api/wrangler.jsonc` and deploy. The per-business list on the usage page then fills in.
- **Own email domain**: add SPF and DKIM for a domain you own in Brevo, then change `EMAIL_FROM`, so mail is less likely to land in spam.

## Decisions
- **v1 to v2 cutover**: see OPERATIONS.md. Not started because it retires the old site.
- **Physical phone and VoiceOver checks**: need a person with the device.
