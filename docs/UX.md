# User Experience

## Who uses ShopList

| Person | Context | What they need most |
|---|---|---|
| **Owner** of a small shop | Laptop in the evening, phone during the day | See what is running low and what stock is worth, in seconds |
| **Floor staff** | Phone in one hand, product in the other, in a stockroom | Scan, adjust, done. Large targets, no typing |
| **Inventory manager** | Desktop, many products | Bulk edits, imports, filters, keyboard speed, a trustworthy history |
| **Developer** | Integrating a web shop | Clear API docs, keys, webhooks |

## Core flows and their targets

| Flow | Target |
|---|---|
| First sign-in to first product added | Under 60 seconds, with sample data offered |
| Find a product | Results while typing, under 150 ms for catalogs up to 50,000 products |
| Scan a barcode and adjust stock on a phone | 3 taps, under 5 seconds |
| Receive a delivery of 20 lines | Under 2 minutes using scan or paste |
| Answer "what changed and who did it?" | One click from any product |
| Undo a mistake | Every delete and stock change offers undo for 10 seconds |

## Visual direction: keep the orders dashboard look

v2 keeps the layout and visual language of the existing orders dashboard (`frontend/index.html`): a dark left sidebar with the logo, status filters with count badges and filter controls; a blue top bar with breadcrumb, search and action buttons; a data table with avatar icons, status pills and a column settings gear. That design is the reference. The screens below reuse it for inventory:

| Dashboard element | Becomes |
|---|---|
| Sidebar status list (Payment Required / Waiting for Stock / Ready to Ship) | Stock status filters: In stock / Low stock / Out of stock, with live counts |
| Sidebar filter controls (weight, items, country) | Location, tag and price filters |
| Top bar search | Product search (name, SKU, barcode) |
| NEW / SKIP / PICK / PRINT buttons | New product / Import / Adjust stock / Export |
| Orders table | Products table with stock per location and status pills |

New components (dialogs, toasts, forms) are styled to match it. Where this document describes a design-system token or layout that differs, the existing dashboard wins.

## Information architecture

```
Sign in
└── Organization switcher
    ├── Dashboard        totals, low stock, recent activity
    ├── Products         table and grid, filters, bulk actions
    │   └── Product      details, stock per location, history, audit
    ├── Stock
    │   ├── Adjust       scan or search, enter quantity and reason
    │   ├── Receive      multi-line intake
    │   ├── Transfer     between locations
    │   ├── Count        cycle count with variance review
    │   └── History      full ledger with filters
    ├── Locations
    ├── Import / Export
    └── Settings         organization, members, API keys, webhooks, audit log, my sessions and passkeys
```

## Key screens

### Dashboard

- Four tiles: products, inventory value, low stock, out of stock. Each tile is a link to the filtered product list.
- "Needs attention" list: low and out-of-stock items with a one-tap "Receive" action.
- Recent activity: the last 20 movements, with who and why.

### Products

- **Table view** on desktop (sortable columns, sticky header, virtualized rows so 50,000 products scroll smoothly). **Card view** on phones.
- Instant search across name, SKU, barcode and description, with matches highlighted.
- Filters shown as removable chips: location, stock status, tags. Filters live in the URL, so a filtered view can be bookmarked or shared.
- Multi-select with bulk actions: edit tags, adjust stock, export, delete.
- Inline quick edit of price and reorder point. Optimistic update, with rollback and a clear message if the save fails.

### Product details

- Header: name, SKU, barcode, price, status badge.
- Stock by location, with on hand, reserved and available.
- History tab: ledger entries with balance after each movement, filterable by reason.
- Audit tab: field-level changes ("Price: $12.00 → $14.50 by Anna, 2 hours ago").

### Stock adjust (mobile first)

1. Tap **Scan** to open the camera (the `BarcodeDetector` API where supported, with a small fallback library), or search.
2. Product appears with current stock. Large **−** and **+** buttons, or type a number.
3. Choose a reason from chips (Sale, Receive, Damage, Count…). Last-used reason is preselected.
4. **Save**. A toast confirms the new balance and offers **Undo** for 10 seconds.

### Conflict resolution

When a save returns `412`, the form does not discard the user's work. It shows a side-by-side of "your change" and "current value" for each conflicting field, with **Keep mine** and **Use theirs**.

### Import

1. Drop a CSV or paste from a spreadsheet.
2. Map columns, with automatic matching of common headers.
3. Preview the first 20 rows with every validation error marked inline.
4. Start the import. Progress shows on the page and continues if the user navigates away. A summary lists created, updated and failed rows, with failed rows downloadable for fixing.

## Every state is designed

| State | Behavior |
|---|---|
| Loading | Skeletons shaped like the final content after 150 ms; nothing before that, to avoid flicker |
| Empty (new org) | Explains the next step, with **Add product**, **Import CSV** and **Load sample data** |
| Empty (no search results) | "No products match '…'" with a **Clear filters** action |
| Error | Plain-language message from the API's `detail`, a **Try again** button, and the request id for support |
| Offline | Banner at the top; cached data stays visible and read-only; edits are blocked with an explanation |
| Permission denied | Controls the role cannot use are hidden; direct links show "Ask an admin for access" |
| Rate limited or daily limit reached | "ShopList is busy, retrying in N seconds", with automatic retry |
| Saving | Button shows progress and is disabled to prevent double submits; idempotency keys make retries safe anyway |

## Design system

- **Tokens:** colors, spacing, radii, shadows and type as CSS variables, with light and dark themes. Theme follows the system setting and can be overridden.
- **Type:** system font stack for speed; tabular numbers for all quantities and money so columns line up.
- **Spacing:** 4 px base grid.
- **Color:** one brand accent. Status colors (green in stock, amber low, red out) are always paired with an icon and text, never color alone.
- **Components:** button, input, select, combobox, dialog, sheet (mobile), toast, table, tabs, badge, tooltip, command palette. Built on Radix primitives for correct focus and keyboard behavior.
- **Motion:** 150 to 200 ms ease-out for feedback; respects `prefers-reduced-motion`.

## Keyboard

| Keys | Action |
|---|---|
| `Ctrl/⌘ K` | Command palette: jump to any product, page or action |
| `/` | Focus search |
| `N` | New product |
| `J` / `K` | Next / previous row |
| `E` | Edit selected product |
| `Esc` | Close dialog or clear selection |
| `?` | Show all shortcuts |

## Accessibility

Target: **WCAG 2.2 Level AA**.

- All functionality works by keyboard, with a visible focus ring.
- Contrast at least 4.5:1 for text and 3:1 for interface elements, in both themes.
- Touch targets at least 44 × 44 px on mobile.
- Form fields have visible labels; errors are announced and linked with `aria-describedby`.
- Toasts and live results use polite live regions; undo is reachable by keyboard.
- Tested with axe in CI and manually with VoiceOver and NVDA before each release.

## Performance budgets

| Metric | Budget (p75, mid-range phone on 4G) |
|---|---|
| Largest Contentful Paint | ≤ 2.0 s |
| Interaction to Next Paint | ≤ 150 ms |
| Cumulative Layout Shift | ≤ 0.05 |
| JavaScript on first load | ≤ 170 KB gzip; routes beyond the dashboard load on demand |
| API p95 at the edge | Reads ≤ 80 ms, writes ≤ 150 ms |

Budgets are enforced in CI with Lighthouse CI and a bundle size check. A pull request that breaks a budget fails.

## Progressive web app

- Installable on phones and desktops.
- Static assets cached by a service worker for instant repeat loads.
- Last-viewed product lists cached for offline reading. Offline writes are out of scope for v2 because conflicting offline stock changes need a dedicated design.

## Internationalization

- All strings in message files from day one; English ships first, German second.
- Money, numbers and dates formatted with `Intl` using the org's currency and the user's locale.
