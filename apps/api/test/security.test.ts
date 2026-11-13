import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { ROUTES } from '../src/index';
import { ORIGIN, addMember, call, defaultLocation, ip, login, newOrg, product, uid } from './helpers';

describe('route declarations', () => {
  it('every organization route declares a real permission', () => {
    const orgRoutes = ROUTES.filter((r) => r.path.startsWith('/orgs/:orgId'));
    expect(orgRoutes.length).toBeGreaterThan(10);
    for (const r of orgRoutes) expect(['public', 'user'], `${r.method} ${r.path}`).not.toContain(r.access);
  });

  it('only health, sign-in and dev-login are public', () => {
    const open = ROUTES.filter((r) => r.access === 'public').map((r) => `${r.method} ${r.path}`).sort();
    expect(open).toEqual(['GET /auth/oauth/github', 'GET /auth/oauth/github/callback', 'GET /health', 'POST /auth/dev/login']);
  });
});

describe('authentication and request hygiene', () => {
  it('rejects requests without a session', async () => {
    const r = await call(null, 'GET', '/me');
    expect(r.status).toBe(401);
    expect(r.headers.get('content-type')).toContain('application/problem+json');
    expect(r.body.instance).toMatch(/^req_/);
  });

  it('rejects state-changing requests with a foreign or missing Origin', async () => {
    const org = await newOrg();
    const evil = await SELF.fetch(`${ORIGIN}/api/v1/orgs`, {
      method: 'POST',
      headers: { cookie: org.cookie, origin: 'https://evil.example', 'content-type': 'application/json', 'cf-connecting-ip': ip() },
      body: JSON.stringify({ name: 'x' }),
    });
    expect(evil.status).toBe(403);
    const none = await SELF.fetch(`${ORIGIN}/api/v1/orgs`, { method: 'POST', headers: { cookie: org.cookie, 'content-type': 'application/json', 'cf-connecting-ip': ip() }, body: JSON.stringify({ name: 'x' }) });
    expect(none.status).toBe(403);
  });

  it('sets security headers and never caches API responses', async () => {
    const r = await call(null, 'GET', '/health');
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.headers.get('strict-transport-security')).toContain('max-age=');
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(r.headers.get('x-request-id')).toMatch(/^req_/);
  });

  it('stores only a hash of the session token', async () => {
    const { env } = await import('cloudflare:test');
    const cookie = await login();
    const token = cookie.split('=')[1];
    const raw = await env.DB.prepare(`SELECT COUNT(*) AS n FROM sessions WHERE token_hash = ?`).bind(token).first<{ n: number }>();
    expect(raw!.n).toBe(0);
  });

  it('logout invalidates the session', async () => {
    const cookie = await login();
    expect((await call(cookie, 'GET', '/me')).status).toBe(200);
    expect((await call(cookie, 'POST', '/auth/logout', {})).status).toBe(200);
    expect((await call(cookie, 'GET', '/me')).status).toBe(401);
  });

  it('rejects oversized bodies and invalid JSON', async () => {
    const org = await newOrg();
    const big = await SELF.fetch(`${ORIGIN}/api/v1${org.base}/products`, {
      method: 'POST',
      headers: { cookie: org.cookie, origin: ORIGIN, 'content-type': 'application/json', 'idempotency-key': uid(), 'cf-connecting-ip': ip() },
      body: JSON.stringify({ sku: 'x', name: 'y'.repeat(70_000), priceMinor: 1 }),
    });
    expect(big.status).toBe(413);
    const bad = await SELF.fetch(`${ORIGIN}/api/v1${org.base}/products`, {
      method: 'POST',
      headers: { cookie: org.cookie, origin: ORIGIN, 'content-type': 'application/json', 'idempotency-key': uid(), 'cf-connecting-ip': ip() },
      body: '{oops',
    });
    expect(bad.status).toBe(400);
  });
});

describe('rate limiting', () => {
  it('returns 429 with Retry-After when one client floods the API', async () => {
    const flood = ip();
    const results = await Promise.all(Array.from({ length: 160 }, () => call(null, 'GET', '/health', undefined, { 'cf-connecting-ip': flood })));
    const limited = results.filter((r) => r.status === 429);
    expect(limited.length).toBeGreaterThan(0);
    expect(limited[0].headers.get('retry-after')).toBe('10');
    expect(limited[0].headers.get('content-type')).toContain('application/problem+json');
    // A different client is unaffected.
    expect((await call(null, 'GET', '/health')).status).toBe(200);
  });
});

describe('tenant isolation', () => {
  it('another organization sees 404 on every endpoint and never the data', async () => {
    const a = await newOrg('Org A');
    const b = await newOrg('Org B');
    const p = await product(a);
    const loc = await defaultLocation(a);

    const attempts: [string, string, unknown?][] = [
      ['GET', `${a.base}`],
      ['GET', `${a.base}/products`],
      ['GET', `${a.base}/products/${p.id}`],
      ['POST', `${a.base}/products`, { sku: 'X', name: 'X', priceMinor: 1 }],
      ['PATCH', `${a.base}/products/${p.id}`, { name: 'hacked' }],
      ['DELETE', `${a.base}/products/${p.id}`],
      ['GET', `${a.base}/dashboard`],
      ['GET', `${a.base}/locations`],
      ['POST', `${a.base}/stock/movements`, { productId: p.id, locationId: loc, delta: 1, reason: 'receive' }],
      ['GET', `${a.base}/stock/movements`],
      ['GET', `${a.base}/members`],
      ['GET', `${a.base}/audit`],
      ['POST', `${a.base}/invitations`, { email: 'x@example.com', role: 'viewer' }],
      ['DELETE', `${a.base}`],
    ];
    for (const [method, path, body] of attempts) {
      const r = await call(b.cookie, method, path, body, { 'if-match': '"1"' });
      expect(r.status, `${method} ${path}`).toBe(404);
      expect(JSON.stringify(r.body)).not.toContain(p.sku);
    }
    // And org A's data is untouched.
    const still = await call(a.cookie, 'GET', `${a.base}/products/${p.id}`);
    expect(still.status).toBe(200);
    expect(still.body.product.name).toBe('Widget');
  });

  it('keeps the two organizations in separate databases', async () => {
    const a = await newOrg();
    const b = await newOrg();
    await product(a, { sku: 'SAME-SKU' });
    // Same SKU is fine in a different org because the stores are separate.
    const r = await call(b.cookie, 'POST', `${b.base}/products`, { sku: 'SAME-SKU', name: 'Other', priceMinor: 5 });
    expect(r.status).toBe(201);
    expect((await call(b.cookie, 'GET', `${b.base}/products`)).body.data).toHaveLength(1);
  });
});

describe('roles and permissions', () => {
  it('viewer can read but not write; editor can write but not administer', async () => {
    const owner = await newOrg();
    const viewer = await addMember(owner, 'viewer');
    const editor = await addMember(owner, 'editor');
    const p = await product(owner);

    expect((await call(viewer.cookie, 'GET', `${owner.base}/products`)).status).toBe(200);
    expect((await call(viewer.cookie, 'POST', `${owner.base}/products`, { sku: 'V', name: 'V', priceMinor: 1 })).status).toBe(403);
    expect((await call(viewer.cookie, 'DELETE', `${owner.base}/products/${p.id}`, undefined, { 'if-match': '"1"' })).status).toBe(403);

    expect((await call(editor.cookie, 'POST', `${owner.base}/products`, { sku: 'E', name: 'E', priceMinor: 1 })).status).toBe(201);
    expect((await call(editor.cookie, 'POST', `${owner.base}/locations`, { name: 'Shop', code: 'shop' })).status).toBe(403);
    expect((await call(editor.cookie, 'GET', `${owner.base}/audit`)).status).toBe(403);
    expect((await call(editor.cookie, 'POST', `${owner.base}/invitations`, { email: 'z@example.com', role: 'viewer' })).status).toBe(403);
    expect((await call(editor.cookie, 'DELETE', `${owner.base}`)).status).toBe(403);
  });

  it('admin can manage members and locations but cannot grant or remove owners', async () => {
    const owner = await newOrg();
    const admin = await addMember(owner, 'admin');
    const editor = await addMember(owner, 'editor');
    expect((await call(admin.cookie, 'POST', `${owner.base}/locations`, { name: 'Shop', code: 'shop' })).status).toBe(201);
    expect((await call(admin.cookie, 'PATCH', `${owner.base}/members/${editor.userId}`, { role: 'viewer' })).status).toBe(200);
    expect((await call(admin.cookie, 'PATCH', `${owner.base}/members/${editor.userId}`, { role: 'owner' })).status).toBe(403);
    const me = await call(owner.cookie, 'GET', '/me');
    expect((await call(admin.cookie, 'DELETE', `${owner.base}/members/${me.body.user.id}`)).status).toBe(403);
    expect((await call(admin.cookie, 'DELETE', `${owner.base}`)).status).toBe(403);
  });

  it('the last owner cannot be demoted or removed', async () => {
    const owner = await newOrg();
    const me = (await call(owner.cookie, 'GET', '/me')).body.user.id;
    const demote = await call(owner.cookie, 'PATCH', `${owner.base}/members/${me}`, { role: 'admin' });
    expect(demote.status).toBe(409);
    expect(demote.body.type).toContain('last-owner');
    expect((await call(owner.cookie, 'DELETE', `${owner.base}/members/${me}`)).status).toBe(409);
  });

  it('a removed member loses access on the next request', async () => {
    const owner = await newOrg();
    const editor = await addMember(owner, 'editor');
    expect((await call(editor.cookie, 'GET', `${owner.base}/products`)).status).toBe(200);
    await call(owner.cookie, 'DELETE', `${owner.base}/members/${editor.userId}`);
    expect((await call(editor.cookie, 'GET', `${owner.base}/products`)).status).toBe(404);
  });
});

describe('invitations', () => {
  it('cannot be accepted by a different email, reused, or guessed', async () => {
    const owner = await newOrg();
    const invited = `${uid()}@example.com`;
    const inv = await call(owner.cookie, 'POST', `${owner.base}/invitations`, { email: invited, role: 'viewer' });
    const stranger = await login();
    expect((await call(stranger, 'POST', `/invitations/${inv.body.token}/accept`, {})).status).toBe(403);
    const rightCookie = await login(invited);
    expect((await call(rightCookie, 'POST', `/invitations/${inv.body.token}/accept`, {})).status).toBe(200);
    expect((await call(rightCookie, 'POST', `/invitations/${inv.body.token}/accept`, {})).status).toBe(404);
    expect((await call(rightCookie, 'POST', `/invitations/not-a-real-token/accept`, {})).status).toBe(404);
  });
});
