import { afterEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { addMember, call, loginAdmin, newOrg, product, uid } from './helpers';

// Maintenance is global state: always leave it off.
afterEach(async () => {
  await env.DB.prepare(`UPDATE maintenance SET ended_at = ? WHERE ended_at IS NULL`).bind(new Date().toISOString()).run();
  await call(await loginAdmin(), 'GET', '/announcements'); // reads clear the 5 s cache
});

const newProduct = (org: { cookie: string; base: string }) => call(org.cookie, 'POST', `${org.base}/products`, { sku: `S-${uid()}`, name: 'M', priceMinor: 1 });

describe('maintenance mode (F28)', () => {
  it('platform-wide: writes return 503 with Retry-After, reads and the owner console keep working', async () => {
    const org = await newOrg();
    const dev = await loginAdmin();
    const on = await call(dev, 'POST', '/admin/maintenance', { message: 'Upgrading the database' });
    expect(on.status).toBe(201);
    const w = await newProduct(org);
    expect(w.status).toBe(503);
    expect(w.body.type).toContain('maintenance');
    expect(w.body.detail).toBe('Upgrading the database');
    expect(w.headers.get('retry-after')).toBe('120');
    expect((await call(org.cookie, 'GET', `${org.base}/products`)).status).toBe(200);
    // Signing in and out, and the owner's own pages, are not blocked.
    expect((await call(org.cookie, 'POST', '/auth/logout', {})).status).toBe(200);
    expect((await call(dev, 'POST', '/admin/announcements', { message: 'x', severity: 'info', audience: 'everyone' })).status).toBe(201);
    expect((await call(dev, 'POST', '/admin/maintenance', {})).status).toBe(409);
    expect((await call(dev, 'DELETE', `/admin/maintenance/${on.body.id}`)).status).toBe(200);
    const org2 = await newOrg();
    expect((await newProduct(org2)).status).toBe(201);
  });

  it('one business: only that business is stopped', async () => {
    const a = await newOrg();
    const b = await newOrg();
    const dev = await loginAdmin();
    const on = await call(dev, 'POST', '/admin/maintenance', { orgId: a.orgId });
    expect((await newProduct(a)).status).toBe(503);
    expect((await newProduct(b)).status).toBe(201);
    expect((await call(a.cookie, 'GET', `${a.base}/products`)).status).toBe(200);
    expect((await call(dev, 'GET', '/admin/maintenance')).body.data[0]).toMatchObject({ orgId: a.orgId });
    await call(dev, 'DELETE', `/admin/maintenance/${on.body.id}`);
    expect((await newProduct(a)).status).toBe(201);
    expect((await call(dev, 'POST', '/admin/maintenance', { orgId: 'org_nope' })).status).toBe(404);
  });

  it('API keys are stopped too', async () => {
    const org = await newOrg();
    const key = await call(org.cookie, 'POST', `${org.base}/api-keys`, { name: 'k', scopes: ['inventory:write'] });
    const dev = await loginAdmin();
    await call(dev, 'POST', '/admin/maintenance', {});
    const r = await call(null, 'POST', `${org.base}/products`, { sku: `K-${uid()}`, name: 'K', priceMinor: 1 }, { authorization: `Bearer ${key.body.secret ?? key.body.key}`, 'idempotency-key': uid() });
    expect(r.status).toBe(503);
  });

  it('only the owner controls it', async () => {
    const org = await newOrg();
    expect((await call(org.cookie, 'POST', '/admin/maintenance', {})).status).toBe(404);
    expect((await call(org.cookie, 'POST', '/admin/announcements', { message: 'x', severity: 'info', audience: 'everyone' })).status).toBe(404);
  });

  it('people are told: a platform notice to everyone, a business notice to its members only', async () => {
    const a = await newOrg();
    const b = await newOrg();
    const dev = await loginAdmin();
    const all = await call(dev, 'POST', '/admin/maintenance', {});
    const only = await call(dev, 'POST', '/admin/maintenance', { orgId: a.orgId, message: 'Moving your data' });
    const ma = await call(a.cookie, 'GET', '/announcements');
    expect(ma.body.maintenance.map((m: { scope: string }) => m.scope).sort()).toEqual(['business', 'platform']);
    expect((await call(b.cookie, 'GET', '/announcements')).body.maintenance).toEqual([expect.objectContaining({ scope: 'platform' })]);
    await call(dev, 'DELETE', `/admin/maintenance/${all.body.id}`);
    await call(dev, 'DELETE', `/admin/maintenance/${only.body.id}`);
    expect((await call(a.cookie, 'GET', '/announcements')).body.maintenance).toEqual([]);
  });
});

describe('announcements (F28)', () => {
  const post = (dev: string, over: Record<string, unknown>) => call(dev, 'POST', '/admin/announcements', { message: `Note ${uid()}`, severity: 'info', audience: 'everyone', ...over });
  const seen = async (cookie: string) => (await call(cookie, 'GET', '/announcements')).body.data.map((a: { message: string }) => a.message);

  it('reaches the right audience', async () => {
    const org = await newOrg();
    const other = await newOrg();
    const viewer = await addMember(org, 'viewer');
    const dev = await loginAdmin();
    const e = (await post(dev, { message: 'for everyone' })).status;
    const ad = (await post(dev, { message: 'for admins', audience: 'admins', severity: 'warning' })).status;
    const o = (await post(dev, { message: 'for one business', audience: 'org', orgId: org.orgId })).status;
    expect([e, ad, o]).toEqual([201, 201, 201]);
    expect(await seen(org.cookie)).toEqual(expect.arrayContaining(['for everyone', 'for admins', 'for one business']));
    const v = await seen(viewer.cookie);
    expect(v).toContain('for everyone');
    expect(v).toContain('for one business');
    expect(v).not.toContain('for admins');
    const out = await seen(other.cookie);
    expect(out).toContain('for everyone');
    expect(out).toContain('for admins'); // an admin of another business
    expect(out).not.toContain('for one business');
  });

  it('respects start and end times and can be ended early', async () => {
    const org = await newOrg();
    const dev = await loginAdmin();
    const future = new Date(Date.now() + 3600_000).toISOString();
    const soon = new Date(Date.now() + 7200_000).toISOString();
    await post(dev, { message: 'later', startsAt: future, endsAt: soon });
    const now = await post(dev, { message: 'right now' });
    expect(await seen(org.cookie)).toContain('right now');
    expect(await seen(org.cookie)).not.toContain('later');
    expect((await call(dev, 'DELETE', `/admin/announcements/${now.body.id}`)).status).toBe(200);
    expect(await seen(org.cookie)).not.toContain('right now');
    expect((await call(dev, 'DELETE', `/admin/announcements/${now.body.id}`)).status).toBe(404);
  });

  it('validates the input', async () => {
    const dev = await loginAdmin();
    expect((await post(dev, { audience: 'org' })).status).toBe(400);
    expect((await post(dev, { message: '' })).status).toBe(400);
    expect((await post(dev, { severity: 'panic' })).status).toBe(400);
    expect((await post(dev, { startsAt: new Date(Date.now() + 1000).toISOString(), endsAt: new Date().toISOString() })).status).toBe(400);
    void product;
  });
});
