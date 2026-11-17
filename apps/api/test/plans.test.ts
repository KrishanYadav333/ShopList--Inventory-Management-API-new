import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { addMember, call, defaultLocation, loginAdmin, newOrg, product, uid } from './helpers';

type Org = { cookie: string; base: string; orgId: string };
const setPlan = (org: Org, plan: string, overrides: unknown = null) =>
  env.DB.prepare(`UPDATE organizations SET plan_id = ?, plan_overrides = ? WHERE id = ?`).bind(plan, overrides ? JSON.stringify(overrides) : null, org.orgId).run();
const refused = (r: { status: number; body: any }) => { expect(r.status).toBe(403); expect(r.body.type).toContain('plan-limit'); };
const invite = (org: Org, email = `${uid()}@example.com`) => call(org.cookie, 'POST', `${org.base}/invitations`, { email, role: 'viewer' });
const imp = (org: Org, rows: unknown[]) => call(org.cookie, 'POST', `${org.base}/products/import`, { mode: 'create', rows }, { 'idempotency-key': uid() });

describe('plans and limits (F20)', () => {
  it('a business created through the app starts on the Free plan', async () => {
    const cookie = await (await import('./helpers')).login(`${uid()}@example.com`);
    const r = await call(cookie, 'POST', '/orgs', { name: 'Fresh Co' });
    const plan = await call(cookie, 'GET', `/orgs/${r.body.organization.id}/plan`);
    expect(plan.body.plan).toEqual({ id: 'free', name: 'Free' });
    expect(plan.body.limits).toMatchObject({ products: 2000, members: 5, locations: 2, apiKeys: 2, webhooks: 2 });
    expect(Object.values(plan.body.features).every(Boolean)).toBe(true);
  });

  it('refuses the member that passes the limit, counting pending invitations, and not before', async () => {
    const org = await newOrg();
    await setPlan(org, 'free');
    for (let i = 0; i < 4; i++) expect((await invite(org)).status).toBe(201); // owner + 4 = 5
    const email = `${uid()}@example.com`;
    refused(await invite(org, email));
    // Re-inviting someone who already has an open invitation does not need a second seat.
    const again = await call(org.cookie, 'GET', `${org.base}/invitations`);
    const existing = again.body.data[0].email;
    expect((await invite(org, existing)).status).toBe(201);
    await setPlan(org, 'free', { limits: { members: 6 } });
    expect((await invite(org, email)).status).toBe(201);
  });

  it('limits products at the boundary, for single creates and imports, but never blocks editing', async () => {
    const org = await newOrg();
    await setPlan(org, 'free', { limits: { products: 2 } });
    const a = await product(org);
    await product(org);
    refused(await call(org.cookie, 'POST', `${org.base}/products`, { sku: `S-${uid()}`, name: 'Third', priceMinor: 1 }));
    expect((await call(org.cookie, 'PATCH', `${org.base}/products/${a.id}`, { name: 'Renamed' }, { 'if-match': `"${a.version}"` })).status).toBe(200);
    const r = await imp(org, [{ sku: `I-${uid()}`, name: 'Imported', priceMinor: 100 }]);
    expect(r.body.results[0].status).toBe('error');
    expect(r.body.results[0].error).toContain('plan allows 2 products');
  });

  it('limits locations, API keys and webhooks', async () => {
    const org = await newOrg();
    await setPlan(org, 'free');
    expect((await call(org.cookie, 'POST', `${org.base}/locations`, { name: 'Second', code: `L${uid()}`.slice(0, 10) })).status).toBe(201); // default + 1 = 2
    refused(await call(org.cookie, 'POST', `${org.base}/locations`, { name: 'Third', code: `M${uid()}`.slice(0, 10) }));
    const key = () => call(org.cookie, 'POST', `${org.base}/api-keys`, { name: 'k', scopes: ['inventory:read'] });
    expect((await key()).status).toBe(201);
    expect((await key()).status).toBe(201);
    refused(await key());
    const hook = () => call(org.cookie, 'POST', `${org.base}/webhooks`, { url: 'https://example.com/hook', events: ['*'] });
    expect((await hook()).status).toBe(201);
    expect((await hook()).status).toBe(201);
    refused(await hook());
  });

  it('limits orders per month and imports per day', async () => {
    const org = await newOrg();
    await setPlan(org, 'free', { limits: { ordersPerMonth: 1, importsPerDay: 1 } });
    const p = await product(org);
    const loc = await defaultLocation(org);
    await call(org.cookie, 'POST', `${org.base}/stock/movements`, { productId: p.id, locationId: loc, delta: 10, reason: 'receive' });
    const order = () => call(org.cookie, 'POST', `${org.base}/orders`, { customerName: 'Pat', lines: [{ productId: p.id, quantity: 1 }] });
    expect((await order()).status).toBe(201);
    refused(await order());
    expect((await imp(org, [{ sku: `A-${uid()}`, name: 'A', priceMinor: 1 }])).status).toBe(200);
    refused(await imp(org, [{ sku: `B-${uid()}`, name: 'B', priceMinor: 1 }]));
    // Counted in rows: two rows do not fit in a day that has room for one.
    await setPlan(org, 'free', { limits: { importsPerDay: 5 } });
    expect((await imp(org, [1, 2, 3, 4].map((n) => ({ sku: `C${n}-${uid()}`, name: 'C', priceMinor: 1 })))).status).toBe(200);
    refused(await imp(org, [1, 2].map((n) => ({ sku: `D${n}-${uid()}`, name: 'D', priceMinor: 1 }))));
  });

  it('a switched-off feature 404s its routes and the others keep working', async () => {
    const org = await newOrg();
    await setPlan(org, 'free', { features: { purchasing: false, orders: false, reports: false, apiKeys: false, webhooks: false, approvals: false, import: false } });
    for (const path of ['purchase-orders', 'suppliers', 'purchasing/suggestions', 'orders', 'reports/sales', 'api-keys', 'webhooks', 'approvals']) {
      expect((await call(org.cookie, 'GET', `${org.base}/${path}`)).status, path).toBe(404);
    }
    expect((await call(org.cookie, 'POST', `${org.base}/products/import`, { mode: 'create', rows: [] }, { 'idempotency-key': uid() })).status).toBe(404);
    expect((await call(org.cookie, 'GET', `${org.base}/products`)).status).toBe(200);
    expect((await call(org.cookie, 'GET', `${org.base}/plan`)).body.features).toMatchObject({ purchasing: false, orders: false });
  });

  it('shows usage to admins only', async () => {
    const org = await newOrg();
    await setPlan(org, 'free');
    await product(org);
    const staff = await addMember(org, 'viewer');
    const admin = await call(org.cookie, 'GET', `${org.base}/plan`);
    expect(admin.body.usage).toMatchObject({ products: 1, locations: 1, members: 2, apiKeys: 0, webhooks: 0 });
    const viewer = await call(staff.cookie, 'GET', `${org.base}/plan`);
    expect(viewer.status).toBe(200);
    expect(viewer.body).not.toHaveProperty('usage');
  });

  it('the owner edits plans and per-business overrides; everyone else sees nothing', async () => {
    const owner = await loginAdmin();
    const org = await newOrg();
    await setPlan(org, 'free');
    const stranger = await call(org.cookie, 'GET', '/admin/plans');
    expect(stranger.status).toBe(404);
    const list = await call(owner, 'GET', '/admin/plans');
    expect(list.body.data.map((p: { id: string }) => p.id)).toEqual(['free', 'standard', 'custom']);
    // Raise one business without touching the plan.
    expect((await call(owner, 'PATCH', `/admin/orgs/${org.orgId}/plan`, { plan: 'free', overrides: { limits: { products: 1 }, features: { reports: false } } })).status).toBe(200);
    const detail = await call(owner, 'GET', `/admin/orgs/${org.orgId}`);
    expect(detail.body.plan).toEqual({ id: 'free', overrides: { limits: { products: 1 }, features: { reports: false } } });
    await product(org);
    refused(await call(org.cookie, 'POST', `${org.base}/products`, { sku: `S-${uid()}`, name: 'X', priceMinor: 1 }));
    expect((await call(org.cookie, 'GET', `${org.base}/reports/sales`)).status).toBe(404);
    // Clearing overrides returns to the plan.
    await call(owner, 'PATCH', `/admin/orgs/${org.orgId}/plan`, { plan: 'standard', overrides: null });
    expect((await call(org.cookie, 'GET', `${org.base}/plan`)).body.limits.products).toBe(20000);
    // Unknown plans and unknown keys are refused.
    expect((await call(owner, 'PATCH', `/admin/orgs/${org.orgId}/plan`, { plan: 'gold' })).status).toBe(404);
    expect((await call(owner, 'PATCH', `/admin/orgs/${org.orgId}/plan`, { plan: 'free', overrides: { limits: { bananas: 1 } } })).status).toBe(400);
    expect((await call(owner, 'PATCH', '/admin/plans/free', { limits: { products: -1 } })).status).toBe(400);
    // Changing a plan takes effect for everyone on it; null removes a limit.
    expect((await call(owner, 'PATCH', '/admin/plans/custom', { limits: { products: 7 } })).status).toBe(200);
    await setPlan(org, 'custom');
    expect((await call(org.cookie, 'GET', `${org.base}/plan`)).body.limits.products).toBe(7);
    await call(owner, 'PATCH', '/admin/plans/custom', { limits: { products: null } });
    expect((await call(org.cookie, 'GET', `${org.base}/plan`)).body.limits.products).toBeUndefined();
    const audit = await call(owner, 'GET', '/admin/audit?limit=20');
    expect(JSON.stringify(audit.body)).toContain('org.plan');
  });

  it('API keys obey the same switches and limits as people', async () => {
    const org = await newOrg();
    await setPlan(org, 'free', { features: { orders: false } });
    const k = await call(org.cookie, 'POST', `${org.base}/api-keys`, { name: 'k', scopes: ['inventory:read'] });
    const viaKey = (path: string) => call(null, 'GET', `${org.base}${path}`, undefined, { authorization: `Bearer ${k.body.secret ?? k.body.key}` });
    expect((await viaKey('/products')).status).toBe(200);
    expect((await viaKey('/orders')).status).toBe(404);
  });
});
