# 03 · Phase 2a: running the business (F8–F18)

**Goal:** give each job the tools it actually needs: settings for the admin; approvals, reports,
purchasing and counts for the manager; customers and invoices for sales; tasks and scoped access for
the stock keeper; read-only numbers for the accountant.

**Order:** F8 → F17 → F9 → F11 → F10 → F12 → F13 → F14 → F15 → F16 → F18.
Settings first (others read them), the accountant role early (small, and reports need it),
notifications before approvals (approvals notify), rollups before reorder suggestions (they use them).
**Estimate:** 5–6 weeks.

---

## F8 · Business settings

**Why.** Currency is fixed at USD today and there is nowhere to put tax, numbering or the business's
own details, which invoices (F16) and reports (F12) need.

**Who.** Admin (`settings:manage`). Everyone reads the parts that affect display (currency, timezone).

**Settings (Settings → Business):**

| Group | Field | Default | Used by |
|---|---|---|---|
| Identity | Legal name, address, phone, email, tax id (e.g. GSTIN, VAT no.), logo (later) | empty | Invoices, PO links |
| Money | Currency (ISO code) | USD | Every price display |
| Money | Tax mode: none, inclusive, exclusive | none | Orders, invoices |
| Money | Default tax rate (basis points, e.g. 1800 = 18%) | 0 | Orders |
| Time | Timezone (IANA, e.g. Asia/Kathmandu) | UTC | Reports' day boundaries, dates |
| Numbering | Order prefix (e.g. `SO-`), PO prefix (`PO-`), invoice prefix (`INV-`) | `#`, `PO-`, `INV-` | Numbers |
| Stock | Default reorder point for new products; allow negative stock (off) | 0, off | Products, movements |
| Approvals | Rules (F10) | off | Approvals |

**Changing currency** after data exists is allowed only while the business has no orders, because
existing prices would silently change meaning. After that, the field is locked with an explanation.

**API.** `GET /orgs/:id/settings` (`inventory:read`, identity fields shaped for staff),
`PATCH /orgs/:id/settings` (`settings:manage`, validated, partial).
**Data.** `organizations.settings` JSON (validated by a Zod schema in `shared`), copied into the
Durable Object on change so it can apply rules without a D1 read per request.
**Tests.** Validation; currency lock; timezone affects report day boundaries; a manager gets 403 on PATCH.
**Effort:** M.

---

## F17 · Accountant role

**Why.** Bookkeepers and auditors need numbers (costs, valuation, reports, the activity log) without
the ability to change stock or orders.

**How it works.** A new role `accountant` with the permissions in [01-model.md §3.1](01-model.md#31-the-final-matrix).
Admins can invite or assign it like any other role.

**Data.** Migration adds `accountant` to the role CHECK on `memberships` and `invitations` (same
pattern as migration 0005).

**Tests.** Role walk test includes the new role automatically. **Effort:** S.

---

## F9 · Location scoping for staff

**Why.** A business with a shop and a warehouse does not want warehouse staff adjusting shop stock,
or a branch's sales staff shipping from another branch.

**Who.** The admin sets it per member. It applies to staff roles; admins are never scoped.

**How it works.**
- Settings → Team → a member → **Locations**: "All locations" (default) or a checklist.
- A scoped member can **see** stock at every location (so they can say "it's in the warehouse"),
  but every **write** is limited:
  - stock movements and counts: `locationId` must be in their list;
  - transfers: the **source** location must be in their list (they can send to anywhere);
  - orders: the fulfilment location must be in their list;
  - receiving a PO: the PO's location must be in their list.
- The UI pre-selects their location and hides others in location pickers for writes.

**API.** `PATCH /orgs/:id/members/:userId { locationIds: string[] | null }` (`team:manage`).
Violations: `403 location_not_allowed`.
**Data.** `memberships.location_ids` (JSON array or null); invitations can carry it too.
The Worker passes `locationIds` in the caller context; the Durable Object checks it in the same
transaction as the write.
**Edge cases.** Archiving a location removes it from everyone's list; a member left with an empty
list is treated as "no write access" (not "all"), and the admin is warned.
**Tests.** Scoped stock keeper: 201 at A, 403 at B, transfer A→B allowed, B→A refused; order at B refused.
**Effort:** M.

---

## F11 · In-app notifications

**Why.** People need to know when something needs them: stock is low, an order arrived, an approval
waits, a count task was assigned. Today nothing tells them.

**Who.** Everyone, each for what is relevant to their role.

**Events and who receives them (defaults; each person can switch kinds off):**

| Event | Sent to |
|---|---|
| Product went low or out of stock | manager, admin, and stock keepers scoped to that location |
| New order (from API or another user) | sales, manager |
| Order waiting for stock became ready to ship | sales, manager |
| Approval request created | everyone with `approvals:decide` |
| My approval request was decided | the requester |
| Count task assigned to me / overdue | the assignee; overdue also to the assigner |
| PO received in full or partly | the manager who created it |
| Invitation accepted | admin |
| Webhook failing repeatedly | admin |

**How it works.**
- A bell icon in the top bar with an unread count. Clicking opens a panel: newest first, grouped by
  day, each item links to the thing (order, product, approval).
- "Mark all as read". Items older than 60 days are deleted automatically.
- Settings → Notifications: per kind on or off. (Email delivery is F23.)
- The page refreshes the count every 60 seconds while visible (no WebSockets needed; cheap).

**Architecture.** The Durable Object already records events in its **outbox** for webhooks. The
queue consumer that delivers webhooks will also turn relevant events into notification rows, choosing
recipients from D1 memberships (role, location scope, preferences). This keeps the write path fast:
the user's request never waits for notifications.

**API.** `GET /me/notifications?cursor=` , `GET /me/notifications/unread-count`,
`POST /me/notifications/read { ids? }` (all if empty), `GET/PATCH /me/notification-preferences`.
**Data.** D1 `notifications(id, user_id, org_id, kind, title, link, payload, created_at, read_at)`,
D1 `notification_prefs(user_id, org_id, kind, enabled)`.
**Free plan.** One notification row per recipient per event. A busy shop with 300 orders a day and 3
sales staff is about 1,000 writes a day, well inside D1's 100,000.
**Tests.** Recipients chosen by role and scope; preferences respected; read state per user; a user
never sees another organization's notifications.
**Effort:** M.

---

## F10 · Approval rules and the approval queue

**Why.** Some actions are risky enough that one person should not do them alone: large stock
write-downs (shrinkage hides theft), damage write-offs, and cancelling an order after payment
(refund fraud). Managers and owners want to see and sign off on these.

**Who.** Requesters: anyone with the underlying permission but without `approvals:decide`.
Deciders: manager, admin. Admin configures the rules.

**Rules the admin can turn on (Settings → Business → Approvals):**

| Rule | Trigger | Default when switched on |
|---|---|---|
| Large adjustment | A negative adjustment of more than N units **or** worth more than X (at cost) | N = 20, X = 500.00 |
| Damage write-off | Any movement with reason `damage` | always |
| Count variance | A count that changes stock by more than N units or X% | N = 20 |
| Cancel paid order | Cancelling an order already marked paid | always |
| Price drop | Lowering a product's price by more than X% | 30% |

People with `approvals:decide` are never asked for approval; their action applies directly and is
logged as usual.

**How it works.**
1. A stock keeper records "-35 units, damage". The server sees a rule applies.
2. Instead of applying it, the server stores an **approval request** with the exact validated input
   and returns `202 Accepted { approval }`. The screen says "Sent for approval" with a link.
3. Managers and the admin get a notification. **Approvals** in the sidebar shows a badge.
4. The decider sees what was asked, by whom, the current stock, and the effect. They **Approve**
   (optionally with a note) or **Reject** (note required).
5. On approve, the server re-checks the action against **current** data (stock may have changed) and
   applies it through the same code path as a direct action, in one transaction. The ledger and
   activity log record both the requester and the approver.
6. If the re-check fails (for example the product was deleted), the request becomes `failed` with the
   reason, and the requester is notified.
7. The requester sees "My requests" with statuses. They can **withdraw** a pending request.
8. Requests expire after 7 days if nobody decides.

**States.** `pending → approved → applied`, `pending → rejected`, `pending → withdrawn`,
`pending → expired`, `approved → failed`.

**API.**
- Existing write routes may return `202 { approval }` instead of `201`.
- `GET /orgs/:id/approvals?state=&mine=` (requesters see their own; deciders see all)
- `POST /orgs/:id/approvals/:aid/approve { note? }`, `…/reject { note }`, `…/withdraw`
**Data.** Durable Object `approval_requests(id, kind, payload JSON, summary, requested_by, state,
decided_by, note, created_at, decided_at, expires_at, result_ref)`. Rules live in settings (F8).
**Rules and edge cases.**
- A requester cannot approve their own request, even if they later become a manager.
- Idempotency: approving twice applies once.
- The payload is validated again at approval time with the current schema.
- Large-adjustment value uses cost at the time of the request; if cost is unknown, only the unit
  threshold applies.
**Security.** Approval decisions are `approvals:decide` and audited; the payload cannot be edited
by the decider (approve or reject only, so the decider cannot change what is applied).
**Tests.** Each rule triggers; deciders bypass; approve applies exactly once; stale approve fails
cleanly; self-approval refused; expiry job works.
**Effort:** L.

---

## F12 · Reports

**Why.** Owners and managers make decisions from numbers: what sells, what sits, what goes missing,
what stock is worth. The accountant needs the same numbers for the books.

**Who.** `reports:read` (accountant, manager, admin). Money columns based on cost need `cost:read`
(all three have it).

**Reports (each with a date range, location filter, and CSV export):**

| Report | Shows | Question it answers |
|---|---|---|
| Sales summary | Per day: orders shipped, units, revenue, tax; totals | How much did we sell? |
| Sales by product | Units and revenue per product, ranked; margin when cost known | What sells? |
| Stock valuation | On hand × cost per product and location, as of now | What is our stock worth? |
| Movement summary | Units in and out by reason (receive, sale, return, adjust, damage, count, transfer) | Where did stock go? |
| Low and out of stock | Products under reorder point, with days of cover | What do we need? |
| Dead stock | Products with stock but no sale in N days (30/60/90), with value tied up | What isn't moving? |
| Shrinkage | Damage, negative adjustments and count losses, by product and person | What are we losing, and where? |
| Staff activity | Actions per person per day (orders, movements, approvals) | Who did what? (admin only) |

**Screens.** Reports page with a list of reports; each opens a filter bar, a summary row, a simple
chart (bars for days, no chart library: CSS bars) and a table. "Export CSV" downloads exactly what is
shown.

**Architecture: daily rollups.** Computing reports from the raw ledger gets slow as it grows. The
Durable Object will maintain a small table `daily_stats(day, product_id, location_id, sold_qty,
sold_minor, tax_minor, received_qty, returned_qty, adjusted_qty, damaged_qty, count_delta,
transfer_in, transfer_out)`, updated **in the same transaction** as each movement or shipment, so
it is always exact. "Day" uses the business's timezone (F8). A one-time backfill builds it from the
existing ledger when the migration runs. Reports read the rollup (hundreds of rows) instead of the
ledger (possibly hundreds of thousands).

**Limits.** Date range up to 366 days per request. CSV export up to 50,000 rows.
**API.** `GET /orgs/:id/reports/:name?from=&to=&location=&format=json|csv`.
**Tests.** Rollup equals a fresh computation from the ledger (an invariant check like I1); timezone
boundaries; permissions; CSV matches JSON.
**Effort:** L.

---

## F13 · Suppliers and purchase orders

**Why.** Stock arrives from suppliers. Today it is typed in as "receive" with no link to what was
ordered, so nobody knows what is on the way, what arrived short, or what it cost.

**Who.** Manager and admin create suppliers and POs (`purchasing:write`). Stock keepers receive
against them (`stock:write`). Accountant reads.

**How it works.**
1. **Suppliers**: name, contact, email, phone, lead time (days), notes. Products get an optional
   preferred supplier, supplier SKU and supplier price.
2. **Create a PO**: choose supplier and receiving location; add lines (product, quantity, unit cost;
   cost pre-filled from the supplier price). Optional expected date and note. Status `draft`.
3. **Send**: status `sent`. The PO shows a printable view (and in F25 a supplier link). The
   quantities now count as **on order** on the product screen.
4. **Receive**: a stock keeper opens the PO (or scans a product while a PO is open), enters received
   quantities per line. Each receipt writes `receive` movements referencing the PO, in one
   transaction. Partial receipts are allowed; status becomes `partially_received`, then `received`
   when all lines are complete. Over-receipt beyond 10% needs `approvals:decide` or an approval.
5. **Cost update**: each receipt updates the product's cost to the received unit cost (last cost).
   (Weighted average cost is a setting for later; see decisions.)
6. **Cancel or close short**: a manager can cancel a draft/sent PO or close a partly received one
   ("supplier won't send the rest"); remaining quantities stop counting as on order.

**Numbers.** `PO-0001` style, from the prefix in settings.
**API.** `/orgs/:id/suppliers` (CRUD), `/orgs/:id/purchase-orders` (list, create, get, patch while
draft), `POST …/:poId/send`, `POST …/:poId/receive { lines: [{ lineId, quantity }] }`,
`POST …/:poId/cancel`, `POST …/:poId/close`.
**Data.** Durable Object tables `suppliers`, `purchase_orders`, `po_lines`; products gain
`supplier_id`, `supplier_sku`, `supplier_price_minor`, `on_order` (maintained counter).
**Tests.** Partial and full receipts; on-order counter invariant; scoped stock keeper limited to the
PO's location; cancelled POs cannot be received; receipts idempotent.
**Effort:** L.

---

## F14 · Reorder suggestions

**Why.** "What should I order, and how much?" is the question every shop owner asks weekly.

**Who.** Manager, admin.

**How it works.** **Purchasing → Reorder** lists products where *available + on order* is below the
reorder point, or where projected stock runs out within the supplier's lead time. For each:

- **Average daily sales** over the last 30 days (from `daily_stats`).
- **Days of cover** = available ÷ average daily sales.
- **Suggested quantity** = average daily sales × (lead time + 14 days of cover) − (available + on order),
  rounded up, never below zero; if there are no sales, it tops up to the reorder point.

The manager ticks lines and clicks **Create purchase orders**: one draft PO per supplier, which they
review and send. Formula constants (14 days) are a business setting.

**API.** `GET /orgs/:id/purchasing/reorder`, `POST /orgs/:id/purchasing/reorder/draft { productIds }`.
**Tests.** Formula on fixed data; products without a supplier listed separately; drafts grouped by supplier.
**Effort:** M.

---

## F15 · Count tasks

**Why.** Full stocktakes stop the business. Counting a few products often (cycle counting) catches
errors early. It needs to be assigned and tracked, and counts are more honest when the counter does
not see the expected number.

**Who.** Manager and admin assign (`counts:assign`); stock keepers count.

**How it works.**
1. The manager creates a task: location, which products (all, a tag, a list, or "not counted in 30
   days"), assignee, due date, and **blind** (on by default: the counter does not see expected
   quantities).
2. The assignee sees it under **My tasks**, opens it on a phone, scans or searches each product and
   enters the counted quantity.
3. Submitting writes `count` movements only for differences, through the existing counts logic
   (and approvals for big variances, F10).
4. The manager sees a summary: products counted, variances, value of the variance.
5. Overdue tasks notify the assignee and assigner (F11).

**API.** `/orgs/:id/count-tasks` (create, list, get), `POST …/:taskId/lines { productId, counted }`
(save progress), `POST …/:taskId/submit`, `POST …/:taskId/cancel`.
**Data.** Durable Object `count_tasks`, `count_task_lines (expected snapshot at submit time, counted)`.
**Edge cases.** Stock that moves during counting: expected is taken at submit, not at creation, and
movements in between are shown to the manager.
**Tests.** Blind tasks never return expected quantities to the assignee; only the assignee or a
manager can submit; variances become exact count movements.
**Effort:** M.

---

## F16 · Customers, tax and printable invoices and receipts

**Why.** Sales staff repeat-type the same customers, cannot see a customer's history, and cannot give
a customer a proper invoice. Many countries require tax shown on invoices.

**Who.** Sales, manager, admin. Contact details need `customers:read`.

**How it works.**
- **Customers**: name, email, phone, address, tax id, note. Created automatically from the first
  order with a new email, or by hand. The order form searches customers as you type.
- **Customer page**: their orders, total spent, last order date.
- **Tax** (from settings, F8): each order line stores the tax rate applied; the order stores
  subtotal, tax and total. In inclusive mode prices already include tax; in exclusive mode tax is added.
- **Invoice and receipt**: an order's **Print** button opens a clean printable page (business
  details, customer, lines, tax, totals, invoice number, date) that uses the browser's own
  "Save as PDF". No PDF library, so no bundle growth. Invoice number = prefix + order number.
  "Receipt" is the same page titled Receipt, shown once paid.
- Old orders without a customer are linked by a one-time migration that groups by email (or name
  when there is no email).

**API.** `/orgs/:id/customers` (CRUD, search), orders accept `customerId`, `GET /orgs/:id/orders/:oid/document?type=invoice|receipt`.
**Data.** Durable Object `customers`; `orders.customer_id`, `subtotal_minor`, `tax_minor`, `total_minor`; `order_lines.tax_rate_bp`.
**Tests.** Tax math in both modes (rounding per line, half-up); invoice totals equal order totals;
stock keepers get no contact fields.
**Effort:** L.

---

## F18 · Narrower API key scopes

**Why.** An online store integration needs to create orders, not edit products. A reporting tool
needs to read, not write. Today a key is either read or read+write everything.

**How it works.** Creating a key shows checkboxes: Read inventory (always), Write products, Write
stock, Write orders, Read reports, See costs. Optional location limit and expiry (built).
Existing `inventory:write` keys keep working as "all three writes".

**Tests.** Each scope allows exactly its routes; old keys unchanged. **Effort:** S.
