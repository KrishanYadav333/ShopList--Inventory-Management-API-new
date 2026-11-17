import { describe, expect, it } from 'vitest';
import { addMember, call, defaultLocation, newOrg, product, stub } from './helpers';

const today = () => new Date().toISOString().slice(0, 10);

async function shop() {
  const admin = await newOrg();
  const a = await product(admin, { sku: 'A-1', name: 'Alpha', priceMinor: 1000, costMinor: 400, initialQuantity: 50, reorderPoint: 10 });
  const b = await product(admin, { sku: 'B-1', name: 'Beta', priceMinor: 500, costMinor: 100, initialQuantity: 30 });
  const loc = await defaultLocation(admin);
  const mv = (p: { id: string }, delta: number, reason: string) => call(admin.cookie, 'POST', `${admin.base}/stock/movements`, { productId: p.id, locationId: loc, delta, reason });
  await mv(a, -5, 'sale');
  await mv(a, 20, 'receive');
  await mv(a, -2, 'damage');
  await mv(a, -3, 'adjust');
  const o = (await call(admin.cookie, 'POST', `${admin.base}/orders`, { customerName: 'Rita', paid: true, lines: [{ productId: a.id, quantity: 4 }] })).body.order;
  await call(admin.cookie, 'POST', `${admin.base}/orders/${o.id}/ship`, {}, { 'if-match': `"${o.version}"` });
  return { admin, a, b, loc };
}
const get = (who: { cookie: string }, base: string, name: string, qs = '') => call(who.cookie, 'GET', `${base}/reports/${name}${qs}`);

describe('F12 reports', () => {
  it('sales, sales by product, movements and shrinkage add up to what happened', async () => {
    const { admin } = await shop();
    const sales = (await get(admin, admin.base, 'sales')).body;
    expect(sales.totals).toEqual({ units: 9, revenue: 4000 }); // 5 manual + 4 shipped; revenue from the shipped order only
    const byProduct = (await get(admin, admin.base, 'sales-by-product')).body;
    expect(byProduct.rows[0]).toMatchObject({ sku: 'A-1', units: 9, revenue: 4000, cost: 3600, margin: 400 });
    const mv = (await get(admin, admin.base, 'movements')).body.rows;
    const units = (r: string) => mv.find((x: { reason: string }) => x.reason === r).units;
    expect(units('Received')).toBe(50 + 30 + 20); // initial stock counts as received
    expect(units('Sold')).toBe(-9);
    expect(units('Damaged')).toBe(-2);
    expect(units('Adjusted')).toBe(-3);
    const shrink = (await get(admin, admin.base, 'shrinkage')).body;
    expect(shrink.rows[0]).toMatchObject({ sku: 'A-1', damaged: 2, adjusted_down: 3, units: 5, value: 5 * 400 });
  });

  it('valuation, low stock and dead stock reflect the shelves', async () => {
    const { admin } = await shop();
    const val = (await get(admin, admin.base, 'valuation')).body;
    // A: 50-5+20-2-3-4 = 56 on hand at 4.00; B: 30 at 1.00
    expect(val.totals).toEqual({ on_hand: 86, value: 56 * 400 + 30 * 100 });
    const dead = (await get(admin, admin.base, 'dead-stock', '?days=30')).body;
    expect(dead.rows.map((r: { sku: string }) => r.sku)).toEqual(['B-1']); // Alpha sells, Beta does not
    await call(admin.cookie, 'POST', `${admin.base}/stock/movements`, { productId: (await call(admin.cookie, 'GET', `${admin.base}/products?q=Alpha`)).body.data[0].id, locationId: (await call(admin.cookie, 'GET', `${admin.base}/locations`)).body.data[0].id, delta: -50, reason: 'sale' });
    const low = (await get(admin, admin.base, 'low-stock')).body;
    expect(low.rows[0]).toMatchObject({ sku: 'A-1', on_hand: 6 });
    expect(low.rows[0].days_of_cover).toBeTypeOf('number');
  });

  it('the rollup always equals the ledger (invariant I8) and the daily ledger check still passes', async () => {
    const { admin } = await shop();
    const check = await stub(admin.orgId).verifyIntegrity();
    expect(check).toEqual({ ok: true, drift: [] });
  });

  it('CSV matches the table, neutralises formulas, and ranges are validated', async () => {
    const admin = await newOrg();
    await product(admin, { sku: 'X-1', name: '=HYPERLINK("evil")', initialQuantity: 3, costMinor: 100 });
    const res = await call(admin.cookie, 'GET', `${admin.base}/reports/valuation?format=csv`);
    expect(res.headers.get('content-type')).toContain('text/csv');
    expect(res.body).toContain("'=HYPERLINK");
    expect(res.body.split('\r\n')[0]).toBe('SKU,Product,On hand,Unit cost,Value');
    expect((await get(admin, admin.base, 'sales', '?from=2025-01-01&to=2027-01-01')).status).toBe(400);
    expect((await get(admin, admin.base, 'sales', '?from=bad')).status).toBe(400);
    expect((await get(admin, admin.base, 'nope')).status).toBe(404);
    void today;
  });

  it('only accountants, managers and admins read reports', async () => {
    const admin = await newOrg();
    const ok = [await addMember(admin, 'accountant'), await addMember(admin, 'manager')];
    const no = [await addMember(admin, 'sales'), await addMember(admin, 'stock'), await addMember(admin, 'viewer')];
    for (const w of ok) expect((await get(w, admin.base, 'sales')).status).toBe(200);
    for (const w of no) expect((await get(w, admin.base, 'sales')).status).toBe(403);
  });
});
