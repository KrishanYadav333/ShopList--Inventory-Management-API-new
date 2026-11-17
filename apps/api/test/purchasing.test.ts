import { describe, expect, it } from 'vitest';
import { addMember, call, defaultLocation, newOrg, product, stub } from './helpers';

async function setup() {
  const admin = await newOrg();
  const loc = await defaultLocation(admin);
  const p1 = await product(admin, { sku: 'P-1', name: 'Pen', costMinor: 100 });
  const p2 = await product(admin, { sku: 'P-2', name: 'Pad', costMinor: 300 });
  const sup = (await call(admin.cookie, 'POST', `${admin.base}/suppliers`, { name: 'Acme Supply', leadTimeDays: 7 })).body.supplier;
  const po = async (lines = [{ productId: p1.id, quantity: 10, unitCostMinor: 120 }, { productId: p2.id, quantity: 5, unitCostMinor: 350 }]) =>
    (await call(admin.cookie, 'POST', `${admin.base}/purchase-orders`, { supplierId: sup.id, locationId: loc, lines })).body.order;
  const stockLevel = async (id: string) => (await call(admin.cookie, 'GET', `${admin.base}/products/${id}`)).body.product;
  return { admin, loc, p1, p2, sup, po, stockLevel };
}
const ver = (o: { version: number }) => ({ 'if-match': `"${o.version}"` });

describe('F13 purchasing', () => {
  it('draft, send, receive in two parts: stock arrives, cost follows, state moves', async () => {
    const { admin, p1, p2, po, stockLevel } = await setup();
    const order = await po();
    expect(order.state).toBe('draft');
    expect(order.number).toMatch(/^PO-\d+$/);
    expect(order.totalMinor).toBe(10 * 120 + 5 * 350);
    expect((await call(admin.cookie, 'POST', `${admin.base}/purchase-orders/${order.id}/receive`, { lines: [{ lineId: order.lines[0].id, quantity: 1 }] })).status).toBe(409); // not sent yet

    const sent = (await call(admin.cookie, 'POST', `${admin.base}/purchase-orders/${order.id}/send`, {})).body.order;
    expect(sent.state).toBe('sent');
    const open = await call(admin.cookie, 'GET', `${admin.base}/purchase-orders`);
    expect(open.body.onOrder).toEqual({ [p1.id]: 10, [p2.id]: 5 });

    const first = await call(admin.cookie, 'POST', `${admin.base}/purchase-orders/${order.id}/receive`, { lines: [{ lineId: order.lines[0].id, quantity: 4 }] });
    expect(first.body.order.state).toBe('partially_received');
    expect((await stockLevel(p1.id))).toMatchObject({ onHand: 4, costMinor: 120 });
    expect((await call(admin.cookie, 'GET', `${admin.base}/purchase-orders`)).body.onOrder[p1.id]).toBe(6);

    const over = await call(admin.cookie, 'POST', `${admin.base}/purchase-orders/${order.id}/receive`, { lines: [{ lineId: order.lines[0].id, quantity: 7 }] });
    expect(over.status).toBe(409);
    expect(over.body.type).toContain('over-receipt');

    const done = await call(admin.cookie, 'POST', `${admin.base}/purchase-orders/${order.id}/receive`, { lines: [{ lineId: order.lines[0].id, quantity: 6 }, { lineId: order.lines[1].id, quantity: 5 }] });
    expect(done.body.order.state).toBe('received');
    expect((await stockLevel(p2.id))).toMatchObject({ onHand: 5, costMinor: 350 });
    expect((await call(admin.cookie, 'GET', `${admin.base}/purchase-orders`)).body.onOrder).toEqual({});
    // the books still balance, including the value counter after the cost changes
    expect(await stub(admin.orgId).verifyIntegrity()).toEqual({ ok: true, drift: [] });
    // the ledger carries the PO number as the reference
    const mv = (await call(admin.cookie, 'GET', `${admin.base}/stock/movements`)).body.data;
    expect(mv.some((m: { reference: string }) => m.reference === order.number)).toBe(true);
  });

  it('a failed receipt changes nothing, and a retried one with the same key applies once', async () => {
    const { admin, p1, po, stockLevel } = await setup();
    const order = await po();
    await call(admin.cookie, 'POST', `${admin.base}/purchase-orders/${order.id}/send`, {});
    const bad = await call(admin.cookie, 'POST', `${admin.base}/purchase-orders/${order.id}/receive`, { lines: [{ lineId: order.lines[0].id, quantity: 3 }, { lineId: order.lines[1].id, quantity: 99 }] });
    expect(bad.status).toBe(409);
    expect((await stockLevel(p1.id)).onHand).toBe(0); // the good line was rolled back too
    const key = { 'idempotency-key': crypto.randomUUID() };
    const body = { lines: [{ lineId: order.lines[0].id, quantity: 3 }] };
    await call(admin.cookie, 'POST', `${admin.base}/purchase-orders/${order.id}/receive`, body, key);
    await call(admin.cookie, 'POST', `${admin.base}/purchase-orders/${order.id}/receive`, body, key);
    expect((await stockLevel(p1.id)).onHand).toBe(3);
  });

  it('draft edits need the version; sent orders cannot be edited; cancel and close follow the rules', async () => {
    const { admin, p1, po } = await setup();
    const order = await po();
    const edited = await call(admin.cookie, 'PATCH', `${admin.base}/purchase-orders/${order.id}`, { note: 'rush', lines: [{ productId: p1.id, quantity: 2, unitCostMinor: 90 }] }, ver(order));
    expect(edited.body.order.lines).toHaveLength(1);
    expect((await call(admin.cookie, 'PATCH', `${admin.base}/purchase-orders/${order.id}`, { note: 'again' }, ver(order))).status).toBe(412); // stale version
    const v2 = edited.body.order;
    await call(admin.cookie, 'POST', `${admin.base}/purchase-orders/${order.id}/send`, {});
    expect((await call(admin.cookie, 'PATCH', `${admin.base}/purchase-orders/${order.id}`, { note: 'x' }, ver({ version: v2.version + 1 }))).status).toBe(409);
    await call(admin.cookie, 'POST', `${admin.base}/purchase-orders/${order.id}/receive`, { lines: [{ lineId: v2.lines[0].id, quantity: 1 }] });
    expect((await call(admin.cookie, 'POST', `${admin.base}/purchase-orders/${order.id}/cancel`, {})).status).toBe(409); // goods already arrived
    expect((await call(admin.cookie, 'POST', `${admin.base}/purchase-orders/${order.id}/close`, {})).body.order.state).toBe('closed');
    expect((await call(admin.cookie, 'GET', `${admin.base}/purchase-orders`)).body.onOrder).toEqual({}); // the rest stopped counting
    const second = await po();
    expect((await call(admin.cookie, 'POST', `${admin.base}/purchase-orders/${second.id}/cancel`, {})).body.order.state).toBe('cancelled');
  });

  it('permissions: managers buy, stock keepers receive, everyone else only looks; no costs for those who cannot see them', async () => {
    const { admin, p1, po } = await setup();
    const manager = await addMember(admin, 'manager');
    const stock = await addMember(admin, 'stock');
    const sales = await addMember(admin, 'sales');
    const order = await po();
    await call(admin.cookie, 'POST', `${admin.base}/purchase-orders/${order.id}/send`, {});
    expect((await call(manager.cookie, 'POST', `${admin.base}/suppliers`, { name: 'Mgr Supplier' })).status).toBe(201);
    for (const who of [stock, sales]) {
      expect((await call(who.cookie, 'POST', `${admin.base}/suppliers`, { name: 'No' })).status).toBe(403);
      expect((await call(who.cookie, 'POST', `${admin.base}/purchase-orders`, { supplierId: 'x', locationId: 'y', lines: [{ productId: p1.id, quantity: 1, unitCostMinor: 1 }] })).status).toBe(403);
    }
    expect((await call(sales.cookie, 'POST', `${admin.base}/purchase-orders/${order.id}/receive`, { lines: [{ lineId: order.lines[0].id, quantity: 1 }] })).status).toBe(403);
    const seen = await call(stock.cookie, 'GET', `${admin.base}/purchase-orders/${order.id}`);
    expect(seen.status).toBe(200);
    expect(JSON.stringify(seen.body)).not.toContain('unitCostMinor'); // stock keepers see quantities, not prices
    expect((await call(stock.cookie, 'POST', `${admin.base}/purchase-orders/${order.id}/receive`, { lines: [{ lineId: order.lines[0].id, quantity: 2 }] })).body.order.state).toBe('partially_received');
    expect(JSON.stringify((await call(manager.cookie, 'GET', `${admin.base}/purchase-orders/${order.id}`)).body)).toContain('unitCostMinor');
  });

  it('a stock keeper limited to other locations cannot receive here; archived suppliers cannot be used', async () => {
    const { admin, sup, loc, p1, po } = await setup();
    const other = (await call(admin.cookie, 'POST', `${admin.base}/locations`, { name: 'Other', code: 'OTH' })).body.location.id;
    const keeper = await addMember(admin, 'stock');
    const id = (await call(keeper.cookie, 'GET', '/me')).body.user.id;
    await call(admin.cookie, 'PATCH', `${admin.base}/members/${id}`, { locationIds: [other] });
    const order = await po();
    await call(admin.cookie, 'POST', `${admin.base}/purchase-orders/${order.id}/send`, {});
    expect((await call(keeper.cookie, 'POST', `${admin.base}/purchase-orders/${order.id}/receive`, { lines: [{ lineId: order.lines[0].id, quantity: 1 }] })).status).toBe(403);
    await call(admin.cookie, 'PATCH', `${admin.base}/suppliers/${sup.id}`, { archived: true });
    expect((await call(admin.cookie, 'POST', `${admin.base}/purchase-orders`, { supplierId: sup.id, locationId: loc, lines: [{ productId: p1.id, quantity: 1, unitCostMinor: 1 }] })).status).toBe(404);
  });
});
