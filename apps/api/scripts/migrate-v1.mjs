// Copy products from the v1 ShopList into a v2 organization, through v2's public import API.
//
//   V2_URL=https://shoplist-v2.technology1.workers.dev ORG_ID=org_… API_KEY=sl_live_… \
//     node apps/api/scripts/migrate-v1.mjs            # dry run: shows what would be sent
//   … node apps/api/scripts/migrate-v1.mjs --apply    # writes
//
// Safe to repeat: it uses upsert mode keyed on SKU, so a second run reports "unchanged".
// Create the API key in v2 (Settings → API keys) with the "Write inventory" permission, and revoke it afterwards.
// Nothing is deleted anywhere; v1 is only read.

const V1 = (process.env.V1_URL ?? 'https://shoplist.technology1.workers.dev').replace(/\/$/, '');
const V2 = (process.env.V2_URL ?? '').replace(/\/$/, '');
const { ORG_ID, API_KEY } = process.env;
const apply = process.argv.includes('--apply');

if (apply && !(V2 && ORG_ID && API_KEY)) {
  console.error('Set V2_URL, ORG_ID and API_KEY to use --apply.');
  process.exit(1);
}

/** Read every v1 product, following pages until `total` is reached. */
async function readV1() {
  const all = [];
  for (let page = 1; ; page++) {
    const res = await fetch(`${V1}/api/products?limit=100&page=${page}`);
    if (!res.ok) throw new Error(`v1 returned ${res.status}`);
    const body = await res.json();
    all.push(...body.products);
    if (all.length >= body.total || body.products.length === 0) return all;
  }
}

const cents = (v) => Math.max(0, Math.round(Number(v) * 100));

/** v1 row → v2 import row. v1 prices are decimals; v2 stores minor units. */
export function toRow(p) {
  const row = { sku: String(p.sku || `V1-${p.id}`).trim().slice(0, 64), name: String(p.name).trim().slice(0, 200), priceMinor: cents(p.price), quantity: Math.max(0, Math.trunc(Number(p.quantity) || 0)) };
  if (p.description) row.description = String(p.description).slice(0, 5000);
  return row;
}

const products = await readV1();
const rows = products.map(toRow);
console.log(`v1: ${products.length} product(s) read`);
const seen = new Set();
for (const r of rows) {
  if (seen.has(r.sku)) console.warn(`warning: duplicate SKU ${r.sku}; the later row overwrites the earlier`);
  seen.add(r.sku);
}

if (!apply) {
  console.table(rows.map((r) => ({ sku: r.sku, name: r.name, price: (r.priceMinor / 100).toFixed(2), qty: r.quantity })));
  console.log('Dry run. Nothing written. Add --apply to import.');
  process.exit(0);
}

const totals = { created: 0, updated: 0, unchanged: 0, errors: 0 };
for (let i = 0; i < rows.length; i += 100) {
  const batch = rows.slice(i, i + 100);
  const res = await fetch(`${V2}/api/v1/orgs/${ORG_ID}/products/import`, {
    method: 'POST',
    headers: { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
    body: JSON.stringify({ mode: 'upsert', rows: batch }),
  });
  const body = await res.json();
  if (!res.ok) { console.error(`v2 refused batch at ${i}: ${res.status} ${body.detail ?? ''}`); process.exit(1); }
  for (const k of Object.keys(totals)) totals[k] += body.summary[k];
  for (const r of body.results) if (r.status === 'error') console.error(`  row ${i + r.index} (${r.sku}): ${r.error}`);
}
console.log('Done', totals);
process.exit(totals.errors ? 2 : 0);
