// Fills a ShopList with believable demo data, so every screen has something real-looking to show.
//
//   Local (development sign-in, fills everything including the owner console):
//     npm run dev -w @shoplist/api -- --var DEV_AUTH:true --var INSECURE_DEV_COOKIES:true --var SIGNIN_MODE:open
//     node apps/api/scripts/seed-demo.mjs
//
//   A real deployment (uses one API key, so it can only add products, stock and orders to that one business):
//     node apps/api/scripts/seed-demo.mjs --url https://your-host --org org_xxxx --key sl_live_xxxxx
//
// Run it once on an empty business. It never deletes anything. All people and addresses use example.com or .example.

const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => (a.startsWith('--') ? [a.slice(2), all[i + 1]?.startsWith('--') || all[i + 1] === undefined ? 'true' : all[i + 1]] : [])).filter((x) => x.length));
const BASE = (args.url ?? process.env.BASE_URL ?? 'http://localhost:8787').replace(/\/$/, '');
const KEY = args.key ?? null;
const origin = new URL(BASE).origin;

// A fixed seed, so two runs make the same shop.
let seed = 20261119;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ipn = 0;
const fakeIp = () => `10.${(ipn >> 16) & 255}.${(ipn >> 8) & 255}.${ipn++ & 255}`;

/** One request. Retries when rate limited, and returns { status, json, cookie }. */
async function call(auth, method, path, body, extra = {}) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const headers = { origin, accept: 'application/json', ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...extra };
    if (!KEY) headers['cf-connecting-ip'] = fakeIp();
    if (method !== 'GET') headers['idempotency-key'] = crypto.randomUUID();
    if (auth?.cookie) headers.cookie = auth.cookie;
    if (KEY) headers.authorization = `Bearer ${KEY}`;
    const res = await fetch(BASE + '/api/v1' + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    if (res.status === 429) { await sleep(Number(res.headers.get('retry-after') ?? 2) * 1000); continue; }
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    const cookie = res.headers.get('set-cookie')?.match(/((?:__Host-)?sl_session=[^;]+)/)?.[1];
    if (KEY) await sleep(120); // a real deployment rate limits one client; stay well under it
    return { status: res.status, json, cookie };
  }
  throw new Error(`Too many 429s on ${method} ${path}`);
}
const must = async (p, what) => { const r = await p; if (r.status >= 400) throw new Error(`${what} failed: ${r.status} ${JSON.stringify(r.json)?.slice(0, 300)}`); return r.json; };
const ok = async (p) => { const r = await p; return r.status < 400 ? r.json : null; }; // for steps that may legitimately refuse (plan limits, approvals)
const log = (m) => console.log(m);

// ------------------------------------------------------------------ the shop
const CATALOG = {
  kitchen: [
    ['Ceramic mixing bowl set (3 pc)', 3400], ['Acacia wood cutting board', 2800], ['Cast iron skillet 10 in', 4200], ['Stainless steel kettle 1.7 L', 3900],
    ['Linen apron', 2200], ['Glass storage jars (set of 4)', 2600], ['Olive wood spoon set', 1800], ['French press 1 L', 3100],
    ['Enamel Dutch oven 5.5 qt', 8900], ['Bamboo utensil holder', 1500], ['Salt and pepper grinder set', 2400], ['Pour-over coffee dripper', 2000],
  ],
  decor: [
    ['Woven seagrass basket', 3200], ['Matte ceramic vase, tall', 3600], ['Framed botanical print', 4500], ['Soy candle, cedar and sage', 2200],
    ['Soy candle, fig', 2200], ['Macrame wall hanging', 3800], ['Round wall mirror 24 in', 8800], ['Brass candle holders (pair)', 2900],
    ['Walnut serving tray', 3300], ['Terracotta planter, small', 1400],
  ],
  garden: [
    ['Galvanized watering can', 2700], ['Herb garden kit', 2400], ['Teak outdoor bench', 18900], ['Cedar bird feeder', 2600],
    ['Garden trowel set', 1900], ['Ceramic planter, large', 3900], ['Outdoor string lights 25 ft', 3400], ['Wall-mount hose reel', 4700],
  ],
  lighting: [
    ['Linen table lamp', 5900], ['Rattan pendant light', 7200], ['LED desk lamp', 3600], ['Edison bulbs (6 pack)', 2200], ['Arc floor lamp', 11900], ['Paper lantern set', 1800],
  ],
  bath: [
    ['Organic cotton bath towel', 2800], ['Teak bath mat', 4800], ['Ceramic soap dispenser', 1600], ['Linen shower curtain', 4400], ['Bamboo bath caddy', 4200], ['Turkish hand towels (3)', 3200],
  ],
  textiles: [
    ['Linen duvet cover, queen', 12900], ['Wool throw blanket', 7800], ['Cotton cushion cover', 1800], ['Jute area rug 5 x 8', 14900], ['Linen napkins (set of 4)', 2400], ['Waffle weave blanket', 6400],
  ],
  storage: [
    ['Wicker laundry hamper', 5400], ['Oak wall shelf', 3800], ['Bamboo shoe rack', 3600], ['Cube organizer', 4900], ['Hanging jute baskets', 2900], ['Coat hook rail', 2100],
  ],
};
const PREFIX = { kitchen: 'KIT', decor: 'DEC', garden: 'GAR', lighting: 'LGT', bath: 'BTH', textiles: 'TEX', storage: 'STO' };
const CUSTOMERS = [
  ['Hannah Brooks', 'US'], ['Oliver Grant', 'GB'], ['Sofia Martinez', 'US'], ['Liam Chen', 'CA'], ['Emma Wilson', 'AU'], ['Noah Fischer', 'DE'],
  ['Ava Thompson', 'US'], ['Lucas Moreau', 'FR'], ['Mia Johansson', 'SE'], ['Ethan Patel', 'GB'], ['Isla Murray', 'CA'], ['Jack Turner', 'US'],
];
const TEAM = [
  ['Jordan Ellis', 'manager'], ['Priya Nair', 'sales'], ['Tom Becker', 'stock'], ['Lena Fischer', 'accountant'], ['Sam Okafor', 'viewer'],
];
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '.').replace(/^\.|\.$/g, '');

/** Adds products with opening stock; returns them with the stock level they were given. */
async function addProducts(auth, base, defaultLoc) {
  const made = [];
  let n = 0;
  for (const [cat, items] of Object.entries(CATALOG)) {
    for (const [name, price] of items) {
      n++;
      const initial = rnd() < 0.08 ? 0 : rnd() < 0.18 ? int(2, 6) : int(8, 90);
      const body = {
        sku: `${PREFIX[cat]}-${String(n).padStart(3, '0')}`, name, priceMinor: price, costMinor: Math.round(price * (0.38 + rnd() * 0.17)),
        unit: 'each', tags: [cat, ...(rnd() < 0.25 ? ['bestseller'] : []), ...(rnd() < 0.15 ? ['new'] : [])],
        description: `${name}. Small-batch, sourced from independent makers.`,
        barcode: String(int(100000000000, 999999999999)), reorderPoint: initial > 20 ? 10 : 6, initialQuantity: initial,
      };
      const r = await call(auth, 'POST', `${base}/products`, body);
      if (r.status >= 400) { log(`  stopped adding products at ${n - 1}: ${r.status} ${r.json?.detail ?? ''}`); return made; }
      made.push({ ...(r.json.product ?? r.json), qty: initial, cat });
    }
  }
  return made;
}

async function addOrders(auth, base, products, locId, count, customers = []) {
  const channels = ['shopify', 'shopify', 'shopify', 'amazon', 'ebay', 'woocommerce', 'phone', 'manual'];
  const states = [];
  for (let i = 0; i < count; i++) {
    const lines = [];
    const seen = new Set();
    for (let k = int(1, 4); k > 0; k--) {
      const p = pick(products);
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      // A few orders ask for more than is on the shelf, so some end up waiting for stock.
      lines.push({ productId: p.id, quantity: rnd() < 0.06 ? int(40, 70) : int(1, 3) });
    }
    const [name, country] = customers.length && rnd() < 0.5 ? pick(customers).slice(0, 2) : pick(CUSTOMERS);
    const r = await call(auth, 'POST', `${base}/orders`, { customerName: name, customerEmail: `${slug(name)}@example.com`, country, channel: pick(channels), paid: rnd() < 0.7, locationId: locId, lines, ...(rnd() < 0.2 ? { note: pick(['Gift, please wrap', 'Leave with the neighbour', 'Deliver after 5 pm', 'Repeat customer']) } : {}) });
    if (r.status >= 400) { log(`  orders stopped at ${i}: ${r.status} ${r.json?.detail ?? ''}`); break; }
    const o = r.json.order ?? r.json;
    states.push(o);
    // Changing an order needs the version you saw, sent as If-Match.
    const ifMatch = { 'if-match': `"${o.version ?? 1}"` };
    if (o.state === 'ready_to_ship' && rnd() < 0.75) await ok(call(auth, 'POST', `${base}/orders/${o.id}/ship`, {}, ifMatch));
    else if (o.state === 'payment_required' && rnd() < 0.12) await ok(call(auth, 'POST', `${base}/orders/${o.id}/cancel`, {}, ifMatch));
  }
  return states;
}

// ================================================================== a real deployment: one key, one business
if (KEY) {
  log(`Filling the business behind this API key at ${BASE} ...`);
  const orgId = args.org;
  if (!orgId) throw new Error('Add --org <business id> (it is in the address of the app: /o/<id>/orders).');
  const base = `/orgs/${orgId}`;
  const locId = (await must(call(null, 'GET', `${base}/locations`), 'locations')).data.find((l) => l.isDefault)?.id;
  const products = await addProducts(null, base, locId);
  log(`  ${products.length} products`);
  const orders = await addOrders(null, base, products, locId, 40);
  log(`  ${orders.length} orders`);
  log('Done. Customers, suppliers, counts and team need a signed-in admin, so they are not added with a key.');
  process.exit(0);
}

// ================================================================== local: everything
async function login(email, name, superAdmin = false) {
  const r = await call(null, 'POST', '/auth/dev/login', { email, name, ...(superAdmin ? { superAdmin: true } : {}) });
  if (r.status >= 400 || !r.cookie) throw new Error(`Dev sign-in failed (${r.status}). Was the server started with --var DEV_AUTH:true, and is it running at ${BASE}?`);
  return { cookie: r.cookie, user: r.json?.user };
}
log(`Filling ${BASE} with demo data ...`);

// The owner signs in first: new businesses start on the Free plan, and the demo shop needs Standard.
const owner = await login('owner@shoplist.example', 'Platform Owner', true);

// ---- the main business: Willow & Pine Home Store
const maya = await login('maya.collins@willowpine.example', 'Maya Collins');
const org = (await must(call(maya, 'POST', '/orgs', { name: 'Willow & Pine Home Store' }), 'create business')).organization;
const base = `/orgs/${org.id}`;
await must(call(owner, 'PATCH', `/admin/orgs/${org.id}/plan`, { plan: 'standard' }), 'set plan');
await must(call(maya, 'PATCH', `${base}/settings`, {
  legalName: 'Willow & Pine Home Store LLC', address: '218 Fairmount Avenue, Portland, OR 97214, USA', phone: '+1 503 555 0142', email: 'hello@willowpine.example', taxId: 'US-84-1290077',
  currency: 'USD', taxMode: 'exclusive', taxRateBp: 825, timezone: 'America/Los_Angeles', orderPrefix: 'WP-', poPrefix: 'PO-', invoicePrefix: 'INV-', defaultReorderPoint: 6,
  approvals: { largeAdjustment: { on: true, units: 15, valueMinor: 50000 }, damage: { on: true }, countVariance: { on: true, units: 10 }, cancelPaid: { on: true }, priceDrop: { on: true, percent: 30 } },
}), 'settings');

const main = (await must(call(maya, 'GET', `${base}/locations`), 'locations')).data.find((l) => l.isDefault);
const warehouse = (await must(call(maya, 'POST', `${base}/locations`, { name: 'Warehouse', code: 'WH' }), 'warehouse')).location;
const popup = (await must(call(maya, 'POST', `${base}/locations`, { name: 'Pop-up stall', code: 'POP' }), 'pop-up')).location;
log('  business, settings and three locations');

const products = await addProducts(maya, base, main.id);
log(`  ${products.length} products`);

// Move some stock to the warehouse and the stall, and receive a delivery there.
for (const p of products.filter((x) => x.qty > 30).slice(0, 14)) {
  await ok(call(maya, 'POST', `${base}/stock/transfers`, { productId: p.id, fromLocationId: main.id, toLocationId: warehouse.id, quantity: int(8, 20), note: 'Restock the warehouse' }));
}
for (const p of products.filter((x) => x.cat === 'decor' || x.cat === 'kitchen').slice(0, 8)) {
  await ok(call(maya, 'POST', `${base}/stock/transfers`, { productId: p.id, fromLocationId: main.id, toLocationId: popup.id, quantity: int(2, 5), note: 'Weekend market' }));
}
for (const p of products.slice(0, 10)) {
  await ok(call(maya, 'POST', `${base}/stock/movements`, { productId: p.id, locationId: warehouse.id, delta: int(20, 60), reason: 'receive', reference: 'PO-DEMO', note: 'Supplier delivery' }));
}
for (const p of products.slice(20, 23)) await ok(call(maya, 'POST', `${base}/stock/movements`, { productId: p.id, locationId: main.id, delta: -1, reason: 'damage', note: 'Cracked in the stockroom' }));
log('  stock moves');

// Customers
const customers = [];
for (const [name, country] of CUSTOMERS) {
  const r = await ok(call(maya, 'POST', `${base}/customers`, { name, email: `${slug(name)}@example.com`, phone: `+1 555 01${int(10, 99)}`, address: `${int(10, 990)} ${pick(['Oak', 'Maple', 'Cedar', 'Elm', 'Birch'])} Street, ${pick(['Portland', 'Seattle', 'Toronto', 'Leeds', 'Hamburg'])}`, note: rnd() < 0.3 ? 'Prefers email' : undefined }));
  if (r) customers.push({ ...(r.customer ?? r), name, country });
}
log(`  ${customers.length} customers`);

const orders = await addOrders(maya, base, products, main.id, 46);
log(`  ${orders.length} orders`);

// Suppliers and purchase orders in every state
const supplierDefs = [
  ['Hartwell Ceramics', 'orders@hartwell-ceramics.example', 14], ['Northwind Textiles', 'sales@northwind-textiles.example', 21],
  ['Cedar & Co. Woodworks', 'hello@cedarco.example', 10], ['Brightside Lighting', 'trade@brightside.example', 18], ['Greenleaf Garden Supply', 'orders@greenleaf.example', 7],
];
const suppliers = [];
for (const [name, email, lead] of supplierDefs) {
  const r = await ok(call(maya, 'POST', `${base}/suppliers`, { name, email, phone: `+1 555 02${int(10, 99)}`, leadTimeDays: lead, note: 'Net 30' }));
  if (r) suppliers.push(r.supplier ?? r);
}
const poStates = ['draft', 'sent', 'sent', 'partial', 'received', 'cancelled'];
let poCount = 0;
for (const st of poStates) {
  const lines = [];
  for (const p of [...products].sort(() => rnd() - 0.5).slice(0, int(2, 4))) lines.push({ productId: p.id, quantity: int(10, 40), unitCostMinor: p.costMinor ?? Math.round(p.priceMinor * 0.45) });
  const exp = new Date(Date.now() + int(3, 20) * 86400_000).toISOString().slice(0, 10);
  const r = await ok(call(maya, 'POST', `${base}/purchase-orders`, { supplierId: pick(suppliers).id, locationId: warehouse.id, expectedAt: exp, note: pick(['Spring restock', 'Back-to-school', 'Holiday pre-order', 'Replacement for damaged goods']), lines }));
  if (!r) continue;
  const po = r.order ?? r.purchaseOrder ?? r;
  poCount++;
  if (st === 'draft') continue;
  if (st === 'cancelled') { await ok(call(maya, 'POST', `${base}/purchase-orders/${po.id}/send`, {})); await ok(call(maya, 'POST', `${base}/purchase-orders/${po.id}/cancel`, {})); continue; }
  await ok(call(maya, 'POST', `${base}/purchase-orders/${po.id}/send`, {}));
  if (st === 'partial') await ok(call(maya, 'POST', `${base}/purchase-orders/${po.id}/receive`, { lines: [{ lineId: po.lines[0].id, quantity: Math.max(1, Math.floor(po.lines[0].quantity / 2)) }] }));
  if (st === 'received') await ok(call(maya, 'POST', `${base}/purchase-orders/${po.id}/receive`, { lines: po.lines.map((l) => ({ lineId: l.id, quantity: l.quantity })) }));
}
log(`  ${suppliers.length} suppliers, ${poCount} purchase orders`);

// The team: each person signs in once and accepts an invitation
const staff = {};
for (const [name, role] of TEAM) {
  const email = `${slug(name)}@willowpine.example`;
  const inv = await ok(call(maya, 'POST', `${base}/invitations`, { email, role }));
  if (!inv) continue;
  const token = inv.link.split('/invite/')[1];
  const who = await login(email, name);
  await ok(call(who, 'POST', `/invitations/${token}/accept`, {}));
  staff[role] = who;
}
log(`  ${Object.keys(staff).length} team members`);

// Approvals: the stock keeper makes big adjustments, the manager decides on one.
if (staff.stock) {
  const big = products.filter((p) => p.qty > 40).slice(0, 3);
  for (const p of big) await ok(call(staff.stock, 'POST', `${base}/stock/movements`, { productId: p.id, locationId: main.id, delta: -int(16, 25), reason: 'adjust', note: 'Stock take correction' }));
  const pending = (await ok(call(staff.manager ?? maya, 'GET', `${base}/approvals?state=pending`)))?.data ?? [];
  if (pending[0] && staff.manager) await ok(call(staff.manager, 'POST', `${base}/approvals/${pending[0].id}/approve`, {}));
}

// Counts: one finished with a variance, one waiting
const kitchenTask = await ok(call(maya, 'POST', `${base}/count-tasks`, { title: 'Kitchen shelf count', locationId: main.id, scope: { kind: 'tag', tag: 'kitchen' }, dueAt: new Date(Date.now() - 86400_000).toISOString().slice(0, 10), blind: true }));
if (kitchenTask) {
  const t = kitchenTask.task ?? kitchenTask;
  const detail = await ok(call(maya, 'GET', `${base}/count-tasks/${t.id}`));
  const lines = (detail?.task ?? detail)?.lines ?? [];
  if (lines.length) {
    await ok(call(maya, 'POST', `${base}/count-tasks/${t.id}/lines`, { lines: lines.map((l, i) => ({ productId: l.productId, counted: Math.max(0, (l.expected ?? 10) + (i % 4 === 0 ? -2 : 0)) })) }));
    await ok(call(maya, 'POST', `${base}/count-tasks/${t.id}/submit`, {}));
  }
}
await ok(call(maya, 'POST', `${base}/count-tasks`, { title: 'Weekend market stock check', locationId: popup.id, scope: { kind: 'all' }, dueAt: new Date(Date.now() + 3 * 86400_000).toISOString().slice(0, 10), blind: true }));
log('  counts');

// An API key, to show the page
await ok(call(maya, 'POST', `${base}/api-keys`, { name: 'Shopify sync', scopes: ['inventory:read', 'products:write', 'stock:write'] }));

// ---- other businesses, so the owner console has a list
const others = [
  ['Harbor Coffee Roasters', 'elena.rossi@harborcoffee.example', 'Elena Rossi', [['Ethiopia Guji, 250 g', 1800], ['Colombia Huila, 250 g', 1650], ['House blend, 1 kg', 4200], ['Cold brew concentrate', 1400], ['Ceramic pour-over set', 5200], ['Paper filters (100)', 600]]],
  ['Northside Bike Works', 'marcus.webb@northsidebikes.example', 'Marcus Webb', [['Inner tube 700c', 900], ['Chain lube 120 ml', 800], ['LED light set', 2400], ['Helmet, adult M', 4900], ['Bar tape, black', 1800], ['Floor pump', 3600], ['Patch kit', 500]]],
];
const extra = [];
for (const [name, email, person, items] of others) {
  const admin = await login(email, person);
  const o = (await must(call(admin, 'POST', '/orgs', { name }), 'create other business')).organization;
  const b = `/orgs/${o.id}`;
  const loc = (await must(call(admin, 'GET', `${b}/locations`), 'loc')).data.find((l) => l.isDefault);
  const ps = [];
  for (const [i, [pn, price]] of items.entries()) {
    const r = await ok(call(admin, 'POST', `${b}/products`, { sku: `${name.slice(0, 3).toUpperCase()}-${100 + i}`, name: pn, priceMinor: price, costMinor: Math.round(price * 0.5), tags: [], unit: 'each', initialQuantity: int(5, 50) }));
    if (r) ps.push({ ...(r.product ?? r), qty: 10 });
  }
  await addOrders(admin, b, ps, loc.id, 8);
  extra.push({ id: o.id, name, admin });
}
for (const [name, email] of [['Lakeside Pottery Studio', 'amy@lakesidepottery.example'], ['Ridgeline Outfitters', 'dan@ridgeline.example']]) {
  await ok(call(owner, 'POST', '/admin/orgs', { name, adminEmail: email, currency: 'USD' }));
}
await ok(call(owner, 'POST', '/admin/announcements', { message: 'Scheduled maintenance on Sunday at 02:00 UTC. ShopList stays readable.', severity: 'info', audience: 'everyone' }));
// Support: the owner asks Willow & Pine for access (left pending); Harbor Coffee opens a window by itself.
await ok(call(owner, 'POST', `/admin/orgs/${org.id}/access-requests`, { minutes: 60, reason: 'Tax totals on invoices look different from the report', write: false }));
if (extra[0]) await ok(call(extra[0].admin, 'POST', `/orgs/${extra[0].id}/support-grants`, { minutes: 60, note: 'Imported orders show the wrong channel' }));
log('  two more businesses, two invited, a notice and support requests');

log('\nDone. Sign in as:');
log('  business admin  maya.collins@willowpine.example  (Willow & Pine Home Store)');
for (const [name, role] of TEAM) log(`  ${role.padEnd(14)}  ${slug(name)}@willowpine.example`);
log('  owner           owner@shoplist.example  (use the dev sign-in at /owner when running locally)');
log(JSON.stringify({ orgId: org.id }));
