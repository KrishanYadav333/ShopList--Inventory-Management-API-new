// Load and correctness test against a running local server.
const B = process.env.BASE_URL ?? 'http://localhost:8787';
const ORIGIN = B;
let n = 0;
const ip = () => `10.${(n >> 16) & 255}.${(n >> 8) & 255}.${n++ & 255}`;

async function req(cookie, method, path, body, extra = {}) {
  const t = performance.now();
  const res = await fetch(B + '/api/v1' + path, {
    method,
    headers: { origin: ORIGIN, 'cf-connecting-ip': ip(), ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...extra },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, ms: performance.now() - t, json: text ? JSON.parse(text) : null, res };
}

const pct = (arr, p) => [...arr].sort((a, b) => a - b)[Math.min(arr.length - 1, Math.floor(arr.length * p))];
const report = (label, results, wall) => {
  const ms = results.map((r) => r.ms);
  const by = {};
  for (const r of results) by[r.status] = (by[r.status] ?? 0) + 1;
  console.log(`${label.padEnd(44)} n=${String(results.length).padStart(4)}  p50=${pct(ms, 0.5).toFixed(0).padStart(4)}ms  p95=${pct(ms, 0.95).toFixed(0).padStart(4)}ms  max=${Math.max(...ms).toFixed(0).padStart(4)}ms  ${(results.length / (wall / 1000)).toFixed(0).padStart(4)} req/s  status=${JSON.stringify(by)}`);
};
const timed = async (fn) => { const t = performance.now(); const r = await fn(); return [r, performance.now() - t]; };

// --- setup
const email = `load-${Date.now()}@example.com`;
const login = await fetch(B + '/api/v1/auth/dev/login', { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json', 'cf-connecting-ip': ip() }, body: JSON.stringify(process.env.SUPER_ADMIN ? { email, superAdmin: true } : { email }) });
const cookie = login.headers.get('set-cookie').match(/((?:__Host-)?sl_session=[^;]+)/)[1];
const org = (await req(cookie, 'POST', '/orgs', { name: 'Load Test' })).json.organization.id;
const base = `/orgs/${org}`;
const loc = (await req(cookie, 'GET', `${base}/locations`)).json.data[0].id;
const idem = () => ({ 'idempotency-key': crypto.randomUUID() });

// --- 1. seed 300 products with bounded concurrency
const [seed, seedMs] = await timed(async () => {
  const out = [];
  for (let i = 0; i < 300; i += 25) {
    out.push(...(await Promise.all(Array.from({ length: 25 }, (_, j) => req(cookie, 'POST', `${base}/products`, { sku: `LT-${i + j}`, name: `Load item ${i + j}`, priceMinor: 1000 + i + j, costMinor: 500, reorderPoint: 5, initialQuantity: 10, tags: ['load', i % 2 ? 'odd' : 'even'] }, idem())))));
  }
  return out;
});
report('seed: create 300 products (25 parallel)', seed, seedMs);
if (seed.some((r) => r.status !== 201)) { console.log('SEED FAILED', seed.find((r) => r.status !== 201)?.json); process.exit(1); }
const pid = seed[0].json.product.id;

// --- 2. oversell race: 400 parallel sales of 1 unit against 10 in stock
const [race, raceMs] = await timed(() => Promise.all(Array.from({ length: 400 }, () => req(cookie, 'POST', `${base}/stock/movements`, { productId: pid, locationId: loc, delta: -1, reason: 'sale' }, idem()))));
report('race: 400 parallel sales vs 10 in stock', race, raceMs);
const sold = race.filter((r) => r.status === 201).length;
const final = (await req(cookie, 'GET', `${base}/products/${pid}`)).json.product.onHand;
console.log(`  -> sold=${sold} (want 10), refused=${race.filter((r) => r.status === 409).length}, final on hand=${final} (want 0)  ${sold === 10 && final === 0 ? 'PASS' : 'FAIL'}`);

// --- 3. idempotent retry storm: same key 100 times in parallel
const key = crypto.randomUUID();
const storm = await Promise.all(Array.from({ length: 100 }, () => req(cookie, 'POST', `${base}/stock/movements`, { productId: seed[1].json.product.id, locationId: loc, delta: 5, reason: 'receive' }, { 'idempotency-key': key })));
const ids = new Set(storm.map((r) => r.json?.movement?.id));
const after = (await req(cookie, 'GET', `${base}/products/${seed[1].json.product.id}`)).json.product.onHand;
console.log(`idempotency storm: 100 identical requests -> ${ids.size} distinct movement(s) (want 1), on hand=${after} (want 15)  ${ids.size === 1 && after === 15 ? 'PASS' : 'FAIL'}`);

// --- 4. read latency: list, search, dashboard with 300 products
const run = async (label, make, count, conc) => {
  const out = [];
  const t = performance.now();
  for (let i = 0; i < count; i += conc) out.push(...(await Promise.all(Array.from({ length: Math.min(conc, count - i) }, make))));
  report(label, out, performance.now() - t);
  return out;
};
await run('GET list (50/page), 20 parallel', () => req(cookie, 'GET', `${base}/products?limit=50`), 200, 20);
await run('GET search "load item 1", 20 parallel', () => req(cookie, 'GET', `${base}/products?q=load%20item%201`), 200, 20);
await run('GET filter stock=low, 20 parallel', () => req(cookie, 'GET', `${base}/products?stock=low`), 200, 20);
await run('GET dashboard, 20 parallel', () => req(cookie, 'GET', `${base}/dashboard`), 200, 20);
await run('POST stock +1 (distinct keys), 20 parallel', () => req(cookie, 'POST', `${base}/stock/movements`, { productId: seed[2].json.product.id, locationId: loc, delta: 1, reason: 'receive' }, idem()), 200, 20);

// --- 5. paging through all 300 products
let cursor = null, seen = new Set(), pages = 0;
const tp = performance.now();
do {
  const r = await req(cookie, 'GET', `${base}/products?limit=50&sort=name${cursor ? `&cursor=${cursor}` : ''}`);
  r.json.data.forEach((p) => seen.add(p.id));
  cursor = r.json.nextCursor; pages++;
} while (cursor);
console.log(`paging: ${pages} pages, ${seen.size} unique products (want 300) in ${(performance.now() - tp).toFixed(0)}ms  ${seen.size === 300 ? 'PASS' : 'FAIL'}`);

// --- 6. counters vs reality after all that
const dash = (await req(cookie, 'GET', `${base}/dashboard`)).json;
const all = [];
let c2 = null;
do { const r = await req(cookie, 'GET', `${base}/products?limit=200${c2 ? `&cursor=${c2}` : ''}`); all.push(...r.json.data); c2 = r.json.nextCursor; } while (c2);
const wantValue = all.reduce((s, p) => s + p.onHand * (p.costMinor ?? p.priceMinor), 0);
const wantLow = all.filter((p) => p.status === 'low').length, wantOut = all.filter((p) => p.status === 'out').length;
console.log(`counters: dashboard value=${dash.inventoryValueMinor} vs recomputed=${wantValue}; low ${dash.lowStock}/${wantLow}; out ${dash.outOfStock}/${wantOut}  ${dash.inventoryValueMinor === wantValue && dash.lowStock === wantLow && dash.outOfStock === wantOut && dash.products === all.length ? 'PASS' : 'FAIL'}`);
