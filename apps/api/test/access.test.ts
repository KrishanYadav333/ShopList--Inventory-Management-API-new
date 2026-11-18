import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { addMember, call, loginAdmin, newOrg, product, uid } from './helpers';

type Org = { cookie: string; base: string; orgId: string };
const ask = (dev: string, org: Org, over: Record<string, unknown> = {}) => call(dev, 'POST', `/admin/orgs/${org.orgId}/access-requests`, { minutes: 60, reason: 'invoices look wrong', ...over });
const decide = (org: Org, rid: string, body: Record<string, unknown>) => call(org.cookie, 'POST', `${org.base}/access-requests/${rid}/decide`, body);
const asDev = (dev: string, g: string, method: string, path: string, body?: unknown) => call(dev, method, path, body, { 'x-support-grant': g });

describe('access requests (A1)', () => {
  it('only the owner can ask, only the business admin can answer', async () => {
    const org = await newOrg('Ask Co');
    const dev = await loginAdmin();
    expect((await call(org.cookie, 'POST', `/admin/orgs/${org.orgId}/access-requests`, { minutes: 60, reason: 'x y z' })).status).toBe(404);
    const r = await ask(dev, org);
    expect(r.status).toBe(201);
    const staff = await addMember(org, 'manager');
    expect((await call(staff.cookie, 'GET', `${org.base}/access-requests`)).status).toBe(403);
    expect((await call(staff.cookie, 'POST', `${org.base}/access-requests/${r.body.id}/decide`, { decision: 'approve' })).status).toBe(403);
    expect((await call(dev, 'POST', `${org.base}/access-requests/${r.body.id}/decide`, { decision: 'approve' })).status).toBe(404);
  });

  it('nothing opens until the admin approves; approving gives a read-only window by default', async () => {
    const org = await newOrg('Approve Co');
    const p = await product(org);
    const dev = await loginAdmin();
    const r = (await ask(dev, org)).body;
    expect((await asDev(dev, r.id, 'GET', `${org.base}/products`)).status).toBe(404);
    const ok = await decide(org, r.id, { decision: 'approve' });
    expect(ok.body).toMatchObject({ state: 'approved', write: false, minutes: 60 });
    expect((await asDev(dev, ok.body.grantId, 'GET', `${org.base}/products`)).status).toBe(200);
    expect((await asDev(dev, ok.body.grantId, 'PATCH', `${org.base}/products/${p.id}`, { name: 'No' })).body.type).toContain('support-read-only');
  });

  it('the write tick is honoured, the admin can narrow it but never widen it, and delete is always refused', async () => {
    const org = await newOrg('Tick Co');
    const p = await product(org);
    const dev = await loginAdmin();
    const r = (await ask(dev, org, { write: true, minutes: 240 })).body;
    const ok = (await decide(org, r.id, { decision: 'approve', minutes: 30 })).body;
    expect(ok).toMatchObject({ write: true, minutes: 30 });
    expect((await asDev(dev, ok.grantId, 'PATCH', `${org.base}/products/${p.id}`, { name: 'Renamed by support' })).status).not.toBe(403);
    expect((await asDev(dev, ok.grantId, 'DELETE', `${org.base}/products/${p.id}`)).body.type).toContain('support-no-delete');

    const org2 = await newOrg('Narrow Co');
    const r2 = (await ask(dev, org2, { write: true })).body;
    const g2 = (await decide(org2, r2.id, { decision: 'approve', write: false })).body;
    expect(g2.write).toBe(false);

    const org3 = await newOrg('Wide Co');
    const r3 = (await ask(dev, org3, { write: false, minutes: 30 })).body;
    const g3 = (await decide(org3, r3.id, { decision: 'approve', write: true, minutes: 240 })).body;
    expect(g3).toMatchObject({ write: false, minutes: 30 });
  });

  it('one pending request at a time, and a decline blocks a new request for 15 minutes', async () => {
    const org = await newOrg('Spam Co');
    const dev = await loginAdmin();
    const r = (await ask(dev, org)).body;
    expect((await ask(dev, org)).status).toBe(409);
    expect((await decide(org, r.id, { decision: 'decline' })).body.state).toBe('declined');
    expect((await decide(org, r.id, { decision: 'approve' })).status).toBe(409);
    const again = await ask(dev, org);
    expect(again.status).toBe(429);
    await env.DB.prepare(`UPDATE access_requests SET decided_at = ? WHERE org_id = ?`).bind(new Date(Date.now() - 20 * 60_000).toISOString(), org.orgId).run();
    expect((await ask(dev, org)).status).toBe(201);
  });

  it('a request nobody answers expires after 48 hours and cannot be approved', async () => {
    const org = await newOrg('Late Co');
    const dev = await loginAdmin();
    const r = (await ask(dev, org)).body;
    await env.DB.prepare(`UPDATE access_requests SET expires_at = ? WHERE id = ?`).bind(new Date(Date.now() - 1000).toISOString(), r.id).run();
    expect((await decide(org, r.id, { decision: 'approve' })).status).toBe(409);
    const list = (await call(org.cookie, 'GET', `${org.base}/access-requests`)).body.data;
    expect(list[0].state).toBe('expired');
  });

  it('the owner can withdraw a pending request', async () => {
    const org = await newOrg('Withdraw Co');
    const dev = await loginAdmin();
    const r = (await ask(dev, org)).body;
    expect((await call(dev, 'DELETE', `/admin/access-requests/${r.id}`)).status).toBe(200);
    expect((await decide(org, r.id, { decision: 'approve' })).status).toBe(409);
    expect((await call(dev, 'DELETE', `/admin/access-requests/${r.id}`)).status).toBe(404);
  });

  it('both sides are told, and both audits record it', async () => {
    const org = await newOrg('Notice Co');
    const dev = await loginAdmin();
    const r = (await ask(dev, org, { reason: `look at ${uid()}` })).body;
    const adminNotes = JSON.stringify((await call(org.cookie, 'GET', '/me/notifications')).body);
    expect(adminNotes).toContain('ShopList support asks to look at your business');
    await decide(org, r.id, { decision: 'approve' });
    const ownerNotes = JSON.stringify((await call(dev, 'GET', '/me/notifications')).body);
    expect(ownerNotes).toContain('approved your request');
    const n = await env.DB.prepare(`SELECT COUNT(*) AS n FROM platform_audit WHERE action = 'access.request' AND target = ?`).bind(org.orgId).first<{ n: number }>();
    expect(n!.n).toBe(1);
    const log = JSON.stringify((await call(org.cookie, 'GET', `${org.base}/audit?limit=50`)).body);
    expect(log).toContain('support.request');
    expect(log).toContain('support.grant');
  });

  it('suspending the business cancels a pending request, and a business without the feature gets none', async () => {
    const org = await newOrg('Pause Co');
    const dev = await loginAdmin();
    const r = (await ask(dev, org)).body;
    await call(dev, 'POST', `/admin/orgs/${org.orgId}/suspend`, {});
    const row = await env.DB.prepare(`SELECT state FROM access_requests WHERE id = ?`).bind(r.id).first<{ state: string }>();
    expect(row!.state).toBe('cancelled');
    expect((await ask(dev, org)).status).toBe(404);
  });

  it('the owner sees requests across businesses', async () => {
    const org = await newOrg('List Co');
    const dev = await loginAdmin();
    const r = (await ask(dev, org)).body;
    const list = (await call(dev, 'GET', '/admin/access-requests')).body.data as { id: string; orgName: string; state: string }[];
    expect(list.find((x) => x.id === r.id)).toMatchObject({ orgName: 'List Co', state: 'pending' });
  });

  it('a business asking for help still opens at once and tells the owner, with the tick', async () => {
    const org = await newOrg('Help Co');
    const dev = await loginAdmin();
    const g = await call(org.cookie, 'POST', `${org.base}/support-grants`, { minutes: 30, note: 'please fix', write: true });
    expect(g.body).toMatchObject({ write: true, mode: 'assist' });
    expect((await asDev(dev, g.body.id, 'GET', `${org.base}/products`)).status).toBe(200);
    expect((await call(org.cookie, 'POST', `${org.base}/support-grants`, { minutes: 30, write: true })).status).toBe(400); // a reason is needed for changes
  });
});
