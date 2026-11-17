import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { addMember, call, defaultLocation, newOrg, product } from './helpers';

const token = (link: string) => link.split('/').pop()!;
const pub = (method: string, path: string, body?: unknown) => call(null, method, path, body);

async function orderSetup() {
  const org = await newOrg('Link Co');
  await call(org.cookie, 'PATCH', `${org.base}/settings`, { legalName: 'Link Company Ltd', address: '1 Main St' });
  const p = await product(org, { name: 'Blue pen', costMinor: 40, priceMinor: 250 });
  const loc = await defaultLocation(org);
  await call(org.cookie, 'POST', `${org.base}/stock/movements`, { productId: p.id, locationId: loc, delta: 20, reason: 'receive' });
  const o = (await call(org.cookie, 'POST', `${org.base}/orders`, { customerName: 'Dana Customer', customerEmail: 'dana@example.com', note: 'INTERNAL: she is slow to pay', lines: [{ productId: p.id, quantity: 2 }] })).body.order;
  return { org, p, o };
}
async function poSetup(send = true) {
  const org = await newOrg('Supply Co');
  const loc = await defaultLocation(org);
  const p = await product(org, { sku: 'P-9', name: 'Paper', costMinor: 100 });
  const sup = (await call(org.cookie, 'POST', `${org.base}/suppliers`, { name: 'Acme Supply', email: 'sales@acme.example', note: 'INTERNAL supplier note' })).body.supplier;
  const po = (await call(org.cookie, 'POST', `${org.base}/purchase-orders`, { supplierId: sup.id, locationId: loc, note: 'Deliver to dock 2', lines: [{ productId: p.id, quantity: 10, unitCostMinor: 120 }] })).body.order;
  if (send) await call(org.cookie, 'POST', `${org.base}/purchase-orders/${po.id}/send`, {});
  return { org, p, po, sup };
}

describe('customer order link (F24)', () => {
  it('shows the order and nothing internal: no cost, no contact details, no notes, no ids', async () => {
    const { org, o } = await orderSetup();
    const made = await call(org.cookie, 'POST', `${org.base}/orders/${o.id}/share`, {});
    expect(made.status).toBe(201);
    expect(made.body.link).toMatch(/\/s\/o\/[A-Za-z0-9_-]{43}$/);
    const r = await pub('GET', `/s/o/${token(made.body.link)}`);
    expect(r.status).toBe(200);
    expect(r.body.business).toEqual({ name: 'Link Company Ltd', address: '1 Main St' });
    expect(r.body.order).toMatchObject({ number: o.number, state: o.state, paid: false });
    expect(r.body.order.lines).toEqual([{ name: 'Blue pen', quantity: 2, unitPriceMinor: 250, lineMinor: 500 }]);
    const raw = JSON.stringify(r.body);
    for (const secret of ['dana@example.com', 'Dana', 'INTERNAL', 'slow to pay', 'costMinor', '"40"', o.id, org.orgId, 'createdBy', 'sku']) expect(raw, secret).not.toContain(secret);
    expect(r.headers.get('x-robots-tag')).toContain('noindex');
    expect(r.headers.get('referrer-policy')).toBe('no-referrer');
    expect(r.headers.get('cache-control')).toBe('no-store');
  });

  it('only people who may write orders can make or revoke a link; the link dies on revoke and expiry', async () => {
    const { org, o } = await orderSetup();
    const viewer = await addMember(org, 'viewer');
    const sales = await addMember(org, 'sales');
    expect((await call(viewer.cookie, 'POST', `${org.base}/orders/${o.id}/share`, {})).status).toBe(403);
    expect((await call(org.cookie, 'POST', `${org.base}/orders/ord_nope/share`, {})).status).toBe(404);
    const a = (await call(sales.cookie, 'POST', `${org.base}/orders/${o.id}/share`, {})).body.link;
    const b = (await call(org.cookie, 'POST', `${org.base}/orders/${o.id}/share`, {})).body.link;
    expect((await pub('GET', `/s/o/${token(a)}`)).status).toBe(200);
    expect((await call(org.cookie, 'DELETE', `${org.base}/orders/${o.id}/share`)).body.revoked).toBe(2);
    expect((await pub('GET', `/s/o/${token(a)}`)).status).toBe(404);
    expect((await pub('GET', `/s/o/${token(b)}`)).status).toBe(404);
    const c = (await call(org.cookie, 'POST', `${org.base}/orders/${o.id}/share`, {})).body.link;
    await env.DB.prepare(`UPDATE share_links SET expires_at = ? WHERE token_hash <> ''`).bind(new Date(Date.now() - 1000).toISOString()).run();
    expect((await pub('GET', `/s/o/${token(c)}`)).status).toBe(404);
  });

  it('an order link is not a purchase-order link, junk tokens look the same as unknown ones, and storage holds only a hash', async () => {
    const { org, o } = await orderSetup();
    const link = (await call(org.cookie, 'POST', `${org.base}/orders/${o.id}/share`, {})).body.link;
    expect((await pub('GET', `/s/po/${token(link)}`)).status).toBe(404);
    expect((await pub('GET', '/s/o/short')).status).toBe(404);
    expect((await pub('GET', `/s/o/${'A'.repeat(43)}`)).status).toBe(404);
    const rows = await env.DB.prepare(`SELECT token_hash FROM share_links`).all<{ token_hash: string }>();
    expect(rows.results.some((r) => r.token_hash.includes(token(link)))).toBe(false);
  });

  it('stops working when the business is suspended or deleted, and shows the new state as the order moves', async () => {
    const { org, o } = await orderSetup();
    const link = (await call(org.cookie, 'POST', `${org.base}/orders/${o.id}/share`, {})).body.link;
    await call(org.cookie, 'POST', `${org.base}/orders/${o.id}/paid`, { paid: true }, { 'if-match': `"${o.version}"` });
    expect((await pub('GET', `/s/o/${token(link)}`)).body.order.paid).toBe(true);
    await env.DB.prepare(`UPDATE organizations SET suspended_at = ? WHERE id = ?`).bind(new Date().toISOString(), org.orgId).run();
    expect((await pub('GET', `/s/o/${token(link)}`)).status).toBe(404);
  });
});

describe('supplier purchase-order link (F25)', () => {
  it('shows the supplier what they need, and no more', async () => {
    const { org, po } = await poSetup();
    const made = await call(org.cookie, 'POST', `${org.base}/purchase-orders/${po.id}/share`, {});
    expect(made.status).toBe(201);
    const r = await pub('GET', `/s/po/${token(made.body.link)}`);
    expect(r.status).toBe(200);
    expect(r.body.po).toMatchObject({ number: po.number, state: 'sent', note: 'Deliver to dock 2', supplierName: 'Acme Supply', totalMinor: 1200, confirmedAt: null, dispatchedAt: null });
    expect(r.body.po.lines).toEqual([{ sku: 'P-9', name: 'Paper', quantity: 10, received: 0, unitCostMinor: 120 }]);
    const raw = JSON.stringify(r.body);
    for (const secret of ['INTERNAL', 'sales@acme.example', po.id, org.orgId, 'createdBy', 'supplierId', 'locationId']) expect(raw, secret).not.toContain(secret);
  });

  it('only a sent purchase order can be shared, and only by people who may purchase', async () => {
    const draft = await poSetup(false);
    expect((await call(draft.org.cookie, 'POST', `${draft.org.base}/purchase-orders/${draft.po.id}/share`, {})).status).toBe(409);
    const { org, po } = await poSetup();
    const stock = await addMember(org, 'stock');
    expect((await call(stock.cookie, 'POST', `${org.base}/purchase-orders/${po.id}/share`, {})).status).toBe(403);
  });

  it('confirm and dispatch update the order, tell the managers, and repeating a click changes nothing', async () => {
    const { org, po } = await poSetup();
    const mgr = await addMember(org, 'manager');
    const t = token((await call(org.cookie, 'POST', `${org.base}/purchase-orders/${po.id}/share`, {})).body.link);
    expect((await pub('POST', `/s/po/${t}/confirm`, {})).status).toBe(200);
    const first = (await call(org.cookie, 'GET', `${org.base}/purchase-orders/${po.id}`)).body.order;
    expect(first.supplierConfirmedAt).toBeTruthy();
    expect((await pub('POST', `/s/po/${t}/confirm`, { note: 'again' })).status).toBe(200);
    expect((await call(org.cookie, 'GET', `${org.base}/purchase-orders/${po.id}`)).body.order.supplierConfirmedAt).toBe(first.supplierConfirmedAt);
    expect((await pub('POST', `/s/po/${t}/dispatched`, { note: 'Tracking AB123' })).status).toBe(200);
    const view = await pub('GET', `/s/po/${t}`);
    expect(view.body.po).toMatchObject({ supplierNote: 'Tracking AB123' });
    expect(view.body.po.dispatchedAt).toBeTruthy();
    await new Promise((r) => setTimeout(r, 200));
    const notes = JSON.stringify((await call(mgr.cookie, 'GET', '/me/notifications')).body);
    expect(notes).toContain('Acme Supply confirmed');
    expect(notes).toContain('dispatched');
    const audit = JSON.stringify((await call(org.cookie, 'GET', `${org.base}/audit?limit=50`)).body);
    expect(audit).toContain('po.supplier_confirm');
    expect(audit).toContain('"supplier"');
  });

  it('validates the note and refuses once the order is closed or the link is revoked', async () => {
    const { org, po } = await poSetup();
    const t = token((await call(org.cookie, 'POST', `${org.base}/purchase-orders/${po.id}/share`, {})).body.link);
    expect((await pub('POST', `/s/po/${t}/confirm`, { note: 'x'.repeat(301) })).status).toBe(400);
    expect((await pub('POST', `/s/po/${t}/confirm`, { evil: 1 })).status).toBe(400);
    await call(org.cookie, 'POST', `${org.base}/purchase-orders/${po.id}/cancel`, {});
    const closed = await pub('POST', `/s/po/${t}/dispatched`, {});
    expect(closed.status).toBe(409);
    expect(closed.body.type).toContain('po-closed');
    expect((await call(org.cookie, 'DELETE', `${org.base}/purchase-orders/${po.id}/share`)).body.revoked).toBe(1);
    expect((await pub('POST', `/s/po/${t}/confirm`, {})).status).toBe(404);
  });
});
