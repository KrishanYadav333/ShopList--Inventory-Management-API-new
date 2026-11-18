import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { addMember, call, loginAdmin, newOrg, product } from './helpers';

type Org = { cookie: string; base: string; orgId: string };
const ask = (dev: string, org: Org, over: Record<string, unknown> = {}) => call(dev, 'POST', `/admin/orgs/${org.orgId}/access-requests`, { kind: 'impersonate', reasonCode: 'team_setup', minutes: 30, reason: 'check the roles', ...over });
const approve = (org: Org, rid: string, body: Record<string, unknown> = {}) => call(org.cookie, 'POST', `${org.base}/access-requests/${rid}/decide`, { decision: 'approve', ...body });
const asDev = (dev: string, g: string, method: string, path: string, body?: unknown) => call(dev, method, path, body, { 'x-support-grant': g });

async function window(over: Record<string, unknown> = {}, approveWith: Record<string, unknown> = {}) {
  const org = await newOrg('Imp Co');
  const dev = await loginAdmin();
  const r = await ask(dev, org, over);
  const ok = await approve(org, r.body.id, approveWith);
  return { org, dev, rid: r.body.id as string, grant: ok.body.grantId as string, ok };
}

describe('viewing a business as its admin (A2)', () => {
  it('needs a reason from the list, 30 or 60 minutes, and the admin approves', async () => {
    const org = await newOrg('Rules Co');
    const dev = await loginAdmin();
    expect((await ask(dev, org, { reasonCode: undefined })).status).toBe(400);
    expect((await ask(dev, org, { reasonCode: 'nonsense' })).status).toBe(400);
    expect((await ask(dev, org, { minutes: 240 })).status).toBe(400);
    expect((await ask(dev, org, { reasonCode: 'other', reason: 'short' })).status).toBe(400);
    const r = await ask(dev, org);
    expect(r.status).toBe(201);
    expect(JSON.stringify((await call(org.cookie, 'GET', '/me/notifications')).body)).toContain('as you see it');
    expect((await call(dev, 'GET', '/admin/orgs/' + org.orgId)).status).toBe(200);
  });

  it('read-only by default: the admin screens (team, settings, activity) can be read, nothing changed', async () => {
    const { org, dev, grant } = await window();
    for (const path of ['/members', '/invitations', '/settings', '/audit?limit=5', '/products', '/support-grants']) {
      expect((await asDev(dev, grant, 'GET', `${org.base}${path}`)).status, path).toBe(200);
    }
    expect((await asDev(dev, grant, 'PATCH', `${org.base}/settings`, { currency: 'EUR' })).body.type).toContain('support-read-only');
    expect((await asDev(dev, grant, 'POST', `${org.base}/products`, { sku: 'Z1', name: 'Z', priceMinor: 1 })).body.type).toContain('support-read-only');
  });

  it('never reaches API keys or webhooks, even to read', async () => {
    const { org, dev, grant } = await window();
    for (const path of ['/api-keys', '/webhooks']) expect((await asDev(dev, grant, 'GET', `${org.base}${path}`)).status, path).toBe(403);
  });

  it('with the write tick, settings and inventory can change, but never people, invitations, keys, grants or deletion', async () => {
    const { org, dev, grant } = await window({ write: true });
    const p = await product(org);
    expect((await asDev(dev, grant, 'PATCH', `${org.base}/settings`, { lowStockThreshold: 7 })).status).not.toBe(403);
    expect((await asDev(dev, grant, 'PATCH', `${org.base}/products/${p.id}`, { name: 'Fixed' })).status).not.toBe(403);
    const staff = await addMember(org, 'viewer');
    const members = (await asDev(dev, grant, 'GET', `${org.base}/members`)).body.data as { id: string }[];
    expect((await asDev(dev, grant, 'DELETE', `${org.base}/members/${members[0].id}`)).body.type).toContain('support-no-delete');
    expect((await asDev(dev, grant, 'POST', `${org.base}/invitations`, { email: 'x@example.com', role: 'viewer' })).status).toBe(403);
    expect((await asDev(dev, grant, 'POST', `${org.base}/api-keys`, { name: 'k', scopes: ['inventory:read'] })).status).toBe(403);
    expect((await asDev(dev, grant, 'POST', `${org.base}/support-grants`, { minutes: 30 })).status).toBe(403);
    expect((await asDev(dev, grant, 'POST', `${org.base}/admin-handover`, { userId: 'x' })).status).toBe(403);
    expect((await asDev(dev, grant, 'POST', `${org.base}/cancel-deletion`, {})).status).toBe(403);
    expect((await call(staff.cookie, 'GET', `${org.base}/products`)).status).toBe(200);
  });

  it('the business history says ShopList support acting as the admin, never the admin by name', async () => {
    const { org, dev, grant } = await window({ write: true });
    const p = await product(org);
    await asDev(dev, grant, 'PATCH', `${org.base}/products/${p.id}`, { name: 'By support' });
    const log = JSON.stringify((await call(org.cookie, 'GET', `${org.base}/audit?limit=50`)).body);
    expect(log).toContain('support:shoplist:as:');
    const row = await env.DB.prepare(`SELECT detail FROM platform_audit WHERE action = 'support.act' AND target = ? ORDER BY created_at DESC LIMIT 1`).bind(org.orgId).first<{ detail: string }>();
    expect(JSON.parse(row!.detail).actingAs).toMatch(/^usr_/);
  });

  it('it is the approving admin only, and nothing opens before approval', async () => {
    const org = await newOrg('Wait Co');
    const dev = await loginAdmin();
    const r = (await ask(dev, org)).body;
    expect((await asDev(dev, r.id, 'GET', `${org.base}/members`)).status).toBe(404);
    const staff = await addMember(org, 'manager');
    expect((await call(staff.cookie, 'POST', `${org.base}/access-requests/${r.id}/decide`, { decision: 'approve' })).status).toBe(403);
  });

  it('the admin can narrow it to read-only and a shorter time, and a plain access request is unchanged', async () => {
    const { ok } = await window({ write: true, minutes: 60 }, { write: false, minutes: 30 });
    expect(ok.body).toMatchObject({ write: false, minutes: 30 });
    const org = await newOrg('Plain Co');
    const dev = await loginAdmin();
    const r = (await call(dev, 'POST', `/admin/orgs/${org.orgId}/access-requests`, { minutes: 240, reason: 'plain look' })).body;
    const g = (await approve(org, r.id)).body.grantId;
    expect((await asDev(dev, g, 'GET', `${org.base}/members`)).status).toBe(403); // plain support still cannot see people
  });

  it('the window ends when the admin loses the role, and when it is ended', async () => {
    const { org, dev, grant } = await window();
    expect((await asDev(dev, grant, 'GET', `${org.base}/members`)).status).toBe(200);
    await env.DB.prepare(`UPDATE memberships SET deactivated_at = ? WHERE org_id = ? AND role = 'admin'`).bind(new Date().toISOString(), org.orgId).run();
    expect((await asDev(dev, grant, 'GET', `${org.base}/members`)).status).toBe(404);
    const w2 = await window();
    await call(w2.org.cookie, 'DELETE', `${w2.org.base}/support-grants/${w2.grant}`);
    expect((await asDev(w2.dev, w2.grant, 'GET', `${w2.org.base}/members`)).status).toBe(404);
  });

  it('the owner and admin both see that it is a view-as window', async () => {
    const { org, dev } = await window();
    expect(((await call(dev, 'GET', '/admin/support')).body.data as { impersonating: boolean }[]).some((g) => g.impersonating)).toBe(true);
    expect((await call(org.cookie, 'GET', `${org.base}/support-grants`)).body.data[0].impersonating).toBe(true);
  });
});
