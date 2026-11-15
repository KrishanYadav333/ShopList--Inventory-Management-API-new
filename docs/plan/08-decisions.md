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
2. I update the plan with your answers and mark it **Approved** in [README.md](README.md).
3. We build **Phase 1** (F7, F1, F2, F3, F4, F5, F6), one feature per commit, each deployed and
   smoke-tested, and report after each.
4. Phase 2a, 2b and 3 follow the same way. You can reorder or drop features between phases.
