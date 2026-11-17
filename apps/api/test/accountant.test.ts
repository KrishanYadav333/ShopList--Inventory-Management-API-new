import { describe, expect, it } from 'vitest';
import { addMember, call, defaultLocation, newOrg, product } from './helpers';

describe('accountant role', () => {
  it('reads costs and the activity log but changes nothing', async () => {
    const admin = await newOrg();
    const acc = await addMember(admin, 'accountant');
    const p = await product(admin, { costMinor: 400 });
    const loc = await defaultLocation(admin);
    const list = await call(acc.cookie, 'GET', `${admin.base}/products`);
    expect(JSON.stringify(list.body)).toContain('costMinor');
    expect((await call(acc.cookie, 'GET', `${admin.base}/dashboard`)).body.inventoryValueMinor).toBeTypeOf('number');
    expect((await call(acc.cookie, 'GET', `${admin.base}/audit`)).status).toBe(200);
    expect((await call(acc.cookie, 'POST', `${admin.base}/products`, { sku: 'A', name: 'A', priceMinor: 1 })).status).toBe(403);
    expect((await call(acc.cookie, 'POST', `${admin.base}/stock/movements`, { productId: p.id, locationId: loc, delta: 1, reason: 'receive' })).status).toBe(403);
    expect((await call(acc.cookie, 'POST', `${admin.base}/orders`, { customerName: 'x', lines: [{ productId: p.id, quantity: 1 }] })).status).toBe(403);
    expect((await call(acc.cookie, 'GET', `${admin.base}/api-keys`)).status).toBe(403);
    expect((await call(acc.cookie, 'POST', `${admin.base}/invitations`, { email: 'z@example.com', role: 'viewer' })).status).toBe(403);
  });
});
