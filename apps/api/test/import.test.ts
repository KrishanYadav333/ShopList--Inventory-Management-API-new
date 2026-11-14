import { describe, expect, it } from 'vitest';
import { addMember, call, newOrg, product, stub, uid } from './helpers';

type Org = { cookie: string; base: string; orgId: string };
const imp = (org: Org, mode: 'create' | 'upsert', rows: unknown[], key: string = uid()) =>
  call(org.cookie, 'POST', `${org.base}/products/import`, { mode, rows }, { 'idempotency-key': key });
const find = async (org: Org, sku: string) => (await call(org.cookie, 'GET', `${org.base}/products?q=${encodeURIComponent(sku)}`)).body.data.find((p: any) => p.sku === sku);

describe('CSV import', () => {
  it('creates products with all fields and an on-hand quantity recorded as an import movement', async () => {
    const org = await newOrg();
    const r = await imp(org, 'create', [
      { sku: 'IMP-1', name: 'Imported mouse', priceMinor: 2999, costMinor: 1400, barcode: '4006381333931', unit: 'box', reorderPoint: 5, tags: ['office', 'Office'], description: 'Wired', quantity: 12 },
      { sku: 'IMP-2', name: 'Imported cable', priceMinor: 499 },
    ]);
    expect(r.status).toBe(200);
    expect(r.body.summary).toEqual({ created: 2, updated: 0, unchanged: 0, errors: 0 });
    const p = await find(org, 'IMP-1');
    expect(p).toMatchObject({ name: 'Imported mouse', priceMinor: 2999, costMinor: 1400, unit: 'box', reorderPoint: 5, tags: ['office'], onHand: 12 });
    const moves = (await call(org.cookie, 'GET', `${org.base}/stock/movements?productId=${p.id}`)).body.data;
    expect(moves).toHaveLength(1);
    expect(moves[0]).toMatchObject({ delta: 12, reason: 'import', reference: 'CSV import' });
    expect((await find(org, 'IMP-2')).onHand).toBe(0);
    expect((await stub(org.orgId).verifyIntegrity()).ok).toBe(true);
  });

  it('reports bad rows individually and still imports the good ones', async () => {
    const org = await newOrg();
    const r = await imp(org, 'create', [
      { sku: 'OK-1', name: 'Good', priceMinor: 100 },
      { sku: '', name: 'No sku', priceMinor: 100 },
      { sku: 'BAD-PRICE', name: 'Bad price', priceMinor: -5 },
      { sku: 'FLOAT', name: 'Float price', priceMinor: 9.99 },
      { sku: 'EXTRA', name: 'Unknown column', priceMinor: 1, colour: 'red' },
      'not an object',
      null,
      { sku: 'OK-2', name: 'Also good', priceMinor: 200 },
    ]);
    expect(r.status).toBe(200);
    expect(r.body.summary).toEqual({ created: 2, updated: 0, unchanged: 0, errors: 6 });
    expect(r.body.results.map((x: any) => x.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(r.body.results[1].error).toContain('sku');
    expect(r.body.results[2].error).toContain('priceMinor');
    expect(r.body.results[4].status).toBe('error');
    expect((await call(org.cookie, 'GET', `${org.base}/products`)).body.data.map((p: any) => p.sku).sort()).toEqual(['OK-1', 'OK-2']);
  });

  it('create-only mode refuses existing SKUs, including duplicates inside one file', async () => {
    const org = await newOrg();
    await product(org, { sku: 'EXISTS-1' });
    const r = await imp(org, 'create', [
      { sku: 'EXISTS-1', name: 'Again', priceMinor: 1 },
      { sku: 'NEW-1', name: 'First copy', priceMinor: 1 },
      { sku: 'NEW-1', name: 'Second copy', priceMinor: 1 },
    ]);
    expect(r.body.results.map((x: any) => x.status)).toEqual(['error', 'created', 'error']);
    expect(r.body.results[0].error).toContain('already exists');
    expect(r.body.results[2].error).toContain('already exists');
  });

  it('upsert updates by SKU, leaves unmentioned fields alone, and reports unchanged rows', async () => {
    const org = await newOrg();
    const p = await product(org, { sku: 'UP-1', name: 'Old name', priceMinor: 100, tags: ['keep'], barcode: '999', unit: 'box', initialQuantity: 10 });
    const first = await imp(org, 'upsert', [{ sku: 'UP-1', name: 'New name', priceMinor: 250 }]);
    expect(first.body.results[0]).toMatchObject({ status: 'updated', id: p.id });
    const after = await find(org, 'UP-1');
    expect(after).toMatchObject({ name: 'New name', priceMinor: 250, tags: ['keep'], barcode: '999', unit: 'box', onHand: 10, version: 2 });
    const again = await imp(org, 'upsert', [{ sku: 'UP-1', name: 'New name', priceMinor: 250 }]);
    expect(again.body.results[0].status).toBe('unchanged');
    expect((await find(org, 'UP-1')).version).toBe(2); // an unchanged row does not bump the version
    const clear = await imp(org, 'upsert', [{ sku: 'UP-1', name: 'New name', priceMinor: 250, tags: [], barcode: null }]);
    expect(clear.body.results[0].status).toBe('updated');
    expect(await find(org, 'UP-1')).toMatchObject({ tags: [], barcode: null });
  });

  it('sets stock to the file quantity by recording the difference, and refuses to go below reserved stock', async () => {
    const org = await newOrg();
    const p = await product(org, { sku: 'Q-1', initialQuantity: 10 });
    await call(org.cookie, 'POST', `${org.base}/orders`, { customerName: 'Holds 8', paid: true, lines: [{ productId: p.id, quantity: 8 }] });
    const r = await imp(org, 'upsert', [{ sku: 'Q-1', name: 'Widget', priceMinor: 1000, quantity: 25 }]);
    expect(r.body.results[0].status).toBe('updated');
    expect((await find(org, 'Q-1')).onHand).toBe(25);
    const below = await imp(org, 'upsert', [{ sku: 'Q-1', name: 'Widget', priceMinor: 1000, quantity: 3 }]);
    expect(below.body.results[0].status).toBe('error');
    expect(below.body.results[0].error).toContain('available');
    expect((await find(org, 'Q-1')).onHand).toBe(25); // that row rolled back completely
    expect((await stub(org.orgId).verifyIntegrity()).ok).toBe(true);
  });

  it('a failing row rolls back only itself: its product is not left half-created', async () => {
    const org = await newOrg();
    await product(org, { sku: 'TAKEN', barcode: '12345' });
    const r = await imp(org, 'upsert', [
      { sku: 'FRESH', name: 'Fresh', priceMinor: 100, barcode: '12345' }, // barcode belongs to another product
      { sku: 'FINE', name: 'Fine', priceMinor: 100, quantity: 4 },
    ]);
    expect(r.body.results.map((x: any) => x.status)).toEqual(['error', 'created']);
    expect(r.body.results[0].error).toContain('barcode');
    expect(await find(org, 'FRESH')).toBeUndefined();
    const dash = (await call(org.cookie, 'GET', `${org.base}/dashboard`)).body;
    expect(dash.products).toBe(2); // TAKEN + FINE, counters not skewed by the failed row
    expect((await stub(org.orgId).verifyIntegrity()).ok).toBe(true);
  });

  it('is idempotent: replaying a batch changes nothing and returns the same results', async () => {
    const org = await newOrg();
    const rows = [{ sku: 'ID-1', name: 'Once', priceMinor: 100, quantity: 5 }];
    const a = await imp(org, 'create', rows, 'batch-1');
    const b = await imp(org, 'create', rows, 'batch-1');
    expect(b.body).toEqual(a.body);
    expect((await find(org, 'ID-1')).onHand).toBe(5);
    const other = await imp(org, 'create', [{ sku: 'ID-2', name: 'Different', priceMinor: 1 }], 'batch-1');
    expect(other.status).toBe(422);
  });

  it('enforces the 100-row batch limit, the strict body, and the Idempotency-Key requirement', async () => {
    const org = await newOrg();
    const many = Array.from({ length: 101 }, (_, i) => ({ sku: `S${i}`, name: 'x', priceMinor: 1 }));
    expect((await imp(org, 'create', many)).status).toBe(400);
    expect((await imp(org, 'create', [])).status).toBe(400);
    expect((await call(org.cookie, 'POST', `${org.base}/products/import`, { mode: 'overwrite', rows: [{}] }, { 'idempotency-key': uid() })).status).toBe(400);
    expect((await call(org.cookie, 'POST', `${org.base}/products/import`, { mode: 'create', rows: [{ sku: 'A', name: 'B', priceMinor: 1 }] }, { 'idempotency-key': '' })).status).toBe(428);
    const hundred = Array.from({ length: 100 }, (_, i) => ({ sku: `H${i}`, name: `Item ${i}`, priceMinor: 100 + i, quantity: i }));
    const ok = await imp(org, 'create', hundred);
    expect(ok.body.summary.created).toBe(100);
    expect((await call(org.cookie, 'GET', `${org.base}/dashboard`)).body.products).toBe(100);
    expect((await stub(org.orgId).verifyIntegrity()).ok).toBe(true);
  });

  it('requires write access and stays inside the organization', async () => {
    const org = await newOrg();
    const other = await newOrg();
    const viewer = await addMember(org, 'viewer');
    const rows = [{ sku: 'V-1', name: 'x', priceMinor: 1 }];
    expect((await imp({ ...org, cookie: viewer.cookie }, 'create', rows)).status).toBe(403);
    expect((await imp({ ...other, base: org.base }, 'create', rows)).status).toBe(404);
    expect((await call(org.cookie, 'GET', `${org.base}/products`)).body.data).toHaveLength(0);
  });
});
