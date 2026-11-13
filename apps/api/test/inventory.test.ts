import { describe, expect, it } from 'vitest';
import { call, defaultLocation, newOrg, product, stub, uid } from './helpers';

const move = (org: { cookie: string; base: string }, body: Record<string, unknown>, key?: string) =>
  call(org.cookie, 'POST', `${org.base}/stock/movements`, body, key ? { 'idempotency-key': key } : {});

describe('products', () => {
  it('creates, reads, lists and returns an ETag', async () => {
    const org = await newOrg();
    const r = await call(org.cookie, 'POST', `${org.base}/products`, { sku: 'MOUSE-001', name: 'Wireless Mouse', priceMinor: 2999, tags: ['Office', 'office', 'Mouse'], reorderPoint: 5 });
    expect(r.status).toBe(201);
    expect(r.body.product).toMatchObject({ sku: 'MOUSE-001', priceMinor: 2999, version: 1, onHand: 0, status: 'out', tags: ['mouse', 'office'] });
    expect(r.headers.get('etag')).toBe('"1"');
    const get = await call(org.cookie, 'GET', `${org.base}/products/${r.body.product.id}`);
    expect(get.status).toBe(200);
    expect(get.headers.get('etag')).toBe('"1"');
    expect((await call(org.cookie, 'GET', `${org.base}/products`)).body.data).toHaveLength(1);
  });

  it('validates input with a field-level problem response', async () => {
    const org = await newOrg();
    const r = await call(org.cookie, 'POST', `${org.base}/products`, { sku: '', name: 'x', priceMinor: -5, price: 1 });
    expect(r.status).toBe(400);
    expect(r.headers.get('content-type')).toContain('application/problem+json');
    expect(r.body.errors.length).toBeGreaterThan(0);
    // Money must be integer minor units; floats are rejected.
    const f = await call(org.cookie, 'POST', `${org.base}/products`, { sku: 'F', name: 'f', priceMinor: 9.99 });
    expect(f.status).toBe(400);
  });

  it('rejects duplicate SKUs and barcodes with 409, and frees the SKU after delete', async () => {
    const org = await newOrg();
    const p = await product(org, { sku: 'DUP-1', barcode: '123456' });
    const dupSku = await call(org.cookie, 'POST', `${org.base}/products`, { sku: 'DUP-1', name: 'x', priceMinor: 1 });
    expect(dupSku.status).toBe(409);
    expect(dupSku.body.errors[0]).toMatchObject({ field: 'sku', code: 'duplicate' });
    expect((await call(org.cookie, 'POST', `${org.base}/products`, { sku: 'OTHER', barcode: '123456', name: 'x', priceMinor: 1 })).status).toBe(409);
    expect((await call(org.cookie, 'DELETE', `${org.base}/products/${p.id}`, undefined, { 'if-match': `"${p.version}"` })).status).toBe(200);
    expect((await call(org.cookie, 'POST', `${org.base}/products`, { sku: 'DUP-1', name: 'again', priceMinor: 1 })).status).toBe(201);
  });

  it('requires If-Match and detects concurrent edits with 412 plus the current record', async () => {
    const org = await newOrg();
    const p = await product(org);
    const noHeader = await call(org.cookie, 'PATCH', `${org.base}/products/${p.id}`, { name: 'A' });
    expect(noHeader.status).toBe(428);

    const first = await call(org.cookie, 'PATCH', `${org.base}/products/${p.id}`, { name: 'Edited by Anna' }, { 'if-match': '"1"' });
    expect(first.status).toBe(200);
    expect(first.body.product.version).toBe(2);

    const stale = await call(org.cookie, 'PATCH', `${org.base}/products/${p.id}`, { name: 'Edited by Ben' }, { 'if-match': '"1"' });
    expect(stale.status).toBe(412);
    expect(stale.body.current).toMatchObject({ name: 'Edited by Anna', version: 2 });
    // The losing edit was not applied.
    expect((await call(org.cookie, 'GET', `${org.base}/products/${p.id}`)).body.product.name).toBe('Edited by Anna');
  });

  it('a partial update leaves every field it does not mention untouched', async () => {
    const org = await newOrg();
    const p = await product(org, { unit: 'box', tags: ['red', 'blue'], barcode: '777', description: 'Keep me', costMinor: 400, reorderPoint: 3 });
    const r = await call(org.cookie, 'PATCH', `${org.base}/products/${p.id}`, { name: 'Renamed' }, { 'if-match': '"1"' });
    expect(r.status).toBe(200);
    expect(r.body.product).toMatchObject({ name: 'Renamed', unit: 'box', tags: ['blue', 'red'], barcode: '777', description: 'Keep me', costMinor: 400, reorderPoint: 3, priceMinor: 1000 });
    const clear = await call(org.cookie, 'PATCH', `${org.base}/products/${p.id}`, { tags: [], barcode: null }, { 'if-match': '"2"' });
    expect(clear.body.product).toMatchObject({ tags: [], barcode: null, unit: 'box' });
  });

  it('records who changed what in the audit log', async () => {
    const org = await newOrg();
    const p = await product(org, { priceMinor: 1200 });
    await call(org.cookie, 'PATCH', `${org.base}/products/${p.id}`, { priceMinor: 1450 }, { 'if-match': '"1"' });
    const audit = await call(org.cookie, 'GET', `${org.base}/audit`);
    const update = audit.body.data.find((a: any) => a.action === 'product.update');
    expect(update.changes.priceMinor).toEqual([1200, 1450]);
    expect(update.actor).toMatch(/^usr_/);
    expect(update.requestId).toMatch(/^req_/);
  });

  it('soft-deletes, hides, and restores a product', async () => {
    const org = await newOrg();
    const p = await product(org);
    await call(org.cookie, 'DELETE', `${org.base}/products/${p.id}`, undefined, { 'if-match': '"1"' });
    expect((await call(org.cookie, 'GET', `${org.base}/products/${p.id}`)).status).toBe(404);
    expect((await call(org.cookie, 'GET', `${org.base}/products`)).body.data).toHaveLength(0);
    expect((await call(org.cookie, 'POST', `${org.base}/products/${p.id}/restore`, {})).status).toBe(200);
    expect((await call(org.cookie, 'GET', `${org.base}/products/${p.id}`)).status).toBe(200);
  });
});

describe('stock ledger', () => {
  it('changes stock by delta and keeps a balance after each movement', async () => {
    const org = await newOrg();
    const loc = await defaultLocation(org);
    const p = await product(org, { reorderPoint: 5 });
    const r1 = await move(org, { productId: p.id, locationId: loc, delta: 10, reason: 'receive' });
    expect(r1.status).toBe(201);
    expect(r1.body.stock).toMatchObject({ onHand: 10, available: 10 });
    const r2 = await move(org, { productId: p.id, locationId: loc, delta: -3, reason: 'sale', reference: 'ORDER-1' });
    expect(r2.body.movement).toMatchObject({ delta: -3, balance: 7, reason: 'sale', reference: 'ORDER-1' });
    const list = await call(org.cookie, 'GET', `${org.base}/stock/movements?productId=${p.id}`);
    expect(list.body.data.map((m: any) => m.balance)).toEqual([7, 10]);
    expect((await call(org.cookie, 'GET', `${org.base}/products/${p.id}`)).body.product).toMatchObject({ onHand: 7, status: 'in', version: 1 });
  });

  it('refuses to go below zero with a clear message', async () => {
    const org = await newOrg();
    const loc = await defaultLocation(org);
    const p = await product(org, { sku: 'MOUSE-001', initialQuantity: 2 });
    const r = await move(org, { productId: p.id, locationId: loc, delta: -3, reason: 'sale' });
    expect(r.status).toBe(409);
    expect(r.body.detail).toContain('Only 2 units of MOUSE-001 are available');
    expect((await call(org.cookie, 'GET', `${org.base}/products/${p.id}`)).body.product.onHand).toBe(2);
  });

  it('never lets 50 parallel sales oversell 50 units, and the ledger stays consistent', async () => {
    const org = await newOrg();
    const loc = await defaultLocation(org);
    const p = await product(org, { initialQuantity: 50 });
    const results = await Promise.all(
      Array.from({ length: 60 }, () => move(org, { productId: p.id, locationId: loc, delta: -1, reason: 'sale' })),
    );
    const ok = results.filter((r) => r.status === 201).length;
    const refused = results.filter((r) => r.status === 409).length;
    expect(ok).toBe(50);
    expect(refused).toBe(10);
    expect((await call(org.cookie, 'GET', `${org.base}/products/${p.id}`)).body.product.onHand).toBe(0);
    const integrity = await stub(org.orgId).verifyIntegrity();
    expect(integrity).toEqual({ ok: true, drift: [] });
  });

  it('is idempotent: the same key applies once and replays the same response', async () => {
    const org = await newOrg();
    const loc = await defaultLocation(org);
    const p = await product(org, { initialQuantity: 10 });
    const key = uid();
    const body = { productId: p.id, locationId: loc, delta: -4, reason: 'sale' };
    const a = await move(org, body, key);
    const b = await move(org, body, key);
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(b.body.movement.id).toBe(a.body.movement.id);
    expect((await call(org.cookie, 'GET', `${org.base}/products/${p.id}`)).body.product.onHand).toBe(6);
    const different = await move(org, { ...body, delta: -1 }, key);
    expect(different.status).toBe(422);
  });

  it('requires an Idempotency-Key on stock changes', async () => {
    const org = await newOrg();
    const loc = await defaultLocation(org);
    const p = await product(org);
    const r = await call(org.cookie, 'POST', `${org.base}/stock/movements`, { productId: p.id, locationId: loc, delta: 1, reason: 'receive' }, { 'idempotency-key': '' });
    expect(r.status).toBe(428);
  });

  it('does not accept server-only reasons from clients', async () => {
    const org = await newOrg();
    const loc = await defaultLocation(org);
    const p = await product(org);
    for (const reason of ['count', 'transfer_in', 'import']) {
      expect((await move(org, { productId: p.id, locationId: loc, delta: 1, reason })).status).toBe(400);
    }
  });

  it('transfers atomically: a failed transfer changes nothing', async () => {
    const org = await newOrg();
    const main = await defaultLocation(org);
    const shop = (await call(org.cookie, 'POST', `${org.base}/locations`, { name: 'Shop', code: 'shop' })).body.location.id;
    const p = await product(org, { initialQuantity: 5 });

    const tooMany = await call(org.cookie, 'POST', `${org.base}/stock/transfers`, { productId: p.id, fromLocationId: main, toLocationId: shop, quantity: 9 });
    expect(tooMany.status).toBe(409);
    expect((await call(org.cookie, 'GET', `${org.base}/products/${p.id}`)).body.levels).toHaveLength(1);

    const ok = await call(org.cookie, 'POST', `${org.base}/stock/transfers`, { productId: p.id, fromLocationId: main, toLocationId: shop, quantity: 2 });
    expect(ok.status).toBe(201);
    const levels = (await call(org.cookie, 'GET', `${org.base}/products/${p.id}`)).body.levels;
    expect(Object.fromEntries(levels.map((l: any) => [l.locationId, l.onHand]))).toEqual({ [main]: 3, [shop]: 2 });
    expect((await call(org.cookie, 'GET', `${org.base}/products/${p.id}`)).body.product.onHand).toBe(5);
    expect((await stub(org.orgId).verifyIntegrity()).ok).toBe(true);
  });

  it('records a stock count as the difference', async () => {
    const org = await newOrg();
    const loc = await defaultLocation(org);
    const p = await product(org, { initialQuantity: 10 });
    const r = await call(org.cookie, 'POST', `${org.base}/stock/counts`, { productId: p.id, locationId: loc, counted: 7 });
    expect(r.body.movement).toMatchObject({ delta: -3, reason: 'count', balance: 7 });
    const same = await call(org.cookie, 'POST', `${org.base}/stock/counts`, { productId: p.id, locationId: loc, counted: 7 });
    expect(same.body.movement).toBeNull();
  });

  it('rejects stock changes for unknown or archived locations and deleted products', async () => {
    const org = await newOrg();
    const loc = await defaultLocation(org);
    const p = await product(org);
    expect((await move(org, { productId: p.id, locationId: 'loc_nope', delta: 1, reason: 'receive' })).status).toBe(404);
    expect((await move(org, { productId: 'prd_nope', locationId: loc, delta: 1, reason: 'receive' })).status).toBe(404);
    const spare = (await call(org.cookie, 'POST', `${org.base}/locations`, { name: 'Spare', code: 'sp' })).body.location.id;
    await call(org.cookie, 'DELETE', `${org.base}/locations/${spare}`);
    expect((await move(org, { productId: p.id, locationId: spare, delta: 1, reason: 'receive' })).status).toBe(404);
  });
});

describe('counters and dashboard', () => {
  it('tracks product, low and out-of-stock counts and inventory value', async () => {
    const org = await newOrg();
    const loc = await defaultLocation(org);
    const a = await product(org, { priceMinor: 1000, costMinor: 600, reorderPoint: 5, initialQuantity: 10 }); // in stock, value 6000
    const b = await product(org, { priceMinor: 500, reorderPoint: 5, initialQuantity: 3 }); // low, value 1500 (price: no cost)
    await product(org, { priceMinor: 100 }); // out
    let d = (await call(org.cookie, 'GET', `${org.base}/dashboard`)).body;
    expect(d).toMatchObject({ products: 3, lowStock: 1, outOfStock: 1, inventoryValueMinor: 7500 });
    expect(d.needsAttention.map((p: any) => p.status).sort()).toEqual(['low', 'out']);

    await move(org, { productId: a.id, locationId: loc, delta: -7, reason: 'sale' }); // a now 3 -> low
    d = (await call(org.cookie, 'GET', `${org.base}/dashboard`)).body;
    expect(d).toMatchObject({ lowStock: 2, outOfStock: 1, inventoryValueMinor: 3 * 600 + 1500 });

    await call(org.cookie, 'DELETE', `${org.base}/products/${b.id}`, undefined, { 'if-match': '"1"' });
    d = (await call(org.cookie, 'GET', `${org.base}/dashboard`)).body;
    expect(d).toMatchObject({ products: 2, lowStock: 1, inventoryValueMinor: 3 * 600 });
    expect((await stub(org.orgId).verifyIntegrity()).ok).toBe(true);
  });

  it('keeps counters correct when the reorder point changes', async () => {
    const org = await newOrg();
    const p = await product(org, { initialQuantity: 10, reorderPoint: 5 });
    expect((await call(org.cookie, 'GET', `${org.base}/dashboard`)).body.lowStock).toBe(0);
    await call(org.cookie, 'PATCH', `${org.base}/products/${p.id}`, { reorderPoint: 20 }, { 'if-match': '"1"' });
    expect((await call(org.cookie, 'GET', `${org.base}/dashboard`)).body.lowStock).toBe(1);
    expect((await stub(org.orgId).verifyIntegrity()).ok).toBe(true);
  });
});

describe('listing, paging and search', () => {
  it('pages with cursors without gaps or repeats, in both sort orders', async () => {
    const org = await newOrg();
    for (let i = 0; i < 25; i++) await product(org, { sku: `P-${String(i).padStart(2, '0')}`, name: `Item ${String.fromCharCode(97 + (i % 26))}${i}` });
    for (const sort of ['-updatedAt', 'name']) {
      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const r: any = await call(org.cookie, 'GET', `${org.base}/products?limit=10&sort=${sort}${cursor ? `&cursor=${cursor}` : ''}`);
        expect(r.status).toBe(200);
        seen.push(...r.body.data.map((p: any) => p.id));
        cursor = r.body.nextCursor;
        pages++;
      } while (cursor && pages < 10);
      expect(pages).toBe(3);
      expect(new Set(seen).size).toBe(25);
    }
    const names = (await call(org.cookie, 'GET', `${org.base}/products?limit=25&sort=name`)).body.data.map((p: any) => p.name.toLowerCase());
    expect(names).toEqual([...names].sort());
  });

  it('searches names, SKUs and barcodes with prefix matching and is injection-safe', async () => {
    const org = await newOrg();
    await product(org, { sku: 'MOUSE-001', name: 'Wireless Mouse', barcode: '5012345678900' });
    await product(org, { sku: 'KEYB-002', name: 'Mechanical Keyboard', description: 'Cherry switches' });
    const q = async (s: string) => (await call(org.cookie, 'GET', `${org.base}/products?q=${encodeURIComponent(s)}`)).body.data.map((p: any) => p.sku);
    expect(await q('wire')).toEqual(['MOUSE-001']);
    expect(await q('mouse 001')).toEqual(['MOUSE-001']);
    expect(await q('cherry')).toEqual(['KEYB-002']);
    expect(await q('5012345')).toEqual(['MOUSE-001']);
    expect(await q('nothing')).toEqual([]);
    for (const evil of ['"', "'; DROP TABLE products; --", 'a OR b', '* NEAR(', '\\', '%']) {
      const r = await call(org.cookie, 'GET', `${org.base}/products?q=${encodeURIComponent(evil)}`);
      expect(r.status, evil).toBe(200);
    }
    expect((await call(org.cookie, 'GET', `${org.base}/products`)).body.data).toHaveLength(2);
  });

  it('keeps search results current after edits and deletes', async () => {
    const org = await newOrg();
    const p = await product(org, { name: 'Old Name' });
    await call(org.cookie, 'PATCH', `${org.base}/products/${p.id}`, { name: 'Shiny Gadget' }, { 'if-match': '"1"' });
    const q = async (s: string) => (await call(org.cookie, 'GET', `${org.base}/products?q=${s}`)).body.data.length;
    expect(await q('old')).toBe(0);
    expect(await q('shiny')).toBe(1);
    await call(org.cookie, 'DELETE', `${org.base}/products/${p.id}`, undefined, { 'if-match': '"2"' });
    expect(await q('shiny')).toBe(0);
  });

  it('filters by stock status, location and tag', async () => {
    const org = await newOrg();
    const main = await defaultLocation(org);
    await product(org, { sku: 'A', initialQuantity: 10, reorderPoint: 5, tags: ['red'] });
    await product(org, { sku: 'B', initialQuantity: 2, reorderPoint: 5, tags: ['red', 'blue'] });
    await product(org, { sku: 'C', tags: ['blue'] });
    const skus = async (qs: string) => (await call(org.cookie, 'GET', `${org.base}/products?${qs}&sort=name`)).body.data.map((p: any) => p.sku).sort();
    expect(await skus('stock=out')).toEqual(['C']);
    expect(await skus('stock=low')).toEqual(['B']);
    expect(await skus('stock=in')).toEqual(['A', 'B']);
    expect(await skus('tag=blue')).toEqual(['B', 'C']);
    expect(await skus(`location=${main}`)).toEqual(['A', 'B']);
  });

  it('looks up by barcode or SKU for scanners', async () => {
    const org = await newOrg();
    const p = await product(org, { sku: 'SCAN-1', barcode: '999000111' });
    expect((await call(org.cookie, 'GET', `${org.base}/products/lookup?code=999000111`)).body.product.id).toBe(p.id);
    expect((await call(org.cookie, 'GET', `${org.base}/products/lookup?code=SCAN-1`)).body.product.id).toBe(p.id);
    expect((await call(org.cookie, 'GET', `${org.base}/products/lookup?code=nope`)).status).toBe(404);
  });
});

describe('locations', () => {
  it('starts with a default location and protects it and any stocked location', async () => {
    const org = await newOrg();
    const main = await defaultLocation(org);
    expect((await call(org.cookie, 'DELETE', `${org.base}/locations/${main}`)).status).toBe(409);
    const shop = (await call(org.cookie, 'POST', `${org.base}/locations`, { name: 'Shop', code: 'shop' })).body.location;
    expect(shop.code).toBe('SHOP');
    expect((await call(org.cookie, 'POST', `${org.base}/locations`, { name: 'Dup', code: 'SHOP' })).status).toBe(409);
    const p = await product(org, { initialQuantity: 1 });
    await call(org.cookie, 'POST', `${org.base}/stock/transfers`, { productId: p.id, fromLocationId: main, toLocationId: shop.id, quantity: 1 });
    expect((await call(org.cookie, 'DELETE', `${org.base}/locations/${shop.id}`)).status).toBe(409);
  });
});
