# Owner console plan (O1 to O6)

Written 2026-11-18. Status: **planned, not built.** Nothing here changes the three access levels in [01-model.md](01-model.md).

## Why this plan exists

The owner (developer, super admin) runs the platform, not a business. Today `/admin` is one long page of sections and the owner has no first-glance answer to "is everything fine, and who needs me?". The vet clinic ERP's super-admin roadmap (`Projects/vet-clinic-erp/docs/super-admin/SUPER_ADMIN_ROADMAP.md`, 21 features) was compared with ShopList; the gaps that matter at this size are below. Everything else on that list is parked on purpose (see the end).

Principles, all inherited from the existing system:

1. The owner is never a member of a business. Business tools never appear in the owner's own console.
2. The owner enters a business only through a window its admin opened, and every step is audited on both sides.
3. No new paid service. Everything runs on the free Cloudflare plan, the hourly cron and D1.
4. No emojis anywhere (see [../README.md](../README.md)).

## Order of work

| Step | Feature | Why this order | Effort |
|---|---|---|---|
| 1 | O5 Console structure | Every later screen needs a home | 1.5 days |
| 2 | O4 System status | Creates the cron run record that O1 and O3 read | 1 day |
| 3 | O2 Security alerts | Uses the existing sign-in events | 1.5 days |
| 4 | O3 Business health | Reads backups, usage and sign-ins | 1.5 days |
| 5 | O1 Owner dashboard | Summarizes steps 2 to 4 | 1 day |
| 6 | O6 Test business and runbook | Can be done any time, needs your email choice | 0.5 day |

Each step ships on its own: migration first, then deploy, then CI green. No step needs the one before it to be reverted if it is rolled back.

---

## O5. Console structure

**Why.** One scrolling page hides things. A labeled sidebar, as in the business app, makes each job one click.

**Who.** Owner only.

**How it works.**
- After the owner signs in at `/owner` they land on `/admin` (Overview). `/` redirects the owner to `/admin`.
- The console gets its own sidebar with the same labeled-row design as the business sidebar: Overview, Businesses, People, Security, Operations, Notices, Support, Activity.
- Existing sections move, nothing is removed:
  - Businesses: onboard a business, the businesses list and detail (plan, suspend, restore, transfer admin, cancel deletion).
  - People: users list and detail, disable and enable, sign out everywhere.
  - Security: sign-in summary and notable events now, alerts in O2.
  - Operations: nightly backups and restore, usage against free limits, system status (O4), business health (O3).
  - Notices: announcements and maintenance.
  - Support: open windows (Look only or Hands-on), with an Open button.
  - Activity: platform audit.
- Each page is lazy-loaded so the initial bundle stays within budget (about 130 KB gzip).
- Inside a support window the owner sees the business app with the banner, exactly as built. No other business screen is reachable.

**Screens.** Eight routes under `/admin/*`, one sidebar component shared by all of them.

**API.** None new. Existing `/admin/*` routes are reused.

**Data.** None.

**Rules and edge cases.**
- A non-owner who opens `/admin/*` is redirected to `/`, as today.
- The mobile drawer works the same as the business sidebar.
- Deep links keep working: `/admin` still opens, old anchors (`#h-backups`) are mapped to the new pages once.

**Security.** Route guard on every page plus the existing `super` access on every API route. The route registry test already fails if a route lacks an access declaration.

**Tests.** A non-owner cannot open any `/admin/*` page. axe check on each page (0 violations). Keyboard-only walk of the sidebar.

**Done when.** Every existing admin action is reachable from the new sidebar, the initial bundle is unchanged, and all current admin tests pass.

---

## O4. System status

**Why.** The hourly job does the platform's housekeeping (digests, usage alerts, backups, reminders, deletions, pruning). If it fails, nothing says so until a customer notices.

**Who.** Owner only.

**How it works.**
- Each step of `dailyJob` records a row when it finishes: job name, UTC hour, start, end, ok or failed, short error, small JSON detail (for example how many businesses were backed up).
- The Operations page shows a Status card:
  - last run of every job with its result and age;
  - failures in the last 7 days;
  - last backup run (from `backup_runs`);
  - email sent today against the caps (50 per business, 250 per platform) and today's failed sends;
  - the health URL, with a note that an outside uptime checker is the only thing that can tell you the whole Worker is down.
- A job that fails in two consecutive runs creates a platform notice (new kind `system.alert`) and an email to the owner, once per day per job.

**API.** `GET /admin/status` (owner only).

**Data.** Migration `0022_cron_runs.sql`:
- `cron_runs(id, job, hour_utc, started_at, finished_at, ok, error, detail)` with an index on `(job, started_at DESC)`. Rows older than 30 days are pruned by the existing 03 UTC prune step.
- A `failed` counter beside the existing daily send counters in `email_counts` (check `src/email.ts` for the exact table shape before writing the migration).

**Rules and edge cases.**
- Recording a run must never throw: a failure to write the record is swallowed and logged, so it cannot break the job it describes.
- A job that never ran in the last 26 hours (hourly) or 50 hours (daily) is shown as "not running".

**Security.** No secrets, no customer data, no email addresses in `error` or `detail`; errors are cut to 200 characters.

**Tests.** A failing job records `ok = 0` and the next run still happens. Two failures send exactly one alert. The status route refuses non-owners.

**Done when.** Breaking a job on purpose in a test shows it on the card and sends one notice.

---

## O2. Security alerts

**Why.** The Security page lists events. A list nobody owns is not a workflow: an alert needs a state, a note, and a record of what was done.

**Who.** Owner only.

**How it works.**
- The hourly job turns four existing detections into alerts: five or more refused sign-ins for one email in a week, any refused attempt at the owner's GitHub door, an admin signing in from a new country, and a "this was not me" report.
- An alert has a severity (high for the owner door and not-me reports, medium for the other two), a count, first and last seen, and a state: Open, Investigating, Resolved, Dismissed.
- The owner opens an alert, changes the state, and may add a note. Each change is written to the platform audit.
- A new alert sends one in-app notice (new kind `security.alert`) and an email under the existing preferences and caps. A repeat of the same thing updates the count; it does not notify again the same day.

**Screens.** Security page: an Alerts table (filter by state), a detail panel with the related events and the note box, and the existing summary below it.

**API.**
- `GET /admin/security/alerts?state=` 
- `PATCH /admin/security/alerts/:id` with `{ state, note? }`

**Data.** Migration `0023_security_alerts.sql`: `security_alerts(id, kind, severity, subject, dedupe_key UNIQUE, count, first_at, last_at, state, note, updated_at, updated_by)`. `subject` is an email hash or user id, never a raw email. Resolved and dismissed alerts are pruned after 180 days.

**Rules and edge cases.**
- Dedupe key is kind plus subject plus day, so one noisy address makes one alert per day, not one per attempt.
- Resolving an alert does not block a new one if it happens again on a later day.
- Notes are plain text, 500 characters.

**Security.** No IP addresses are stored (unchanged). The note field is escaped on display.

**Tests.** Five refusals make one alert. The sixth updates the count. State changes are audited. Non-owners get 404. A resolved alert reopens as a new row the next day.

**Done when.** A simulated attack in a test produces one alert, one notice, and one audit row per state change.

---

## O3. Business health

**Why.** With many businesses the owner cannot open each one. A short, explained signal shows who needs help or is drifting away.

**Who.** Owner only.

**How it works.**
- At 03 UTC, next to the backup, each business gets a score from four visible parts:
  - Activity, 40 points: stock moves and orders in the last 14 days.
  - Admin sign-in, 20 points: the admin signed in within 7 days (full), 30 days (half), never (zero).
  - Backups, 20 points: nightly copies succeeded over the last 7 days.
  - Limit headroom, 20 points: below 70 percent of the plan's product and location limits (full), 70 to 100 percent (half), at the limit (zero).
- Label: Healthy 70 or more, Watch 40 to 69, At risk under 40. A business younger than 14 days is shown as New and not scored.
- The Operations page lists businesses worst first. Each row shows the score and the four parts with their points, so the number can always be explained. A link opens the business detail.
- Counts only. No product names, customers or amounts are read or shown.

**API.** `GET /admin/health`.

**Data.** Migration `0024_org_health.sql`: `org_health(org_id, day, score, parts, PRIMARY KEY (org_id, day))`; 90 days kept.

**Rules and edge cases.**
- Suspended and scheduled-for-deletion businesses are listed under their own labels, not scored.
- A business with no activity because it is seasonal is shown as Watch, not failed. The score is a prompt to look, not a judgment.
- The weights live in one constant in `packages/shared` so they can be tuned without a migration.

**Security.** Uses numbers the owner already sees on the business detail page. No new access to business data.

**Tests.** A silent business scores low, an active one scores high, a new one shows New, the parts add up to the score, the route is owner only.

**Done when.** The test business from O6 moves from New to Healthy after normal use.

---

## O1. Owner dashboard

**Why.** The first screen should say whether anything needs attention.

**Who.** Owner only.

**How it works.** The Overview page has two parts.
- Counters: businesses (active, suspended, scheduled for deletion, created in the last 30 days), people (total, disabled, active sessions), the sign-in mode (owner-only, invite-only or open).
- An Attention list, empty when all is well, with one line per item and a link to the right page:
  - failed or missing backups last night (O4);
  - a job not running (O4);
  - open security alerts (O2);
  - businesses At risk (O3);
  - usage over 70 percent of a free allowance (existing);
  - open support windows, with the mode shown (existing);
  - invitations older than 7 days that were never accepted.

**API.** Extend `GET /admin/overview` with an `attention` array of `{ kind, label, count, link }`.

**Data.** None new. It reads what O2 to O4 and the existing tables already hold.

**Rules and edge cases.** If one source fails to load, only its line shows "could not load"; the rest still renders.

**Tests.** Each attention source appears when its condition is true and disappears when it is not.

**Done when.** With everything healthy the list is empty and says so.

---

## O6. Test business and test admin

**Why.** The owner must not test inside a customer's business, and the owner cannot test business screens as the owner (by design they are not a member).

**Who.** You, with a separate email address.

**How it works (a runbook, almost no code).**
1. You give me an email for the test admin. A Gmail plus-address (`name+shoplist-test@gmail.com`) delivers to your own inbox and counts as a separate account.
2. From `/admin`, Businesses, you onboard "ShopList Test Co" for that email. The invitation link comes back to you.
3. You open the link in a private window, sign in through `/login`, and you are that business's admin.
4. As that admin you invite further test emails as manager, sales, stock, accountant and viewer to check each role.
5. Optional later: a small script `apps/api/scripts/seed-test.mjs` that creates sample products and orders through the API using that admin's own session, never the owner's.
6. Also test the support path end to end: as the admin allow Look only, then Hands-on with a reason; as the owner open it from Support and confirm the banner, the audit entries on both sides, and that delete is refused.
7. When finished, schedule the test business for deletion from its Settings (14 days, cancellable) or purge it from `/admin`.

**Rules.** I create nothing in production until you give the email and say go. The test business is named "Test" so it is never confused with a customer.

**Done when.** One person has signed in as test admin and as at least one staff role, and the support walk-through passed.

---

## Decisions with defaults

These are assumed unless you say otherwise.

| Question | Default |
|---|---|
| Health weights (40, 20, 20, 20) and the 70 and 40 cut-offs | As written above, tunable in one constant |
| Email the owner for new security alerts and job failures | Yes, under the existing preferences and caps |
| How long to keep resolved alerts and run records | 180 days for alerts, 30 days for cron runs, 90 days for health scores |
| Where the test business lives | Production, named "Test", removed when finished |
| Order of building | O5, O4, O2, O3, O1, then O6 whenever you send the email |

## Parked on purpose

| Item | Why it waits |
|---|---|
| Login as a person (impersonation) | Replaced by Hands-on support (consent, reason, time limit, no deletes, shown as "ShopList support"). The vet ERP's own Enterprise Hub makes the same choice. |
| Billing and payments | Plans are set by hand; there is nothing to reconcile. |
| Integration Hub, API and Developer Management | Each business already has its own API keys and webhooks; a platform-wide layer has no user yet. |
| Master Data Management | One shared catalog across businesses would break the one-database-per-business isolation. |
| Helpdesk with tickets | Email plus a support window covers it for now. |
| AI Admin Assistant | No data worth asking it about yet. |
| Editable sign-in policy screen | The sign-in mode is a deploy setting and changes rarely. Revisit if you change it often. |

## Docs to update when each step ships

`docs/API.md` (new routes), `docs/SECURITY.md` (alerts, status), `docs/OPERATIONS.md` (the status card and what to do when a job fails), `docs/ROADMAP.md` (tick the step), and the route table in `src/docs.ts` (a test requires every route to be documented).
