import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { dailyJob } from '../src/index';
import { addMember, call, loginAdmin, newOrg, product, uid } from './helpers';

const schedule = (org: { cookie: string; base: string }, confirmName = 'Doomed Co') => call(org.cookie, 'DELETE', org.base, { confirmName });
const past = (orgId: string) => env.DB.prepare(`UPDATE organizations SET delete_after = ? WHERE id = ?`).bind(new Date(Date.now() - 1000).toISOString(), orgId).run();

describe('delete with a 14-day grace period (F27)', () => {
  it('needs the exact business name and only the admin can ask', async () => {
    const org = await newOrg('Doomed Co');
    const manager = await addMember(org, 'manager');
    expect((await schedule({ ...org, cookie: manager.cookie })).status).toBe(403);
    const wrong = await schedule(org, 'doomed');
    expect(wrong.status).toBe(400);
    expect(wrong.body.type).toContain('name-mismatch');
    expect((await call(org.cookie, 'DELETE', org.base)).status).toBe(400); // no body at all
    expect((await call(org.cookie, 'GET', `${org.base}/products`)).status).toBe(200);
  });

  it('schedules 14 days out and then the business is read-only', async () => {
    const org = await newOrg('Doomed Co');
    const p = await product(org);
    const r = await schedule(org);
    expect(r.status).toBe(200);
    const days = (Date.parse(r.body.deleteAfter) - Date.now()) / 86400_000;
    expect(days).toBeGreaterThan(13.99);
    expect(days).toBeLessThan(14.01);
    // Reading and exporting still work; changing does not.
    expect((await call(org.cookie, 'GET', `${org.base}/products`)).status).toBe(200);
    const blocked = await call(org.cookie, 'POST', `${org.base}/products`, { sku: `S-${uid()}`, name: 'No', priceMinor: 1 });
    expect(blocked.status).toBe(403);
    expect(blocked.body.type).toContain('org-read-only');
    expect((await call(org.cookie, 'PATCH', `${org.base}/products/${p.id}`, { name: 'No' })).status).toBe(403);
    expect((await call(org.cookie, 'POST', `${org.base}/invitations`, { email: `${uid()}@example.com`, role: 'viewer' })).status).toBe(403);
    expect((await schedule(org)).status).toBe(403); // already read-only, so it cannot be scheduled again
    // The business list tells the app to show the banner.
    const me = await call(org.cookie, 'GET', '/me');
    expect(me.body.organizations.find((o: { id: string }) => o.id === org.orgId).deleteAfter).toBe(r.body.deleteAfter);
  });

  it('keys are read-only too, and an open support window ends', async () => {
    const org = await newOrg('Doomed Co');
    const key = await call(org.cookie, 'POST', `${org.base}/api-keys`, { name: 'k', scopes: ['inventory:read', 'inventory:write'] });
    const bearer = { authorization: `Bearer ${key.body.secret ?? key.body.key}` };
    const g = (await call(org.cookie, 'POST', `${org.base}/support-grants`, { minutes: 60 })).body.id;
    await schedule(org);
    expect((await call(null, 'POST', `${org.base}/products`, { sku: `K-${uid()}`, name: 'K', priceMinor: 1 }, { ...bearer, 'idempotency-key': uid() })).status).toBe(403);
    expect((await call(null, 'GET', `${org.base}/products`, undefined, bearer)).status).toBe(200);
    const dev = await loginAdmin();
    expect((await call(dev, 'GET', `${org.base}/products`, undefined, { 'x-support-grant': g })).status).toBe(404);
  });

  it('the admin can cancel, and then everything works again', async () => {
    const org = await newOrg('Doomed Co');
    await schedule(org);
    expect((await call(org.cookie, 'POST', `${org.base}/cancel-deletion`, {})).status).toBe(200);
    expect((await call(org.cookie, 'POST', `${org.base}/cancel-deletion`, {})).status).toBe(409);
    expect((await call(org.cookie, 'POST', `${org.base}/products`, { sku: `S-${uid()}`, name: 'Back', priceMinor: 1 })).status).toBe(201);
    await dailyJob(env);
    expect((await call(org.cookie, 'GET', `${org.base}/products`)).status).toBe(200);
  });

  it('the owner can cancel too, and the daily job leaves unfinished waits alone', async () => {
    const org = await newOrg('Doomed Co');
    await schedule(org);
    const dev = await loginAdmin();
    await dailyJob(env); // not due yet
    expect((await call(org.cookie, 'GET', `${org.base}/products`)).status).toBe(200);
    expect((await call(org.cookie, 'POST', '/admin/orgs/' + org.orgId + '/cancel-deletion', {})).status).toBe(404);
    expect((await call(dev, 'POST', `/admin/orgs/${org.orgId}/cancel-deletion`, {})).status).toBe(200);
    expect((await call(dev, 'POST', `/admin/orgs/${org.orgId}/cancel-deletion`, {})).status).toBe(409);
  });

  it('after the 14 days the daily job removes the data and the memberships', async () => {
    const org = await newOrg('Doomed Co');
    const staff = await addMember(org, 'viewer');
    await product(org);
    await call(org.cookie, 'POST', `${org.base}/webhooks`, { url: 'https://example.com/h', events: ['*'] });
    await schedule(org);
    await past(org.orgId);
    await dailyJob(env);
    // Gone for everyone who belonged to it.
    expect((await call(org.cookie, 'GET', `${org.base}/products`)).status).toBe(404);
    expect((await call(staff.cookie, 'GET', '/me')).body.organizations.find((o: { id: string }) => o.id === org.orgId)).toBeUndefined();
    const left = await env.DB.prepare(`SELECT (SELECT COUNT(*) FROM memberships WHERE org_id = ?1) AS m, (SELECT COUNT(*) FROM webhooks WHERE org_id = ?1) AS w, (SELECT COUNT(*) FROM api_keys WHERE org_id = ?1) AS k`).bind(org.orgId).first();
    expect(left).toEqual({ m: 0, w: 0, k: 0 });
    // The Durable Object's storage was emptied, and the owner's trail shows it.
    const dev = await loginAdmin();
    const detail = await call(dev, 'GET', `/admin/orgs/${org.orgId}`);
    expect(detail.body.organization.status).toBe('deleted');
    expect(detail.body.counts.products).toBe(0);
    expect(JSON.stringify((await call(dev, 'GET', '/admin/audit?limit=50')).body)).toContain('org.purged');
    // Running the job again changes nothing.
    await dailyJob(env);
  });
});
