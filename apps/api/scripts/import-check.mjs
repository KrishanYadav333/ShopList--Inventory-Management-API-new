// Imports 20,000 products (200 batches of 100) into a fresh org on a local server and checks the counts,
// including a few deliberately bad rows that must be reported, not swallowed.
const B = process.env.BASE_URL ?? 'http://localhost:8787';
const h = { origin: B, 'content-type': 'application/json' };
const login = await fetch(`${B}/api/v1/auth/dev/login`, { method: 'POST', headers: h, body: JSON.stringify({ email: `import-${Date.now()}@example.com` }) });
const cookie = login.headers.get('set-cookie').match(/((?:__Host-)?sl_session=[^;]+)/)[1];
const call = (m, p, body, extra = {}) => fetch(`${B}/api/v1${p}`, { method: m, headers: { ...h, cookie, ...extra }, body: body && JSON.stringify(body) }).then(async (r) => ({ status: r.status, json: await r.json() }));
const org = (await call('POST', '/orgs', { name: 'Import check' })).json.organization.id;
const rows = Array.from({ length: 20000 }, (_, i) => ({ sku: `IMP-${String(i).padStart(5, '0')}`, name: `Imported ${i}`, priceMinor: 100 + (i % 900), quantity: i % 40 }));
for (const i of [7, 9999, 19990]) rows[i] = { ...rows[i], priceMinor: -5 }; // invalid on purpose
const t = performance.now();
const totals = { created: 0, errors: 0 };
let next = 0;
async function worker() {
  while (next < rows.length) {
    const start = next; next += 100;
    const r = await call('POST', `/orgs/${org}/products/import`, { mode: 'create', rows: rows.slice(start, start + 100) }, { 'idempotency-key': crypto.randomUUID() });
    if (r.status !== 200) { console.error('batch failed', start, r.status, r.json); process.exit(1); }
    totals.created += r.json.summary.created; totals.errors += r.json.summary.errors;
  }
}
await Promise.all(Array.from({ length: 4 }, worker));
const secs = (performance.now() - t) / 1000;
const dash = (await call('GET', `/orgs/${org}/dashboard`)).json;
console.log(`imported in ${secs.toFixed(1)}s:`, totals, 'dashboard total products:', dash.totalProducts ?? dash.counts?.all ?? JSON.stringify(dash).slice(0, 200));
const ok = totals.created === 19997 && totals.errors === 3;
console.log(ok ? 'PASS: 19,997 created, 3 bad rows reported' : 'FAIL');
process.exit(ok ? 0 : 1);
