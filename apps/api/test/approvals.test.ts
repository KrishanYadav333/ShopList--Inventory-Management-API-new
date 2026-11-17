import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { flushEvents } from '../src/webhooks';
import { addMember, call, defaultLocation, newOrg, product } from './helpers';

const RULES = {
  largeAdjustment: { on: true, units: 20, valueMinor: 50_000 },
  damage: { on: true },
  countVariance: { on: true, units: 20 },
  cancelPaid: { on: true },
  priceDrop: { on: true, percent: 30 },
};

async function setup() {
  const admin = await newOrg();
  const full = (await call(admin.cookie, 'GET', `${admin.base}/settings`)).body.settings;
  expect((await call(admin.cookie, 'PATCH', `${admin.base}/settings`, { ...full, approvals: RULES })).status).toBe(200);
  const p = await product(admin, { costMinor: 100 });
  const loc = await defaultLocation(admin);
  await call(admin.cookie, 'POST', `${admin.base}/stock/movements`, { productId: p.id, locationId: loc, delta: 100, reason: 'receive' });
  const stock = await addMember(admin, 'stock');
  const manager = await addMember(admin, 'manager');
  const level = async () => (await call(admin.cookie, 'GET', `${admin.base}/products/${p.id}`)).body.product.onHand as number;
  const move = (who: { cookie: string }, delta: number, reason: string) => call(who.cookie, 'POST', `${admin.base}/stock/movements`, { productId: p.id, locationId: loc, delta, reason });
  return { admin, p, loc, stock, manager, level, move };
}

describe('F10 approvals', () => {
  it('nothing waits when the rules are off', async () => {
    const admin = await newOrg();
    const p = await product(admin);
    const loc = await defaultLocation(admin);
    const stock = await addMember(admin, 'stock');
    await call(admin.cookie, 'POST', `${admin.base}/stock/movements`, { productId: p.id, locationId: loc, delta: 50, reason: 'receive' });
    expect((await call(stock.cookie, 'POST', `${admin.base}/stock/movements`, { productId: p.id, locationId: loc, delta: -40, reason: 'damage' })).status).toBe(201);
  });

  it('a damage write-off waits, then applies once when a manager approves', async () => {
    const { admin, stock, manager, level, move } = await setup();
    const r = await move(stock, -5, 'damage');
    expect(r.status).toBe(202);
    expect(r.body.approval.state).toBe('pending');
    expect(await level()).toBe(100); // nothing happened yet
    const again = await move(stock, -5, 'damage'); // same request: the same waiting item
    expect(again.body.approval.id).toBe(r.body.approval.id);

    const list = await call(manager.cookie, 'GET', `${admin.base}/approvals?state=pending`);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.pending).toBe(1);
    const done = await call(manager.cookie, 'POST', `${admin.base}/approvals/${r.body.approval.id}/approve`, { note: 'ok' });
    expect(done.body.approval.state).toBe('applied');
    expect(await level()).toBe(95);
    expect((await call(manager.cookie, 'POST', `${admin.base}/approvals/${r.body.approval.id}/approve`, {})).status).toBe(409); // never twice
    expect(await level()).toBe(95);
    // the ledger shows who asked, the activity log shows who approved
    const audit = (await call(admin.cookie, 'GET', `${admin.base}/audit`)).body.data.map((a: { action: string }) => a.action);
    expect(audit).toContain('approval.approve');
  });

  it('small adjustments go straight through, big ones wait, and approvers are never asked', async () => {
    const { stock, manager, move, level } = await setup();
    expect((await move(stock, -3, 'adjust')).status).toBe(201);
    expect((await move(stock, -25, 'adjust')).status).toBe(202); // over 20 units
    expect((await move(stock, 10, 'adjust')).status).toBe(201); // increases are not a loss
    expect((await move(manager, -30, 'adjust')).status).toBe(201); // the approver acts directly
    expect(await level()).toBe(100 - 3 + 10 - 30);
  });

  it('rejecting needs a reason, closes the request and tells the requester', async () => {
    const { admin, stock, manager, level, move } = await setup();
    const r = await move(stock, -6, 'damage');
    expect((await call(manager.cookie, 'POST', `${admin.base}/approvals/${r.body.approval.id}/reject`, {})).status).toBe(400);
    const rej = await call(manager.cookie, 'POST', `${admin.base}/approvals/${r.body.approval.id}/reject`, { note: 'recount first' });
    expect(rej.body.approval).toMatchObject({ state: 'rejected', note: 'recount first' });
    expect(await level()).toBe(100);
    for (let i = 0; i < 10; i++) { await flushEvents(env as never, admin.orgId); await new Promise((x) => setTimeout(x, 20)); }
    const mine = (await call(stock.cookie, 'GET', '/me/notifications')).body.data.map((n: { title: string }) => n.title);
    expect(mine.some((t: string) => t.startsWith('Not approved') && t.includes('recount first'))).toBe(true);
  });

  it('only the requester can withdraw, and only while pending', async () => {
    const { admin, stock, manager, move } = await setup();
    const r = await move(stock, -6, 'damage');
    const id = r.body.approval.id;
    expect((await call(manager.cookie, 'POST', `${admin.base}/approvals/${id}/withdraw`, {})).status).toBe(404);
    expect((await call(stock.cookie, 'POST', `${admin.base}/approvals/${id}/withdraw`, {})).body.approval.state).toBe('withdrawn');
    expect((await call(manager.cookie, 'POST', `${admin.base}/approvals/${id}/approve`, {})).status).toBe(409);
  });

  it('is checked against today\'s data: approving a request that no longer fits fails cleanly', async () => {
    const { admin, stock, manager, move, level } = await setup();
    const r = await move(stock, -25, 'adjust'); // waits
    await move(manager, -90, 'adjust'); // someone else drains the stock: 10 left
    const done = await call(manager.cookie, 'POST', `${admin.base}/approvals/${r.body.approval.id}/approve`, {});
    expect(done.body.approval.state).toBe('failed');
    expect(await level()).toBe(10); // unchanged by the failed request
  });

  it('a large count variance and cancelling a paid order wait too', async () => {
    const { admin, p, loc, stock, manager, level } = await setup();
    const c = await call(stock.cookie, 'POST', `${admin.base}/stock/counts`, { productId: p.id, locationId: loc, counted: 40 });
    expect(c.status).toBe(202);
    expect((await call(manager.cookie, 'POST', `${admin.base}/approvals/${c.body.approval.id}/approve`, {})).body.approval.state).toBe('applied');
    expect(await level()).toBe(40);

    const sales = await addMember(admin, 'sales');
    const o = (await call(admin.cookie, 'POST', `${admin.base}/orders`, { customerName: 'Paid Pat', paid: true, lines: [{ productId: p.id, quantity: 1 }] })).body.order;
    const cancel = await call(sales.cookie, 'POST', `${admin.base}/orders/${o.id}/cancel`, {}, { 'if-match': `"${o.version}"` });
    expect(cancel.status).toBe(202);
    expect((await call(admin.cookie, 'GET', `${admin.base}/orders/${o.id}`)).body.order.state).not.toBe('cancelled');
    await call(manager.cookie, 'POST', `${admin.base}/approvals/${cancel.body.approval.id}/approve`, {});
    expect((await call(admin.cookie, 'GET', `${admin.base}/orders/${o.id}`)).body.order.state).toBe('cancelled');
  });

  it('staff see only their own requests; people who cannot decide cannot decide', async () => {
    const { admin, stock, manager, move } = await setup();
    const other = await addMember(admin, 'stock');
    const r = await move(stock, -6, 'damage');
    expect((await call(stock.cookie, 'GET', `${admin.base}/approvals`)).body.data).toHaveLength(1);
    expect((await call(other.cookie, 'GET', `${admin.base}/approvals`)).body.data).toHaveLength(0);
    expect((await call(manager.cookie, 'GET', `${admin.base}/approvals`)).body.data).toHaveLength(1);
    for (const who of [stock, other]) expect((await call(who.cookie, 'POST', `${admin.base}/approvals/${r.body.approval.id}/approve`, {})).status).toBe(403);
  });
});
