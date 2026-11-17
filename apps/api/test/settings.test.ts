import { describe, expect, it } from 'vitest';
import { addMember, call, newOrg, product } from './helpers';

describe('F8 business settings', () => {
  it('has sensible defaults and only the admin can change them', async () => {
    const admin = await newOrg();
    const manager = await addMember(admin, 'manager');
    const d = await call(manager.cookie, 'GET', `${admin.base}/settings`);
    expect(d.body.settings).toMatchObject({ currency: 'USD', taxMode: 'none', taxRateBp: 0, timezone: 'UTC', orderPrefix: 'ORD-', poPrefix: 'PO-', invoicePrefix: 'INV-' });
    expect((await call(manager.cookie, 'PATCH', `${admin.base}/settings`, { taxRateBp: 500 })).status).toBe(403);
    const r = await call(admin.cookie, 'PATCH', `${admin.base}/settings`, { legalName: 'Acme Pvt', taxMode: 'exclusive', taxRateBp: 1300, timezone: 'Asia/Kathmandu', currency: 'npr' });
    expect(r.status).toBe(200);
    expect((await call(manager.cookie, 'GET', `${admin.base}/settings`)).body.settings).toMatchObject({ legalName: 'Acme Pvt', taxMode: 'exclusive', taxRateBp: 1300, currency: 'NPR' });
    // the currency also shows on the organization the app already loads
    expect((await call(manager.cookie, 'GET', `${admin.base}`)).body.organization.currency).toBe('NPR');
  });

  it('rejects bad values', async () => {
    const admin = await newOrg();
    for (const bad of [{ taxRateBp: 20000 }, { timezone: 'Mars/Base' }, { currency: 'DOLLARS' }, { orderPrefix: 'a b!' }, { unknown: 1 }, { email: 'nope' }]) {
      expect((await call(admin.cookie, 'PATCH', `${admin.base}/settings`, bad)).status, JSON.stringify(bad)).toBe(400);
    }
  });

  it('applies the order prefix and the default reorder point', async () => {
    const admin = await newOrg();
    await call(admin.cookie, 'PATCH', `${admin.base}/settings`, { orderPrefix: 'SO-', defaultReorderPoint: 7 });
    const p = await product(admin);
    expect((await call(admin.cookie, 'GET', `${admin.base}/products/${p.id}`)).body.product.reorderPoint).toBe(7);
    const o = await call(admin.cookie, 'POST', `${admin.base}/orders`, { customerName: 'A', lines: [{ productId: p.id, quantity: 1 }] });
    expect(o.status).toBe(201);
    expect(o.body.order.number).toMatch(/^SO-\d+$/);
  });

  it('locks the currency once the business has orders', async () => {
    const admin = await newOrg();
    const p = await product(admin);
    expect((await call(admin.cookie, 'PATCH', `${admin.base}/settings`, { currency: 'EUR' })).status).toBe(200);
    await call(admin.cookie, 'POST', `${admin.base}/orders`, { customerName: 'A', lines: [{ productId: p.id, quantity: 1 }] });
    const locked = await call(admin.cookie, 'PATCH', `${admin.base}/settings`, { currency: 'GBP' });
    expect(locked.status).toBe(409);
    expect(locked.body.type).toContain('currency-locked');
    expect((await call(admin.cookie, 'PATCH', `${admin.base}/settings`, { currency: 'EUR', taxRateBp: 100 })).status).toBe(200); // unchanged currency is fine
  });
});
