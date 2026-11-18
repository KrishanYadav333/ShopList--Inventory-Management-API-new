import { describe, expect, it } from 'vitest';
import { call, defaultLocation, newOrg, product, uid } from './helpers';

describe('per-product tax rate', () => {
  async function shop(mode: 'exclusive' | 'inclusive') {
    const org = await newOrg('Tax Co');
    await call(org.cookie, 'PATCH', `${org.base}/settings`, { taxMode: mode, taxRateBp: 1000 });
    const loc = await defaultLocation(org);
    const std = await product(org, { name: 'Standard', priceMinor: 1000 });
    const food = await product(org, { name: 'Food', priceMinor: 1000, taxRateBp: 500 });
    const free = await product(org, { name: 'Exempt', priceMinor: 1000, taxRateBp: 0 });
    for (const p of [std, food, free]) await call(org.cookie, 'POST', `${org.base}/stock/movements`, { productId: p.id, locationId: loc, delta: 10, reason: 'receive' });
    return { org, std, food, free };
  }
  const order = (org: { cookie: string; base: string }, lines: { productId: string; quantity: number }[]) => call(org.cookie, 'POST', `${org.base}/orders`, { customerName: 'Pat', lines });

  it('uses the product rate, else the business rate, per line (added on top)', async () => {
    const { org, std, food, free } = await shop('exclusive');
    const o = (await order(org, [{ productId: std.id, quantity: 1 }, { productId: food.id, quantity: 1 }, { productId: free.id, quantity: 1 }])).body.order;
    expect(o.subtotalMinor).toBe(3000);
    expect(o.taxMinor).toBe(100 + 50 + 0);
    expect(o.totalMinor).toBe(3150);
    const doc = await call(org.cookie, 'GET', `${org.base}/orders/${o.id}/document`);
    expect(doc.body.lines.map((l: any) => [l.name, l.taxRateBp, l.taxMinor])).toEqual(expect.arrayContaining([['Standard', 1000, 100], ['Food', 500, 50], ['Exempt', 0, 0]]));
  });

  it('works for prices that include tax, and a later change does not rewrite old orders', async () => {
    const { org, std, food } = await shop('inclusive');
    const o = (await order(org, [{ productId: food.id, quantity: 1 }])).body.order;
    expect(o.totalMinor).toBe(1000);
    expect(o.taxMinor).toBe(48); // 1000 * 500 / 10500, half up
    await call(org.cookie, 'PATCH', `${org.base}/products/${food.id}`, { taxRateBp: 2000 }, { 'if-match': `"${food.version}"` });
    expect((await call(org.cookie, 'GET', `${org.base}/orders/${o.id}`)).body.order.taxMinor).toBe(48);
    const o2 = (await order(org, [{ productId: food.id, quantity: 1 }])).body.order;
    expect(o2.taxMinor).toBe(167);
    void std;
  });

  it('can be set, shown, cleared, imported and validated', async () => {
    const org = await newOrg();
    const p = await product(org, { taxRateBp: 750 });
    expect((await call(org.cookie, 'GET', `${org.base}/products/${p.id}`)).body.product.taxRateBp).toBe(750);
    const cleared = await call(org.cookie, 'PATCH', `${org.base}/products/${p.id}`, { taxRateBp: null }, { 'if-match': `"${p.version}"` });
    expect(cleared.body.product.taxRateBp).toBeNull();
    expect((await call(org.cookie, 'POST', `${org.base}/products`, { sku: `T-${uid()}`, name: 'Bad', priceMinor: 1, taxRateBp: 10001 })).status).toBe(400);
    expect((await call(org.cookie, 'POST', `${org.base}/products`, { sku: `T-${uid()}`, name: 'Bad', priceMinor: 1, taxRateBp: -1 })).status).toBe(400);
    const imp = await call(org.cookie, 'POST', `${org.base}/products/import`, { mode: 'create', rows: [{ sku: `I-${uid()}`, name: 'Imp', priceMinor: 5, taxRateBp: 250 }] }, { 'idempotency-key': uid() });
    expect(imp.body.results[0].status).toBe('created');
    expect((await call(org.cookie, 'GET', `${org.base}/products?limit=50`)).body.data.some((x: any) => x.taxRateBp === 250)).toBe(true);
  });

  it('ignores product rates when the business charges no tax', async () => {
    const org = await newOrg();
    const p = await product(org, { taxRateBp: 500 });
    const loc = await defaultLocation(org);
    await call(org.cookie, 'POST', `${org.base}/stock/movements`, { productId: p.id, locationId: loc, delta: 5, reason: 'receive' });
    const o = (await order(org, [{ productId: p.id, quantity: 1 }])).body.order;
    expect(o.taxMinor).toBe(0);
    expect(o.totalMinor).toBe(o.subtotalMinor);
  });
});
