import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import worker from '../src/index';
import { addMember, call, ip, login, loginAdmin, newOrg, ORIGIN, product, uid } from './helpers';

const accept = (cookie: string, token: string) => call(cookie, 'POST', `/invitations/${token}/accept`, {});

describe('F1 onboarding', () => {
  it('the platform owner creates a business with no members and invites its admin', async () => {
    const dev = await loginAdmin();
    const adminEmail = `${uid()}-boss@example.com`;
    const r = await call(dev, 'POST', '/admin/orgs', { name: 'Fresh Foods', adminEmail, currency: 'npr' });
    expect(r.status).toBe(201);
    const id = r.body.organization.id;
    const detail = await call(dev, 'GET', `/admin/orgs/${id}`);
    expect(detail.body.organization.status).toBe('pending');
    expect(detail.body.members).toHaveLength(0);
    expect(detail.body.pendingInvitations).toHaveLength(1);
    // The owner is not a member: tenant data stays unreachable.
    expect((await call(dev, 'GET', `/orgs/${id}/products`)).status).toBe(404);

    const boss = await login(adminEmail);
    const token = r.body.invitation.link.split('/invite/')[1];
    expect((await accept(boss, token)).body.role).toBe('admin');
    expect((await call(dev, 'GET', `/admin/orgs/${id}`)).body.organization.status).toBe('active');
    expect((await call(boss, 'GET', `/orgs/${id}/audit`)).status).toBe(200);
  });

  it('refuses the owner\'s own email, ordinary users, and signed-out callers', async () => {
    const dev = await loginAdmin();
    const me = (await call(dev, 'GET', '/me')).body.user;
    expect((await call(dev, 'POST', '/admin/orgs', { name: 'X', adminEmail: me.email })).status).toBe(409);
    const plain = await login();
    expect((await call(plain, 'POST', '/admin/orgs', { name: 'X', adminEmail: 'a@example.com' })).status).toBe(404);
    expect((await call(null, 'POST', '/admin/orgs', { name: 'X', adminEmail: 'a@example.com' })).status).toBe(401);
  });

  it('resend gives a new link and kills the old one', async () => {
    const dev = await loginAdmin();
    const email = `${uid()}@example.com`;
    const r = await call(dev, 'POST', '/admin/orgs', { name: 'Resend Co', adminEmail: email });
    const again = await call(dev, 'POST', `/admin/orgs/${r.body.organization.id}/resend-invitation`, {});
    const user = await login(email);
    expect((await accept(user, r.body.invitation.link.split('/invite/')[1])).status).toBe(404);
    expect((await accept(user, again.body.link.split('/invite/')[1])).status).toBe(200);
  });

  it('in invite mode nobody creates an organization by themselves', async () => {
    const cookie = await login();
    const req = new Request(`${ORIGIN}/api/v1/orgs`, { method: 'POST', headers: { origin: ORIGIN, cookie, 'content-type': 'application/json', 'cf-connecting-ip': ip() }, body: JSON.stringify({ name: 'Mine' }) });
    const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
    const res = await worker.fetch(req, { ...env, SIGNIN_MODE: 'invite' } as never, ctx);
    expect(res.status).toBe(403);
    expect((await res.json() as { type: string }).type).toContain('org-creation-closed');
  });
});

describe('F2 pending invitations', () => {
  it('lists, replaces duplicates, resends and revokes, never exposing a token', async () => {
    const admin = await newOrg();
    const email = `${uid()}@example.com`;
    const first = await call(admin.cookie, 'POST', `${admin.base}/invitations`, { email, role: 'viewer' });
    const second = await call(admin.cookie, 'POST', `${admin.base}/invitations`, { email, role: 'sales' });
    const list = await call(admin.cookie, 'GET', `${admin.base}/invitations`);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0]).toMatchObject({ email, role: 'sales' });
    expect(JSON.stringify(list.body)).not.toContain(second.body.token);
    const user = await login(email);
    expect((await accept(user, first.body.token)).status).toBe(404); // replaced

    const resent = await call(admin.cookie, 'POST', `${admin.base}/invitations/${list.body.data[0].id}/resend`, {});
    expect((await accept(user, second.body.token)).status).toBe(404);
    const newList = await call(admin.cookie, 'GET', `${admin.base}/invitations`);
    expect((await call(admin.cookie, 'DELETE', `${admin.base}/invitations/${newList.body.data[0].id}`)).status).toBe(200);
    expect((await accept(user, resent.body.link.split('/invite/')[1])).status).toBe(404);
    expect((await call(admin.cookie, 'GET', `${admin.base}/invitations`)).body.data).toHaveLength(0);
  });

  it('refuses inviting an existing member and is admin only', async () => {
    const admin = await newOrg();
    const staff = await addMember(admin, 'manager');
    expect((await call(admin.cookie, 'POST', `${admin.base}/invitations`, { email: staff.email, role: 'viewer' })).status).toBe(409);
    for (const m of ['GET', 'POST']) expect((await call(staff.cookie, m, `${admin.base}/invitations`, m === 'POST' ? { email: 'a@example.com', role: 'viewer' } : undefined)).status).toBe(403);
  });
});

describe('F3 member lifecycle', () => {
  it('a deactivated member loses access at once and regains it on reactivation', async () => {
    const admin = await newOrg();
    const staff = await addMember(admin, 'manager');
    expect((await call(staff.cookie, 'GET', `${admin.base}/products`)).status).toBe(200);
    expect((await call(admin.cookie, 'POST', `${admin.base}/members/${staff.userId}/deactivate`, {})).status).toBe(200);
    expect((await call(staff.cookie, 'GET', `${admin.base}/products`)).status).toBe(404);
    expect((await call(staff.cookie, 'GET', '/me')).body.organizations).toHaveLength(0);
    const members = await call(admin.cookie, 'GET', `${admin.base}/members`);
    expect(members.body.data.find((m: { id: string }) => m.id === staff.userId).deactivatedAt).toBeTruthy(); // history keeps the person
    expect((await call(admin.cookie, 'POST', `${admin.base}/members/${staff.userId}/reactivate`, {})).status).toBe(200);
    expect((await call(staff.cookie, 'GET', `${admin.base}/products`)).status).toBe(200);
  });

  it('the last active admin cannot be deactivated', async () => {
    const admin = await newOrg();
    const me = (await call(admin.cookie, 'GET', '/me')).body.user.id;
    expect((await call(admin.cookie, 'POST', `${admin.base}/members/${me}/deactivate`, {})).status).toBe(409);
  });

  it('handing over swaps the roles in one step and needs the business name', async () => {
    const admin = await newOrg('Handover Ltd');
    const next = await addMember(admin, 'manager');
    expect((await call(admin.cookie, 'POST', `${admin.base}/admin-handover`, { userId: next.userId, confirmName: 'wrong' })).status).toBe(400);
    expect((await call(admin.cookie, 'POST', `${admin.base}/admin-handover`, { userId: next.userId, confirmName: 'Handover Ltd' })).status).toBe(200);
    expect((await call(next.cookie, 'GET', `${admin.base}/audit`)).status).toBe(200); // now admin
    expect((await call(admin.cookie, 'GET', `${admin.base}/audit`)).status).toBe(403); // now manager
  });

  it('the platform owner can restore an admin without gaining access to the data', async () => {
    const dev = await loginAdmin();
    const admin = await newOrg();
    const staff = await addMember(admin, 'manager');
    expect((await call(dev, 'POST', `/admin/orgs/${admin.orgId}/transfer-admin`, { userId: staff.userId })).status).toBe(200);
    expect((await call(staff.cookie, 'GET', `${admin.base}/audit`)).status).toBe(200);
    expect((await call(dev, 'GET', `${admin.base}/products`)).status).toBe(404);
  });
});

describe('F4 member privacy', () => {
  it('only people who manage the team see emails and last activity', async () => {
    const admin = await newOrg();
    const sales = await addMember(admin, 'sales');
    const asAdmin = await call(admin.cookie, 'GET', `${admin.base}/members`);
    expect(asAdmin.body.data[0].email).toBeTruthy();
    const asSales = await call(sales.cookie, 'GET', `${admin.base}/members`);
    expect(asSales.status).toBe(200);
    expect(asSales.body.data.length).toBe(2);
    expect(JSON.stringify(asSales.body)).not.toContain('@example.com');
    expect(JSON.stringify(asSales.body)).not.toContain('lastSeenAt');
  });
});

describe('F6 platform detail pages', () => {
  it('a business page has numbers and people but never product or customer data', async () => {
    const dev = await loginAdmin();
    const admin = await newOrg();
    await product(admin, { name: 'Secret Sauce Recipe', sku: 'SECRET-1' });
    const r = await call(dev, 'GET', `/admin/orgs/${admin.orgId}`);
    expect(r.status).toBe(200);
    expect(r.body.counts.products).toBe(1);
    expect(r.body.members).toHaveLength(1);
    expect(JSON.stringify(r.body)).not.toContain('Secret Sauce');
    expect(JSON.stringify(r.body)).not.toContain('SECRET-1');
    expect((await call(admin.cookie, 'GET', `/admin/orgs/${admin.orgId}`)).status).toBe(404);
  });

  it('a user page shows sign-in methods and sessions, and sign-out ends them', async () => {
    const dev = await loginAdmin();
    const email = `${uid()}@example.com`;
    const cookie = await login(email);
    const id = (await call(cookie, 'GET', '/me')).body.user.id;
    const r = await call(dev, 'GET', `/admin/users/${id}`);
    expect(r.body.sessions.length).toBeGreaterThan(0);
    expect((await call(dev, 'POST', `/admin/users/${id}/sign-out`, {})).body.revoked).toBeGreaterThan(0);
    expect((await call(cookie, 'GET', '/me')).status).toBe(401);
    expect((await call(cookie, 'GET', `/admin/users/${id}`)).status).toBe(401);
  });
});
