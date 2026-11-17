import { describe, expect, it } from 'vitest';
import { addMember, call, login, newOrg, product, uid } from './helpers';

async function twoSites() {
  const admin = await newOrg();
  const a = (await call(admin.cookie, 'GET', `${admin.base}/locations`)).body.data[0].id as string;
  const b = (await call(admin.cookie, 'POST', `${admin.base}/locations`, { name: 'Warehouse B', code: 'WHB' })).body.location.id as string;
  const p = await product(admin);
  return { admin, a, b, p };
}
const move = (productId: string, locationId: string, delta = 5) => ({ productId, locationId, delta, reason: 'receive' });

describe('F9 location scoping', () => {
  it('a scoped stock keeper can read everywhere but only write at their locations', async () => {
    const { admin, a, b, p } = await twoSites();
    const keeper = await addMember(admin, 'stock');
    const uid_ = (await call(keeper.cookie, 'GET', '/me')).body.user.id;
    expect((await call(admin.cookie, 'PATCH', `${admin.base}/members/${uid_}`, { locationIds: [a] })).status).toBe(200);

    expect((await call(keeper.cookie, 'GET', `${admin.base}/stock/movements`)).status).toBe(200);
    expect((await call(keeper.cookie, 'POST', `${admin.base}/stock/movements`, move(p.id, a))).status).toBe(201);
    const refused = await call(keeper.cookie, 'POST', `${admin.base}/stock/movements`, move(p.id, b));
    expect(refused.status).toBe(403);
    expect(refused.body.type).toContain('location-not-allowed');
    expect((await call(keeper.cookie, 'POST', `${admin.base}/stock/counts`, { productId: p.id, locationId: b, counted: 1 })).status).toBe(403);
    // transfers: out of their own location is fine, out of someone else's is not
    expect((await call(keeper.cookie, 'POST', `${admin.base}/stock/transfers`, { productId: p.id, fromLocationId: a, toLocationId: b, quantity: 1 })).status).toBe(201);
    expect((await call(keeper.cookie, 'POST', `${admin.base}/stock/transfers`, { productId: p.id, fromLocationId: b, toLocationId: a, quantity: 1 })).status).toBe(403);
  });

  it('scoped sales staff order from their own location by default and cannot act on other locations\' orders', async () => {
    const { admin, a, b, p } = await twoSites();
    await call(admin.cookie, 'POST', `${admin.base}/stock/movements`, move(p.id, a, 10));
    await call(admin.cookie, 'POST', `${admin.base}/stock/movements`, move(p.id, b, 10));
    const sales = await addMember(admin, 'sales');
    const sid = (await call(sales.cookie, 'GET', '/me')).body.user.id;
    await call(admin.cookie, 'PATCH', `${admin.base}/members/${sid}`, { locationIds: [a] });

    const mine = await call(sales.cookie, 'POST', `${admin.base}/orders`, { customerName: 'A', lines: [{ productId: p.id, quantity: 1 }] });
    expect(mine.status).toBe(201);
    expect(mine.body.order.locationId).toBe(a);
    expect((await call(sales.cookie, 'POST', `${admin.base}/orders`, { customerName: 'B', locationId: b, lines: [{ productId: p.id, quantity: 1 }] })).status).toBe(403);
    const other = await call(admin.cookie, 'POST', `${admin.base}/orders`, { customerName: 'C', locationId: b, paid: true, lines: [{ productId: p.id, quantity: 1 }] });
    expect((await call(sales.cookie, 'POST', `${admin.base}/orders/${other.body.order.id}/ship`, {}, { 'if-match': `"${other.body.order.version}"` })).status).toBe(403);
    expect((await call(sales.cookie, 'POST', `${admin.base}/orders/${other.body.order.id}/cancel`, {}, { 'if-match': `"${other.body.order.version}"` })).status).toBe(403);
    expect((await call(admin.cookie, 'POST', `${admin.base}/orders/${other.body.order.id}/ship`, {}, { 'if-match': `"${other.body.order.version}"` })).status).toBe(200);
  });

  it('an empty list means no write access, unknown locations are refused, admins are never scoped', async () => {
    const { admin, a, p } = await twoSites();
    const keeper = await addMember(admin, 'stock');
    const id = (await call(keeper.cookie, 'GET', '/me')).body.user.id;
    expect((await call(admin.cookie, 'PATCH', `${admin.base}/members/${id}`, { locationIds: [] })).status).toBe(200);
    expect((await call(keeper.cookie, 'POST', `${admin.base}/stock/movements`, move(p.id, a))).status).toBe(403);
    expect((await call(admin.cookie, 'PATCH', `${admin.base}/members/${id}`, { locationIds: ['loc_nope'] })).status).toBe(400);
    expect((await call(admin.cookie, 'PATCH', `${admin.base}/members/${id}`, { locationIds: null })).status).toBe(200);
    expect((await call(keeper.cookie, 'POST', `${admin.base}/stock/movements`, move(p.id, a))).status).toBe(201);
    // promoting to admin clears any scope
    await call(admin.cookie, 'PATCH', `${admin.base}/members/${id}`, { locationIds: [a] });
    await call(admin.cookie, 'PATCH', `${admin.base}/members/${id}`, { role: 'admin', confirmSecondAdmin: true });
    const m = (await call(admin.cookie, 'GET', `${admin.base}/members`)).body.data.find((x: { id: string }) => x.id === id);
    expect(m.locationIds).toBeNull();
  });

  it('an invitation can carry the location limit, and staff cannot see the limits of others', async () => {
    const { admin, a, b, p } = await twoSites();
    const email = `${uid()}@example.com`;
    const inv = await call(admin.cookie, 'POST', `${admin.base}/invitations`, { email, role: 'stock', locationIds: [b] });
    const cookie = await login(email);
    await call(cookie, 'POST', `/invitations/${inv.body.token}/accept`, {});
    expect((await call(cookie, 'POST', `${admin.base}/stock/movements`, move(p.id, a))).status).toBe(403);
    expect((await call(cookie, 'POST', `${admin.base}/stock/movements`, move(p.id, b))).status).toBe(201);
    expect(JSON.stringify((await call(cookie, 'GET', `${admin.base}/members`)).body)).not.toContain('locationIds');
  });
});
