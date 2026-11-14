import { describe, expect, it } from 'vitest';
import { addMember, call, defaultLocation, newOrg, product, stub } from './helpers';

type Org = { cookie: string; base: string; orgId: string };
const order = (org: Org, lines: { productId: string; quantity: number }[], over: Record<string, unknown> = {}) =>
  call(org.cookie, 'POST', `${org.base}/orders`, { customerName: 'Jade Lundie', country: 'gb', lines, ...over });
const get = async (org: Org, id: string) => (await call(org.cookie, 'GET', `${org.base}/orders/${id}`)).body.order;
const prod = async (org: Org, id: string) => (await call(org.cookie, 'GET', `${org.base}/products/${id}`)).body.product;
const act = (org: Org, id: string, what: 'ship' | 'cancel' | 'paid', version: number, body: unknown = {}) =>
  call(org.cookie, 'POST', `${org.base}/orders/${id}/${what}`, body, { 'if-match': `"${version}"` });
const receive = (org: Org, productId: string, locationId: string, delta: number) =>
  call(org.cookie, 'POST', `${org.base}/stock/movements`, { productId, locationId, delta, reason: 'receive' });

describe('creating orders reserves stock', () => {
  it('reserves what is available, numbers the order, and derives the state', async () => {
    const org = await newOrg();
    const p = await product(org, { initialQuantity: 10, priceMinor: 500 });
    const r = await order(org, [{ productId: p.id, quantity: 4 }], { paid: true });
    expect(r.status).toBe(201);
    expect(r.body.order).toMatchObject({ state: 'ready_to_ship', paid: true, country: 'GB', totalMinor: 2000, version: 1 });
    expect(r.body.order.number).toMatch(/^ORD-10\d\d$/);
    expect(r.body.order.lines[0]).toMatchObject({ quantity: 4, reserved: 4, sku: p.sku });
    const after = await prod(org, p.id);
    expect(after).toMatchObject({ onHand: 10, reserved: 4, available: 6 });
    expect((await stub(org.orgId).verifyIntegrity()).ok).toBe(true);
  });

  it('unpaid orders still hold stock but show Payment required; short ones wait', async () => {
    const org = await newOrg();
    const p = await product(org, { initialQuantity: 3 });
    const unpaid = await order(org, [{ productId: p.id, quantity: 2 }]);
    expect(unpaid.body.order.state).toBe('payment_required');
    expect(unpaid.body.order.lines[0].reserved).toBe(2);
    const short = await order(org, [{ productId: p.id, quantity: 5 }], { paid: true });
    expect(short.body.order.state).toBe('waiting_for_stock');
    expect(short.body.order.lines[0]).toMatchObject({ quantity: 5, reserved: 1 }); // only 1 was left
    expect((await prod(org, p.id)).available).toBe(0);
  });

  it('validates input and rejects unknown products, duplicates and empty orders', async () => {
    const org = await newOrg();
    const p = await product(org, { initialQuantity: 5 });
    expect((await order(org, [])).status).toBe(400);
    expect((await order(org, [{ productId: p.id, quantity: 0 }])).status).toBe(400);
    expect((await order(org, [{ productId: p.id, quantity: 1 }, { productId: p.id, quantity: 1 }])).status).toBe(400);
    expect((await order(org, [{ productId: 'prd_nope', quantity: 1 }])).status).toBe(404);
    expect((await order(org, [{ productId: p.id, quantity: 1 }], { country: 'GBR' })).status).toBe(400);
    expect((await order(org, [{ productId: p.id, quantity: 1 }], { customerName: '' })).status).toBe(400);
    // A failed order leaves no trace: no reservation, no order number consumed
    expect((await prod(org, p.id)).reserved).toBe(0);
    expect((await call(org.cookie, 'GET', `${org.base}/orders`)).body.data).toHaveLength(0);
  });

  it('is idempotent', async () => {
    const org = await newOrg();
    const p = await product(org, { initialQuantity: 5 });
    const body = { customerName: 'X', lines: [{ productId: p.id, quantity: 2 }] };
    const h = { 'idempotency-key': 'order-key-1' };
    const a = await call(org.cookie, 'POST', `${org.base}/orders`, body, h);
    const b = await call(org.cookie, 'POST', `${org.base}/orders`, body, h);
    expect(b.body.order.id).toBe(a.body.order.id);
    expect((await prod(org, p.id)).reserved).toBe(2);
  });
});

describe('shipping, paying and cancelling', () => {
  it('shipping turns the reservation into a sale in the ledger', async () => {
    const org = await newOrg();
    const loc = await defaultLocation(org);
    const p = await product(org, { initialQuantity: 10 });
    const o = (await order(org, [{ productId: p.id, quantity: 4 }], { paid: true })).body.order;
    const r = await act(org, o.id, 'ship', o.version);
    expect(r.status).toBe(200);
    expect(r.body.order).toMatchObject({ state: 'shipped', version: 2 });
    expect(r.body.order.shippedAt).toBeTruthy();
    expect(await prod(org, p.id)).toMatchObject({ onHand: 6, reserved: 0, available: 6 });
    const moves = (await call(org.cookie, 'GET', `${org.base}/stock/movements?productId=${p.id}`)).body.data;
    expect(moves[0]).toMatchObject({ delta: -4, reason: 'sale', reference: o.number, locationId: loc });
    expect((await stub(org.orgId).verifyIntegrity()).ok).toBe(true);
  });

  it('refuses to ship an unpaid or waiting order, with a plain reason', async () => {
    const org = await newOrg();
    const p = await product(org, { initialQuantity: 1 });
    const unpaid = (await order(org, [{ productId: p.id, quantity: 1 }])).body.order;
    const r1 = await act(org, unpaid.id, 'ship', unpaid.version);
    expect(r1.status).toBe(409);
    expect(r1.body.detail).toContain('paid');
    const q = await product(org, { initialQuantity: 0 });
    const waiting = (await order(org, [{ productId: q.id, quantity: 3 }], { paid: true })).body.order;
    const r2 = await act(org, waiting.id, 'ship', waiting.version);
    expect(r2.status).toBe(409);
    expect(r2.body.detail).toContain('not in stock');
  });

  it('marking paid moves Payment required to Ready to ship (or Waiting)', async () => {
    const org = await newOrg();
    const p = await product(org, { initialQuantity: 5 });
    const o = (await order(org, [{ productId: p.id, quantity: 2 }])).body.order;
    const paid = await act(org, o.id, 'paid', o.version, { paid: true });
    expect(paid.body.order).toMatchObject({ state: 'ready_to_ship', paid: true, version: 2 });
    const unpaid = await act(org, o.id, 'paid', 2, { paid: false });
    expect(unpaid.body.order.state).toBe('payment_required');
  });

  it('cancelling releases stock and gives it to the oldest waiting order first (FIFO)', async () => {
    const org = await newOrg();
    const p = await product(org, { initialQuantity: 3 });
    const first = (await order(org, [{ productId: p.id, quantity: 3 }], { paid: true })).body.order; // holds all 3
    const second = (await order(org, [{ productId: p.id, quantity: 2 }], { paid: true, customerName: 'Second' })).body.order; // waits
    const third = (await order(org, [{ productId: p.id, quantity: 2 }], { paid: true, customerName: 'Third' })).body.order; // waits
    expect([second.state, third.state]).toEqual(['waiting_for_stock', 'waiting_for_stock']);

    expect((await act(org, first.id, 'cancel', first.version)).body.order.state).toBe('cancelled');
    expect((await get(org, second.id)).state).toBe('ready_to_ship'); // oldest waiting got it
    const t = await get(org, third.id);
    expect(t.state).toBe('waiting_for_stock');
    expect(t.lines[0].reserved).toBe(1); // the leftover unit
    expect(await prod(org, p.id)).toMatchObject({ onHand: 3, reserved: 3 });
    expect((await stub(org.orgId).verifyIntegrity()).ok).toBe(true);
  });

  it('receiving stock allocates it to waiting orders automatically', async () => {
    const org = await newOrg();
    const loc = await defaultLocation(org);
    const p = await product(org, { initialQuantity: 0 });
    const o = (await order(org, [{ productId: p.id, quantity: 5 }], { paid: true })).body.order;
    expect(o.state).toBe('waiting_for_stock');
    const r = await receive(org, p.id, loc, 3);
    expect(r.body.stock).toMatchObject({ onHand: 3, reserved: 3, available: 0 }); // the response already reflects the allocation
    expect((await get(org, o.id)).state).toBe('waiting_for_stock');
    await receive(org, p.id, loc, 2);
    const now = await get(org, o.id);
    expect(now.state).toBe('ready_to_ship');
    expect(now.lines[0].reserved).toBe(5);
    expect((await act(org, o.id, 'ship', now.version)).status).toBe(200);
    expect(await prod(org, p.id)).toMatchObject({ onHand: 0, reserved: 0 });
  });

  it('closed orders cannot be changed again', async () => {
    const org = await newOrg();
    const p = await product(org, { initialQuantity: 5 });
    const o = (await order(org, [{ productId: p.id, quantity: 1 }], { paid: true })).body.order;
    const shipped = (await act(org, o.id, 'ship', o.version)).body.order;
    for (const what of ['ship', 'cancel'] as const) expect((await act(org, o.id, what, shipped.version)).status, what).toBe(409);
    expect((await act(org, o.id, 'paid', shipped.version, { paid: false })).status).toBe(409);
  });

  it('detects concurrent edits with 412, and requires If-Match', async () => {
    const org = await newOrg();
    const p = await product(org, { initialQuantity: 5 });
    const o = (await order(org, [{ productId: p.id, quantity: 1 }])).body.order;
    expect((await call(org.cookie, 'POST', `${org.base}/orders/${o.id}/ship`, {})).status).toBe(428);
    await act(org, o.id, 'paid', 1, { paid: true });
    const stale = await act(org, o.id, 'cancel', 1);
    expect(stale.status).toBe(412);
    expect(stale.body.current).toMatchObject({ version: 2, paid: true });
  });
});

describe('reservations protect stock', () => {
  it('reserved units cannot be sold or counted away by another movement', async () => {
    const org = await newOrg();
    const loc = await defaultLocation(org);
    const p = await product(org, { initialQuantity: 10 });
    await order(org, [{ productId: p.id, quantity: 8 }], { paid: true });
    const r = await call(org.cookie, 'POST', `${org.base}/stock/movements`, { productId: p.id, locationId: loc, delta: -5, reason: 'sale' });
    expect(r.status).toBe(409);
    expect(r.body.detail).toContain('Only 2 units');
    expect((await call(org.cookie, 'POST', `${org.base}/stock/movements`, { productId: p.id, locationId: loc, delta: -2, reason: 'damage' })).status).toBe(201);
  });

  it('a product on an open order cannot be deleted until the order closes', async () => {
    const org = await newOrg();
    const p = await product(org, { initialQuantity: 5 });
    const o = (await order(org, [{ productId: p.id, quantity: 1 }])).body.order;
    const del = await call(org.cookie, 'DELETE', `${org.base}/products/${p.id}`, undefined, { 'if-match': '"1"' });
    expect(del.status).toBe(409);
    expect(del.body.type).toContain('product-in-use');
    await act(org, o.id, 'cancel', o.version);
    expect((await call(org.cookie, 'DELETE', `${org.base}/products/${p.id}`, undefined, { 'if-match': '"1"' })).status).toBe(200);
  });

  it('30 parallel orders for 10 units reserve exactly 10 and never oversell', async () => {
    const org = await newOrg();
    const p = await product(org, { initialQuantity: 10 });
    const results = await Promise.all(Array.from({ length: 30 }, (_, i) => order(org, [{ productId: p.id, quantity: 1 }], { paid: true, customerName: `Buyer ${i}` })));
    expect(results.every((r) => r.status === 201)).toBe(true);
    const states = results.map((r) => r.body.order.state);
    expect(states.filter((s) => s === 'ready_to_ship')).toHaveLength(10);
    expect(states.filter((s) => s === 'waiting_for_stock')).toHaveLength(20);
    expect(await prod(org, p.id)).toMatchObject({ onHand: 10, reserved: 10, available: 0 });
    // order numbers are unique and sequential even under concurrency
    const numbers = results.map((r) => r.body.order.number);
    expect(new Set(numbers).size).toBe(30);
    expect((await stub(org.orgId).verifyIntegrity()).ok).toBe(true);
  });

  it('shipping 10 ready orders at once ends at zero stock with a consistent ledger', async () => {
    const org = await newOrg();
    const p = await product(org, { initialQuantity: 10 });
    const orders = (await Promise.all(Array.from({ length: 10 }, () => order(org, [{ productId: p.id, quantity: 1 }], { paid: true })))).map((r) => r.body.order);
    const ships = await Promise.all(orders.map((o) => act(org, o.id, 'ship', o.version)));
    expect(ships.every((r) => r.status === 200)).toBe(true);
    expect(await prod(org, p.id)).toMatchObject({ onHand: 0, reserved: 0 });
    expect((await stub(org.orgId).verifyIntegrity()).ok).toBe(true);
  });
});

describe('listing, counts and access', () => {
  it('filters by state, searches by number and customer, pages, and counts per state', async () => {
    const org = await newOrg();
    const p = await product(org, { initialQuantity: 100 });
    for (let i = 0; i < 5; i++) await order(org, [{ productId: p.id, quantity: 1 }], { paid: i % 2 === 0, customerName: i === 0 ? 'Marc Girdlestone' : `Buyer ${i}` });
    const list = async (qs: string) => (await call(org.cookie, 'GET', `${org.base}/orders?${qs}`)).body;
    expect((await list('state=ready_to_ship')).data).toHaveLength(3);
    expect((await list('state=payment_required')).data).toHaveLength(2);
    expect((await list('q=marc')).data.map((o: any) => o.customerName)).toEqual(['Marc Girdlestone']);
    const byNumber = (await list('limit=1')).data[0].number;
    expect((await list(`q=${byNumber}`)).data).toHaveLength(1);
    expect((await list("q=%25")).data).toHaveLength(0); // wildcard characters are escaped
    const p1 = await list('limit=2');
    expect(p1.hasMore).toBe(true);
    const p2 = await list(`limit=2&cursor=${p1.nextCursor}`);
    expect(new Set([...p1.data, ...p2.data].map((o: any) => o.id)).size).toBe(4);
    const dash = (await call(org.cookie, 'GET', `${org.base}/dashboard`)).body;
    expect(dash.orders).toMatchObject({ ready_to_ship: 3, payment_required: 2, waiting_for_stock: 0, shipped: 0, cancelled: 0 });
  });

  it('another organization cannot see or touch the orders (404), a viewer cannot write', async () => {
    const a = await newOrg();
    const b = await newOrg();
    const p = await product(a, { initialQuantity: 5 });
    const o = (await order(a, [{ productId: p.id, quantity: 1 }])).body.order;
    expect((await call(b.cookie, 'GET', `${a.base}/orders`)).status).toBe(404);
    expect((await call(b.cookie, 'GET', `${a.base}/orders/${o.id}`)).status).toBe(404);
    expect((await call(b.cookie, 'POST', `${a.base}/orders/${o.id}/cancel`, {}, { 'if-match': '"1"' })).status).toBe(404);
    const viewer = await addMember(a, 'viewer');
    expect((await call(viewer.cookie, 'GET', `${a.base}/orders`)).status).toBe(200);
    expect((await order({ ...a, cookie: viewer.cookie }, [{ productId: p.id, quantity: 1 }])).status).toBe(403);
    expect((await call(viewer.cookie, 'POST', `${a.base}/orders/${o.id}/ship`, {}, { 'if-match': '"1"' })).status).toBe(403);
    // and the same order id is not visible in organization B's own store
    expect((await call(b.cookie, 'GET', `${b.base}/orders/${o.id}`)).status).toBe(404);
  });
});
