import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { addMember, call, defaultLocation, loginAdmin, newOrg, product, uid } from './helpers';

type Org = { cookie: string; base: string; orgId: string };
const grant = (org: Org, over: Record<string, unknown> = {}) => call(org.cookie, 'POST', `${org.base}/support-grants`, { minutes: 60, note: 'numbers look wrong', ...over });
const asDev = (dev: string, grantId: string, method: string, path: string, body?: unknown) => call(dev, method, path, body, { 'x-support-grant': grantId });

async function seed() {
  const org = await newOrg('Support Co');
  const p = await product(org, { costMinor: 400 });
  const loc = await defaultLocation(org);
  await call(org.cookie, 'POST', `${org.base}/stock/movements`, { productId: p.id, locationId: loc, delta: 10, reason: 'receive' });
  await call(org.cookie, 'POST', `${org.base}/orders`, { customerName: 'Dana', customerEmail: 'dana@example.com', lines: [{ productId: p.id, quantity: 1 }] });
  return { org, p };
}

describe('support access (F19)', () => {
  it('without a grant the owner sees nothing, with or without the header', async () => {
    const { org } = await seed();
    const dev = await loginAdmin();
    expect((await call(dev, 'GET', `${org.base}/products`)).status).toBe(404);
    expect((await asDev(dev, 'sgr_made_up', 'GET', `${org.base}/products`)).status).toBe(404);
  });

  it('only the business admin can grant; the owner cannot grant themselves access', async () => {
    const { org } = await seed();
    const dev = await loginAdmin();
    const manager = await addMember(org, 'manager');
    expect((await grant({ ...org, cookie: manager.cookie })).status).toBe(403);
    expect((await call(dev, 'POST', `${org.base}/support-grants`, { minutes: 60 })).status).toBe(404);
    expect((await call(dev, 'POST', `${org.base}/support-grants`, { minutes: 60 }, { 'x-support-grant': 'x' })).status).toBe(404);
    expect((await grant(org, { minutes: 999 })).status).toBe(400);
    expect((await grant(org)).status).toBe(201);
  });

  it('inside a grant the owner can read inventory with costs, but never write, and never see people or settings', async () => {
    const { org, p } = await seed();
    const dev = await loginAdmin();
    const g = (await grant(org)).body.id;
    const prods = await asDev(dev, g, 'GET', `${org.base}/products`);
    expect(prods.status).toBe(200);
    expect(prods.body.data[0].costMinor).toBe(400);
    for (const path of ['/orders', '/dashboard', '/stock/movements', '/locations', '/reports/valuation', '/suppliers', '/purchase-orders']) {
      expect((await asDev(dev, g, 'GET', `${org.base}${path}`)).status, path).toBe(200);
    }
    // Writes of every kind are refused before routing.
    expect((await asDev(dev, g, 'POST', `${org.base}/products`, { sku: 'X', name: 'X', priceMinor: 1 })).body.type).toContain('support-read-only');
    expect((await asDev(dev, g, 'PATCH', `${org.base}/products/${p.id}`, { name: 'Hacked' })).status).toBe(403);
    expect((await asDev(dev, g, 'DELETE', `${org.base}/products/${p.id}`)).status).toBe(403);
    expect((await asDev(dev, g, 'POST', `${org.base}/stock/movements`, { productId: p.id, delta: 1, reason: 'receive' })).status).toBe(403);
    // Not part of support access.
    for (const path of ['/members', '/invitations', '/settings', '/api-keys', '/webhooks', '/audit', '/approvals', '/support-grants']) {
      expect((await asDev(dev, g, 'GET', `${org.base}${path}`)).status, path).toBe(403);
    }
    // Customer contact details stay hidden unless the admin ticked the box.
    const orders = await asDev(dev, g, 'GET', `${org.base}/orders`);
    expect(JSON.stringify(orders.body)).not.toContain('dana@example.com');
    expect((await asDev(dev, g, 'GET', `${org.base}/customers`)).status).toBe(403);
    // And the product really did not change.
    expect((await call(org.cookie, 'GET', `${org.base}/products/${p.id}`)).body.product.name).toBe('Widget');
  });

  it('shows customer contact details only when the admin included them', async () => {
    const { org } = await seed();
    const dev = await loginAdmin();
    const g = (await grant(org, { includeCustomers: true })).body.id;
    expect((await asDev(dev, g, 'GET', `${org.base}/customers`)).status).toBe(200);
    expect(JSON.stringify((await asDev(dev, g, 'GET', `${org.base}/orders`)).body)).toContain('dana@example.com');
  });

  it('a grant works for its own business only, and for the owner only', async () => {
    const a = await seed();
    const b = await seed();
    const dev = await loginAdmin();
    const g = (await grant(a.org)).body.id;
    expect((await asDev(dev, g, 'GET', `${b.org.base}/products`)).status).toBe(404);
    const stranger = await newOrg('Stranger');
    expect((await asDev(stranger.cookie, g, 'GET', `${a.org.base}/products`)).status).toBe(404);
    // A member of the business gains nothing from the header either.
    expect((await asDev(a.org.cookie, g, 'POST', `${a.org.base}/members`, {})).status).not.toBe(200);
  });

  it('ends at once when the admin ends it, and when time runs out', async () => {
    const { org } = await seed();
    const dev = await loginAdmin();
    const g = (await grant(org)).body.id;
    expect((await asDev(dev, g, 'GET', `${org.base}/products`)).status).toBe(200);
    expect((await call(org.cookie, 'DELETE', `${org.base}/support-grants/${g}`)).status).toBe(200);
    expect((await asDev(dev, g, 'GET', `${org.base}/products`)).status).toBe(404);
    expect((await call(org.cookie, 'DELETE', `${org.base}/support-grants/${g}`)).status).toBe(404);
    const g2 = (await grant(org)).body.id;
    await env.DB.prepare(`UPDATE support_grants SET expires_at = ? WHERE id = ?`).bind(new Date(Date.now() - 1000).toISOString(), g2).run();
    expect((await asDev(dev, g2, 'GET', `${org.base}/products`)).status).toBe(404);
  });

  it('a new grant replaces the open one', async () => {
    const { org } = await seed();
    const dev = await loginAdmin();
    const first = (await grant(org)).body.id;
    const second = (await grant(org, { minutes: 30 })).body.id;
    expect((await asDev(dev, first, 'GET', `${org.base}/products`)).status).toBe(404);
    expect((await asDev(dev, second, 'GET', `${org.base}/products`)).status).toBe(200);
  });

  it('logs every page at both ends and tells the admin how many were viewed', async () => {
    const { org } = await seed();
    const dev = await loginAdmin();
    const g = (await grant(org)).body.id;
    for (const path of ['/products', '/orders', '/dashboard']) await asDev(dev, g, 'GET', `${org.base}${path}`);
    const history = await call(org.cookie, 'GET', `${org.base}/support-grants`);
    expect(history.body.data[0]).toMatchObject({ id: g, views: 3, active: true, note: 'numbers look wrong' });
    expect(history.body.data[0].firstViewAt).toBeTruthy();
    const audit = (await call(org.cookie, 'GET', `${org.base}/audit?limit=50`)).body.data as { actor: string; action: string }[];
    expect(audit.filter((a) => a.action === 'support.view')).toHaveLength(3);
    expect(audit.filter((a) => a.action === 'support.view')[0].actor).toMatch(/^support:/);
    expect(audit.some((a) => a.action === 'support.grant')).toBe(true);
    const rows = await env.DB.prepare(`SELECT detail FROM platform_audit WHERE action = 'support.view' AND target = ?`).bind(org.orgId).all<{ detail: string }>();
    expect(rows.results).toHaveLength(3);
    expect(rows.results.map((r) => JSON.parse(r.detail).path)).toContain('/orgs/' + org.orgId + '/orders');
  });

  it('notifies the owner and lists open windows for them only', async () => {
    const { org } = await seed();
    const dev = await loginAdmin();
    const g = (await grant(org, { note: 'help' })).body.id;
    expect(JSON.stringify((await call(dev, 'GET', '/me/notifications')).body)).toContain('opened support access for 60 minutes: help');
    const open = await call(dev, 'GET', '/admin/support');
    expect(open.body.data.find((x: { id: string }) => x.id === g)).toMatchObject({ orgName: 'Support Co', orgId: org.orgId });
    expect((await call(org.cookie, 'GET', '/admin/support')).status).toBe(404);
    await call(org.cookie, 'DELETE', `${org.base}/support-grants/${g}`);
    expect((await call(dev, 'GET', '/admin/support')).body.data.find((x: { id: string }) => x.id === g)).toBeUndefined();
  });

  it('can be switched off for a business', async () => {
    const { org } = await seed();
    const dev = await loginAdmin();
    const g = (await grant(org)).body.id;
    await env.DB.prepare(`UPDATE organizations SET plan_overrides = ? WHERE id = ?`).bind(JSON.stringify({ features: { supportAccess: false } }), org.orgId).run();
    expect((await asDev(dev, g, 'GET', `${org.base}/products`)).status).toBe(404);
    expect((await grant(org)).status).toBe(404);
  });

  it('is not available to a suspended business', async () => {
    const { org } = await seed();
    const dev = await loginAdmin();
    const g = (await grant(org)).body.id;
    await env.DB.prepare(`UPDATE organizations SET suspended_at = ? WHERE id = ?`).bind(new Date().toISOString(), org.orgId).run();
    expect((await asDev(dev, g, 'GET', `${org.base}/products`)).status).toBe(404);
    void uid;
  });
});

describe('hands-on support (assist mode)', () => {
  it('needs a reason, and a plain grant stays read-only', async () => {
    const { org } = await seed();
    expect((await grant(org, { mode: 'assist', note: undefined })).status).toBe(400);
    expect((await grant(org, { mode: 'assist', note: 'ab' })).status).toBe(400);
    const dev = await loginAdmin();
    const g = (await grant(org)).body;
    expect(g.mode).toBe('view');
    expect((await asDev(dev, g.id, 'POST', `${org.base}/products`, { sku: 'V1', name: 'V', priceMinor: 1 })).body.type).toContain('support-read-only');
  });

  it('assist can change inventory, is recorded as ShopList support, and cannot delete or reach people and settings', async () => {
    const { org, p } = await seed();
    const dev = await loginAdmin();
    const g = (await grant(org, { mode: 'assist', note: 'fix the prices' })).body;
    expect(g.mode).toBe('assist');
    const made = await asDev(dev, g.id, 'POST', `${org.base}/products`, { sku: `A-${uid()}`, name: 'Made by support', priceMinor: 500 });
    expect(made.status).toBe(201);
    expect((await asDev(dev, g.id, 'PATCH', `${org.base}/products/${p.id}`, { name: 'Renamed' }, )).status).not.toBe(403);
    expect((await asDev(dev, g.id, 'DELETE', `${org.base}/products/${p.id}`)).body.type).toContain('support-no-delete');
    for (const path of ['/members', '/api-keys', '/webhooks', '/audit', '/support-grants']) {
      expect((await asDev(dev, g.id, 'GET', `${org.base}${path}`)).status, path).toBeGreaterThanOrEqual(403);
    }
    expect((await asDev(dev, g.id, 'POST', `${org.base}/invitations`, { email: 'x@example.com', role: 'viewer' })).status).toBeGreaterThanOrEqual(403);
    // The business history names support, never a person.
    const hist = await call(org.cookie, 'GET', `${org.base}/stock/movements`);
    expect(hist.status).toBe(200);
    const list = await call(org.cookie, 'GET', `${org.base}/support-grants`);
    expect(list.body.data[0].acts).toBeGreaterThanOrEqual(2);
    const audit = await env.DB.prepare(`SELECT COUNT(*) AS n FROM platform_audit WHERE action = 'support.act' AND target = ?`).bind(org.orgId).first<{ n: number }>();
    expect(audit!.n).toBeGreaterThanOrEqual(2);
    const log = await call(org.cookie, 'GET', `${org.base}/audit?limit=50`);
    expect(JSON.stringify(log.body)).toContain('support:shoplist');
  });

  it('ending the window stops assist at once', async () => {
    const { org } = await seed();
    const dev = await loginAdmin();
    const g = (await grant(org, { mode: 'assist', note: 'help' })).body;
    await call(org.cookie, 'DELETE', `${org.base}/support-grants/${g.id}`);
    expect((await asDev(dev, g.id, 'POST', `${org.base}/products`, { sku: `Z-${uid()}`, name: 'Z', priceMinor: 1 })).status).toBe(404);
  });
});
