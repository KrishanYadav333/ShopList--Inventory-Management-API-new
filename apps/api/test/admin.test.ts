import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { mayUse, signinClosed } from '../src/auth';
import { ROUTES } from '../src/index';
import { call, login, loginAdmin, newOrg, product, uid } from './helpers';

const ADMIN_GETS = ['/admin/overview', '/admin/orgs', '/admin/users', '/admin/audit'];

describe('super admin access control', () => {
  it('every /admin route is declared super-admin only', () => {
    const admin = ROUTES.filter((r) => r.path.startsWith('/admin'));
    expect(admin.length).toBeGreaterThanOrEqual(8);
    for (const r of admin) expect(r.access, `${r.method} ${r.path}`).toBe('super');
  });

  it('anonymous callers get 401 and ordinary users get 404, so the area is not discoverable', async () => {
    const user = await login();
    for (const path of ADMIN_GETS) {
      expect((await call(null, 'GET', path)).status, path).toBe(401);
      expect((await call(user, 'GET', path)).status, path).toBe(404);
    }
    expect((await call(user, 'POST', '/admin/users/usr_x/disable', {})).status).toBe(404);
    expect((await call(user, 'POST', '/admin/orgs/org_x/suspend', {})).status).toBe(404);
  });

  it('only one account can hold the role: a new holder replaces the old one', async () => {
    const first = await loginAdmin();
    expect((await call(first, 'GET', '/admin/overview')).status).toBe(200);
    const second = await loginAdmin();
    expect((await call(second, 'GET', '/admin/overview')).status).toBe(200);
    expect((await call(first, 'GET', '/admin/overview')).status).toBe(404);
  });

  it('/me tells the UI who the super admin is, and nobody else', async () => {
    const admin = await loginAdmin();
    expect((await call(admin, 'GET', '/me')).body.user.isSuperAdmin).toBe(true);
    expect((await call(await login(), 'GET', '/me')).body.user.isSuperAdmin).toBe(false);
  });
});

describe('platform visibility without tenant data', () => {
  it('lists organizations and users but never exposes or reaches inventory', async () => {
    const org = await newOrg('Secret Bakery');
    await product(org, { sku: 'RECIPE-SECRET-1', name: 'Secret recipe' });
    const admin = await loginAdmin();

    const orgs = await call(admin, 'GET', '/admin/orgs?limit=200');
    expect(orgs.status).toBe(200);
    const row = orgs.body.data.find((o: any) => o.id === org.orgId);
    expect(row).toMatchObject({ name: 'Secret Bakery', members: 1, suspendedAt: null });
    const users = await call(admin, 'GET', '/admin/users?limit=200');
    expect(users.body.data.some((u: any) => u.email === org.email)).toBe(true);
    expect(JSON.stringify([orgs.body, users.body, (await call(admin, 'GET', '/admin/overview')).body])).not.toContain('RECIPE-SECRET-1');

    // Not a member, so every inventory route answers 404 even for the super admin.
    for (const path of ['/products', '/dashboard', '/stock/movements', '/members', '/audit', '/locations']) {
      expect((await call(admin, 'GET', `${org.base}${path}`)).status, path).toBe(404);
    }
  });

  it('overview reports platform counts and the sign-in mode', async () => {
    await newOrg();
    const o = (await call(await loginAdmin(), 'GET', '/admin/overview')).body;
    expect(o.users).toBeGreaterThan(0);
    expect(o.organizations).toBeGreaterThan(0);
    expect(o.activeSessions).toBeGreaterThan(0);
    expect(o.signin).toBe('open'); // the test deployment is open; the default is owner-only
  });

  it('pages through organizations with cursors', async () => {
    for (let i = 0; i < 5; i++) await newOrg(`Paged ${i}`);
    const admin = await loginAdmin();
    const seen = new Set<string>();
    let cursor: string | null = null;
    let pages = 0;
    do {
      const r: any = await call(admin, 'GET', `/admin/orgs?limit=2${cursor ? `&cursor=${cursor}` : ''}`);
      r.body.data.forEach((o: any) => { expect(seen.has(o.id)).toBe(false); seen.add(o.id); });
      cursor = r.body.nextCursor;
      pages++;
    } while (cursor && pages < 50);
    expect(seen.size).toBeGreaterThanOrEqual(5);
  });
});

describe('disabling and suspending', () => {
  it('disabling a user signs them out at once and blocks signing in again until re-enabled', async () => {
    const email = `${uid()}@example.com`;
    const cookie = await login(email);
    const userId = (await call(cookie, 'GET', '/me')).body.user.id;
    const admin = await loginAdmin();

    expect((await call(admin, 'POST', `/admin/users/${userId}/disable`, {})).status).toBe(200);
    expect((await call(cookie, 'GET', '/me')).status).toBe(401);
    const again = await call(null, 'POST', '/auth/dev/login', { email });
    expect(again.status).toBe(403);
    expect(again.body.type).toContain('account-disabled');
    expect((await call(admin, 'POST', `/admin/users/${userId}/disable`, {})).status).toBe(404); // already disabled

    expect((await call(admin, 'POST', `/admin/users/${userId}/enable`, {})).status).toBe(200);
    expect((await call(await login(email), 'GET', '/me')).status).toBe(200);
  });

  it('refuses to disable the super admin themselves', async () => {
    const admin = await loginAdmin();
    const me = (await call(admin, 'GET', '/me')).body.user.id;
    const r = await call(admin, 'POST', `/admin/users/${me}/disable`, {});
    expect(r.status).toBe(409);
    expect(r.body.type).toContain('cannot-disable-self');
  });

  it('suspending an organization cuts off its members, hides it, and restore brings it back', async () => {
    const org = await newOrg('Suspend Me');
    const admin = await loginAdmin();
    expect((await call(org.cookie, 'GET', `${org.base}/products`)).status).toBe(200);

    expect((await call(admin, 'POST', `/admin/orgs/${org.orgId}/suspend`, {})).status).toBe(200);
    expect((await call(org.cookie, 'GET', `${org.base}/products`)).status).toBe(404);
    expect((await call(org.cookie, 'GET', '/me')).body.organizations.some((o: any) => o.id === org.orgId)).toBe(false);
    const row = (await call(admin, 'GET', '/admin/orgs?limit=200')).body.data.find((o: any) => o.id === org.orgId);
    expect(row.suspendedAt).not.toBeNull();
    expect((await call(admin, 'POST', `/admin/orgs/${org.orgId}/suspend`, {})).status).toBe(404); // already suspended

    expect((await call(admin, 'POST', `/admin/orgs/${org.orgId}/restore`, {})).status).toBe(200);
    expect((await call(org.cookie, 'GET', `${org.base}/products`)).status).toBe(200);
  });

  it('records every platform action with the actor and request id', async () => {
    const org = await newOrg();
    const admin = await loginAdmin();
    const adminId = (await call(admin, 'GET', '/me')).body.user.id;
    await call(admin, 'POST', `/admin/orgs/${org.orgId}/suspend`, {});
    await call(admin, 'POST', `/admin/orgs/${org.orgId}/restore`, {});
    const log = (await call(admin, 'GET', '/admin/audit?limit=10')).body.data.filter((a: any) => a.target === org.orgId);
    expect(log.map((a: any) => a.action).sort()).toEqual(['org.restore', 'org.suspend']);
    expect(log[0].actor).toBe(adminId);
    expect(log[0].requestId).toMatch(/^req_/);
  });

  it('requires the Origin check on admin writes like every other write', async () => {
    const admin = await loginAdmin();
    const r = await call(admin, 'POST', '/admin/orgs/org_x/suspend', {}, { origin: 'https://evil.example' });
    expect(r.status).toBe(403);
  });
});

describe('sign-in policy', () => {
  it('is closed by default and only the super admin passes while closed', () => {
    expect(signinClosed({})).toBe(true);
    expect(signinClosed({ SIGNIN_MODE: 'admin-only' })).toBe(true);
    expect(signinClosed({ SIGNIN_MODE: 'anything-else' })).toBe(true); // a typo must fail closed
    expect(signinClosed({ SIGNIN_MODE: 'open' })).toBe(false);
    expect(mayUse({}, { isSuperAdmin: false })).toBe(false);
    expect(mayUse({}, { isSuperAdmin: true })).toBe(true);
    expect(mayUse({ SIGNIN_MODE: 'open' }, { isSuperAdmin: false })).toBe(true);
  });

  it('the health endpoint reports the mode so the login page can say so', async () => {
    expect((await call(null, 'GET', '/health')).body).toEqual({ ok: true, signin: 'open' });
  });

  it('the production config does not enable dev login or open sign-in', async () => {
    const raw = (await import('../wrangler.jsonc?raw')).default;
    const config = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, '')) as { vars: Record<string, string> };
    const keys = Object.keys(config.vars);
    expect(keys).not.toContain('DEV_AUTH');
    expect(keys).not.toContain('INSECURE_DEV_COOKIES');
    expect(keys).not.toContain('SIGNIN_MODE'); // unset, so the safe default (owner-only) applies
    expect(config.vars.SUPER_ADMIN_GITHUB_ID).toMatch(/^\d+$/); // a numeric id, never an email or login
  });
});
