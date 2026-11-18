# Demo data and screenshots

A seed script fills a local ShopList with a believable business, so every screen has something real-looking on it, and so a smaller round of testing can be done by clicking through. The README screenshots are taken from it.

Nothing here touches production unless you point it there on purpose, and in that case it can only add to one business.

## Start a local server

```bash
npm install --legacy-peer-deps
npm run build -w @shoplist/web
npx wrangler d1 migrations apply shoplist-control --local --config apps/api/wrangler.jsonc
npm run dev -w @shoplist/api -- --var DEV_AUTH:true --var INSECURE_DEV_COOKIES:true --var SIGNIN_MODE:open
```

Flags go on the command line, not in `apps/api/.dev.vars`: the test runner reads that file too, and the dev flags change how the tests behave. `DEV_AUTH` is a development-only sign-in; it refuses to run unless it is exactly `true`, and it is never set in production.

To start from nothing again, stop the server and delete `apps/api/.wrangler/state`, then migrate again.

## Fill it

```bash
node apps/api/scripts/seed-demo.mjs
```

Run it once, on an empty database. It never deletes anything. The same seed always makes the same shop. Every person and address uses `example.com` or `.example`, so no real mailbox is involved.

### What it creates

| What | Detail |
|---|---|
| **Willow & Pine Home Store** (Standard plan) | A home-goods shop in Portland: 3 locations (Main store, Warehouse, Pop-up stall), 54 products in 7 categories with costs, prices, barcodes and tags, stock spread across the locations, a few out of stock and a few low |
| Orders | 46 orders from Shopify, Amazon, eBay, WooCommerce, phone and manual, in every state: payment required, waiting for stock, ready to ship, shipped, cancelled |
| Customers | 12, in the US, Canada, the UK, Germany, Australia, France and Sweden |
| Purchasing | 5 suppliers and 6 purchase orders: draft, sent, partly received, received and cancelled |
| Counts and approvals | A finished count with variances, an open count, and pending and decided approvals (rules switched on) |
| Team | Five people, one per role, who each signed in and accepted an invitation |
| Settings | Business details, tax (8.25% exclusive), time zone, order and invoice prefixes, an API key |
| Two more businesses | Harbor Coffee Roasters and Northside Bike Works, with products and orders, so the owner console has a list |
| Two invited businesses | Lakeside Pottery Studio and Ridgeline Outfitters, waiting for their admins |
| Owner extras | A platform notice, a pending access request to Willow & Pine, and an open support window from Harbor Coffee |

### Accounts (local only)

| Role | Email |
|---|---|
| Business admin | `maya.collins@willowpine.example` |
| Manager | `jordan.ellis@willowpine.example` |
| Sales | `priya.nair@willowpine.example` |
| Stock keeper | `tom.becker@willowpine.example` |
| Accountant | `lena.fischer@willowpine.example` |
| Viewer | `sam.okafor@willowpine.example` |
| Owner | `owner@shoplist.example` (the development sign-in at `/owner`) |

All dates are "today": the server stamps rows with the current time, so reports show one day of sales.

### Extras for the owner console

Health scores, job runs, backups and security alerts are produced by the nightly and hourly jobs, which do not run in a local server on demand. For screenshots they were filled in directly in the local database. If you want them, run `apps/api/scripts/demo-extras.sql` with
`npx wrangler d1 execute shoplist-control --local --file apps/api/scripts/demo-extras.sql`.

## Filling a real deployment

A real deployment cannot use the development sign-in. Instead, an admin makes an API key (Settings, API keys) and the script uses it. A key can only add products, stock and orders to its own business, so customers, suppliers, counts and the team are not added.

```bash
node apps/api/scripts/seed-demo.mjs --url https://your-host --org org_xxxxxxxx --key sl_live_xxxxxxxx
```

The business id is in the address of the app (`/o/<id>/orders`). It adds 54 products and 40 orders at a gentle pace to stay under the rate limit. Revoke the key afterwards.

## Regenerate the README screenshots

Needs Node 22 and any Chromium (for example Chrome, or the `chrome-headless-shell` that Puppeteer downloads).

```bash
CHROME="/path/to/chrome" node apps/api/scripts/screenshots.mjs
```

It signs in with the development sign-in, visits twelve screens and writes PNGs to `docs/screenshots/`. Take them from a freshly seeded database so the numbers match the README.

## A short test pass with this data

1. Sign in as the admin (`maya.collins@willowpine.example`) and open Orders. Ship an order that is ready, and mark a "payment required" order as paid.
2. Open Approvals and approve one adjustment, reject the other.
3. Sign in as the sales teammate and check that Settings, Reports and cost prices are hidden or refused.
4. As the admin, open Settings, Support access, and approve the pending request. Then sign in as the owner, open Support, and open the window: the banner should say read-only.
5. As the owner, open Operations and Security and resolve an alert.
