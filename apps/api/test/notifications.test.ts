import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { flushEvents } from '../src/webhooks';
import { addMember, call, defaultLocation, newOrg, product } from './helpers';

/** Writes finish before the Worker drains events in the background, so wait for the drain. */
async function drain(orgId: string) {
  for (let i = 0; i < 20; i++) { await flushEvents(env as never, orgId); await new Promise((r) => setTimeout(r, 25)); }
}
const titles = async (cookie: string) => (await call(cookie, 'GET', '/me/notifications')).body.data.map((n: { title: string }) => n.title) as string[];

describe('F11 notifications', () => {
  it('low and out-of-stock reach managers, admin and stock keepers, but not sales or viewers', async () => {
    const admin = await newOrg();
    const stock = await addMember(admin, 'stock');
    const sales = await addMember(admin, 'sales');
    const viewer = await addMember(admin, 'viewer');
    const p = await product(admin, { reorderPoint: 5 });
    const loc = await defaultLocation(admin);
    await call(admin.cookie, 'POST', `${admin.base}/stock/movements`, { productId: p.id, locationId: loc, delta: 10, reason: 'receive' });
    await call(admin.cookie, 'POST', `${admin.base}/stock/movements`, { productId: p.id, locationId: loc, delta: -6, reason: 'sale' }); // 4 left: low
    await call(admin.cookie, 'POST', `${admin.base}/stock/movements`, { productId: p.id, locationId: loc, delta: -4, reason: 'sale' }); // 0: out
    await drain(admin.orgId);
    for (const who of [admin, stock]) {
      const t = await titles(who.cookie);
      expect(t.some((x) => x.startsWith('Low stock'))).toBe(true);
      expect(t.some((x) => x.startsWith('Out of stock'))).toBe(true);
    }
    expect(await titles(sales.cookie)).toHaveLength(0);
    expect(await titles(viewer.cookie)).toHaveLength(0);
  });

  it('new orders reach sales, tracks unread, and read state is per person', async () => {
    const admin = await newOrg();
    const sales = await addMember(admin, 'sales');
    const p = await product(admin);
    const loc = await defaultLocation(admin);
    await call(admin.cookie, 'POST', `${admin.base}/stock/movements`, { productId: p.id, locationId: loc, delta: 5, reason: 'receive' });
    await call(admin.cookie, 'POST', `${admin.base}/orders`, { customerName: 'Dana', lines: [{ productId: p.id, quantity: 1 }] });
    await drain(admin.orgId);
    expect((await titles(sales.cookie)).some((x) => x.includes('Dana'))).toBe(true);
    expect((await call(sales.cookie, 'GET', '/me/notifications/unread-count')).body.count).toBe(1);
    const adminCount = (await call(admin.cookie, 'GET', '/me/notifications/unread-count')).body.count;
    await call(sales.cookie, 'POST', '/me/notifications/read', {});
    expect((await call(sales.cookie, 'GET', '/me/notifications/unread-count')).body.count).toBe(0);
    expect((await call(admin.cookie, 'GET', '/me/notifications/unread-count')).body.count).toBe(adminCount); // admin's are untouched
  });

  it('preferences switch a kind off, and nobody sees another business\'s notifications', async () => {
    const a = await newOrg();
    const b = await newOrg();
    await call(a.cookie, 'PATCH', '/me/notification-preferences', { orgId: a.orgId, kind: 'order.created', inApp: false });
    const prefs = await call(a.cookie, 'GET', `/me/notification-preferences?org=${a.orgId}`);
    expect(prefs.body.data.find((k: { kind: string }) => k.kind === 'order.created').inApp).toBe(false);
    const p = await product(a);
    const loc = await defaultLocation(a);
    await call(a.cookie, 'POST', `${a.base}/stock/movements`, { productId: p.id, locationId: loc, delta: 5, reason: 'receive' });
    await call(a.cookie, 'POST', `${a.base}/orders`, { customerName: 'Quiet', lines: [{ productId: p.id, quantity: 1 }] });
    await drain(a.orgId);
    expect((await titles(a.cookie)).some((x) => x.includes('Quiet'))).toBe(false);
    expect(await titles(b.cookie)).toHaveLength(0);
    expect((await call(b.cookie, 'PATCH', '/me/notification-preferences', { orgId: a.orgId, kind: 'stock.low', inApp: false })).status).toBe(404);
  });

  it('a deactivated member stops receiving and no longer sees them', async () => {
    const admin = await newOrg();
    const staff = await addMember(admin, 'manager');
    const p = await product(admin, { reorderPoint: 5 });
    const loc = await defaultLocation(admin);
    await call(admin.cookie, 'POST', `${admin.base}/stock/movements`, { productId: p.id, locationId: loc, delta: 10, reason: 'receive' });
    await call(admin.cookie, 'POST', `${admin.base}/stock/movements`, { productId: p.id, locationId: loc, delta: -6, reason: 'sale' });
    await drain(admin.orgId);
    expect((await call(staff.cookie, 'GET', '/me/notifications/unread-count')).body.count).toBeGreaterThan(0);
    const uid = (await call(staff.cookie, 'GET', '/me')).body.user.id;
    await call(admin.cookie, 'POST', `${admin.base}/members/${uid}/deactivate`, {});
    expect((await call(staff.cookie, 'GET', '/me/notifications/unread-count')).body.count).toBe(0);
  });
});
