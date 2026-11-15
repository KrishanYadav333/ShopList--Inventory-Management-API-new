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
