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
