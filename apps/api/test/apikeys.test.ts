import { env } from 'cloudflare:test';
import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { addMember, call, defaultLocation, ip, newOrg, ORIGIN, product, uid } from './helpers';

type Org = { cookie: string; base: string; orgId: string };

async function makeKey(org: Org, scopes: string[] = ['inventory:read', 'inventory:write'], extra: Record<string, unknown> = {}) {
  const r = await call(org.cookie, 'POST', `${org.base}/api-keys`, { name: 'Web shop', scopes, ...extra });
  expect(r.status).toBe(201);
  return r.body as { id: string; key: string; prefix: string };
}

/** A request the way an integration sends it: a bearer key, no cookies, no Origin. */
async function viaKey(key: string, method: string, path: string, body?: unknown, extra: Record<string, string> = {}) {
  const res = await SELF.fetch(`${ORIGIN}/api/v1${path}`, {
    method,
    headers: { authorization: `Bearer ${key}`, 'cf-connecting-ip': ip(), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...extra },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
}
const idem = () => ({ 'idempotency-key': crypto.randomUUID() });

describe('creating and managing keys', () => {
  it('shows the full key once, stores only a hash, and never lists the secret', async () => {
    const org = await newOrg();
    const k = await makeKey(org);
    expect(k.key).toMatch(/^sl_live_[A-Za-z0-9_-]{30,}$/);
    expect(k.prefix).toBe(k.key.slice(0, 12));
    const stored = await env.DB.prepare(`SELECT secret_hash, prefix FROM api_keys WHERE id = ?`).bind(k.id).first<{ secret_hash: string; prefix: string }>();
    expect(stored!.secret_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(stored)).not.toContain(k.key);
    const list = await call(org.cookie, 'GET', `${org.base}/api-keys`);
    expect(JSON.stringify(list.body)).not.toContain(k.key);
    expect(JSON.stringify(list.body)).not.toContain('secret');
    expect(list.body.data[0]).toMatchObject({ id: k.id, name: 'Web shop', prefix: k.prefix, scopes: ['inventory:read', 'inventory:write'], revokedAt: null });
  });

  it('only admins and owners can manage keys, and keys cannot manage keys', async () => {
    const org = await newOrg();
    const editor = await addMember(org, 'editor');
    const admin = await addMember(org, 'admin');
    expect((await call(editor.cookie, 'POST', `${org.base}/api-keys`, { name: 'x', scopes: ['inventory:read'] })).status).toBe(403);
    expect((await call(editor.cookie, 'GET', `${org.base}/api-keys`)).status).toBe(403);
    expect((await call(admin.cookie, 'POST', `${org.base}/api-keys`, { name: 'x', scopes: ['inventory:read'] })).status).toBe(201);
    const k = await makeKey(org);
    expect((await viaKey(k.key, 'GET', `${org.base}/api-keys`)).status).toBe(403);
    expect((await viaKey(k.key, 'POST', `${org.base}/api-keys`, { name: 'evil', scopes: ['inventory:write'] })).status).toBe(403);
  });

  it('validates input and caps active keys at 20', async () => {
    const org = await newOrg();
    expect((await call(org.cookie, 'POST', `${org.base}/api-keys`, { name: '', scopes: ['inventory:read'] })).status).toBe(400);
    expect((await call(org.cookie, 'POST', `${org.base}/api-keys`, { name: 'x', scopes: [] })).status).toBe(400);
    expect((await call(org.cookie, 'POST', `${org.base}/api-keys`, { name: 'x', scopes: ['org:manage'] })).status).toBe(400);
    expect((await call(org.cookie, 'POST', `${org.base}/api-keys`, { name: 'x', scopes: ['inventory:read'], expiresInDays: 9999 })).status).toBe(400);
    for (let i = 0; i < 20; i++) await makeKey(org, ['inventory:read']);
    expect((await call(org.cookie, 'POST', `${org.base}/api-keys`, { name: 'one too many', scopes: ['inventory:read'] })).status).toBe(409);
  });
});

describe('using a key', () => {
  it('reads and writes inventory with the right scope, and records the key as the actor', async () => {
    const org = await newOrg();
    const loc = await defaultLocation(org);
    const k = await makeKey(org);
    const created = await viaKey(k.key, 'POST', `${org.base}/products`, { sku: 'API-1', name: 'From the API', priceMinor: 500 }, idem());
    expect(created.status).toBe(201);
    const pid = created.body.product.id;
    expect((await viaKey(k.key, 'POST', `${org.base}/stock/movements`, { productId: pid, locationId: loc, delta: 8, reason: 'receive' }, idem())).status).toBe(201);
    expect((await viaKey(k.key, 'GET', `${org.base}/products?q=api`)).body.data).toHaveLength(1);
    const o = await viaKey(k.key, 'POST', `${org.base}/orders`, { customerName: 'Shop customer', channel: 'shopify', lines: [{ productId: pid, quantity: 2 }] }, idem());
    expect(o.status).toBe(201);
    expect((await viaKey(k.key, 'GET', `${org.base}/dashboard`)).status).toBe(200);
    const moves = (await call(org.cookie, 'GET', `${org.base}/stock/movements?productId=${pid}`)).body.data;
    expect(moves[0].actor).toBe(`key_${k.id}`);
    const audit = (await call(org.cookie, 'GET', `${org.base}/audit`)).body.data;
    expect(audit.some((a: any) => a.actor === `key_${k.id}` && a.action === 'product.create')).toBe(true);
  });

  it('a read-only key can read but every write is refused', async () => {
    const org = await newOrg();
    const loc = await defaultLocation(org);
    const p = await product(org, { initialQuantity: 3 });
    const k = await makeKey(org, ['inventory:read']);
    expect((await viaKey(k.key, 'GET', `${org.base}/products`)).status).toBe(200);
    expect((await viaKey(k.key, 'GET', `${org.base}/orders`)).status).toBe(200);
    expect((await viaKey(k.key, 'POST', `${org.base}/products`, { sku: 'X', name: 'X', priceMinor: 1 }, idem())).status).toBe(403);
    expect((await viaKey(k.key, 'POST', `${org.base}/stock/movements`, { productId: p.id, locationId: loc, delta: -1, reason: 'sale' }, idem())).status).toBe(403);
    expect((await viaKey(k.key, 'DELETE', `${org.base}/products/${p.id}`, undefined, { 'if-match': '"1"' })).status).toBe(403);
  });

  it('is bound to one organization and to inventory routes only', async () => {
    const a = await newOrg();
    const b = await newOrg();
    await product(a);
    const k = await makeKey(a);
    expect((await viaKey(k.key, 'GET', `${b.base}/products`)).status).toBe(404);
    expect((await viaKey(k.key, 'POST', `${b.base}/products`, { sku: 'X', name: 'X', priceMinor: 1 }, idem())).status).toBe(404);
    for (const path of [`${a.base}/members`, `${a.base}/audit`, `${a.base}`]) {
      expect((await viaKey(k.key, 'GET', path)).status, path).toBe(403);
    }
    expect((await viaKey(k.key, 'POST', `${a.base}/invitations`, { email: 'x@example.com', role: 'admin' })).status).toBe(403);
    expect((await viaKey(k.key, 'DELETE', `${a.base}`)).status).toBe(403);
    // account-level routes accept sessions only
    for (const [method, path, body] of [['GET', '/me'], ['POST', '/orgs', { name: 'nope' }], ['GET', '/admin/overview'], ['POST', '/auth/logout', {}]] as const) {
      const r = await viaKey(k.key, method, path, body);
      expect(r.status, `${method} ${path}`).toBe(403);
      expect(r.body.type).toContain('key-not-allowed');
    }
  });

  it('rejects revoked, expired, malformed and unknown keys immediately', async () => {
    const org = await newOrg();
    const k = await makeKey(org);
    expect((await viaKey(k.key, 'GET', `${org.base}/products`)).status).toBe(200);

    expect((await call(org.cookie, 'DELETE', `${org.base}/api-keys/${k.id}`)).status).toBe(200);
    const revoked = await viaKey(k.key, 'GET', `${org.base}/products`);
    expect(revoked.status).toBe(401);
    expect(revoked.body.type).toContain('invalid-api-key');
    expect((await call(org.cookie, 'DELETE', `${org.base}/api-keys/${k.id}`)).status).toBe(404); // already revoked

    const e = await makeKey(org);
    await env.DB.prepare(`UPDATE api_keys SET expires_at = ? WHERE id = ?`).bind(new Date(Date.now() - 1000).toISOString(), e.id).run();
    expect((await viaKey(e.key, 'GET', `${org.base}/products`)).status).toBe(401);

    for (const bad of ['sl_live_nope', 'sl_live_', 'Bearer', 'x'.repeat(500), `sl_live_${'A'.repeat(40)}`, "sl_live_' OR 1=1--"]) {
      expect((await viaKey(bad, 'GET', `${org.base}/products`)).status, bad).toBe(401);
    }
  });

  it('keys stop working when the organization is suspended', async () => {
    const org = await newOrg();
    const k = await makeKey(org);
    const admin = (await call(null, 'POST', '/auth/dev/login', { email: `${uid()}-a@example.com`, superAdmin: true })).headers.get('set-cookie')!.match(/__Host-sl_session=[^;]+/)![0];
    expect((await call(admin, 'POST', `/admin/orgs/${org.orgId}/suspend`, {})).status).toBe(200);
    expect((await viaKey(k.key, 'GET', `${org.base}/products`)).status).toBe(404);
    expect((await call(admin, 'POST', `/admin/orgs/${org.orgId}/restore`, {})).status).toBe(200);
    expect((await viaKey(k.key, 'GET', `${org.base}/products`)).status).toBe(200);
  });

  it('updates last-used, and keeps the CSRF origin check for cookie requests', async () => {
    const org = await newOrg();
    const k = await makeKey(org);
    await viaKey(k.key, 'GET', `${org.base}/products`);
    const row = (await call(org.cookie, 'GET', `${org.base}/api-keys`)).body.data[0];
    expect(row.lastUsedAt).toBeTruthy();
    // A request carrying both a cookie and a key is a browser request: it still needs a same-origin Origin.
    const mixed = await SELF.fetch(`${ORIGIN}/api/v1${org.base}/products`, {
      method: 'POST',
      headers: { authorization: `Bearer ${k.key}`, cookie: org.cookie, 'content-type': 'application/json', 'idempotency-key': uid(), 'cf-connecting-ip': ip() },
      body: JSON.stringify({ sku: 'X', name: 'X', priceMinor: 1 }),
    });
    expect(mixed.status).toBe(403);
  });

  it('is idempotent and concurrency-safe like any other caller', async () => {
    const org = await newOrg();
    const loc = await defaultLocation(org);
    const p = await product(org, { initialQuantity: 10 });
    const k = await makeKey(org);
    const key = 'one-shot';
    const body = { productId: p.id, locationId: loc, delta: -3, reason: 'sale' };
    const [a, b] = await Promise.all([viaKey(k.key, 'POST', `${org.base}/stock/movements`, body, { 'idempotency-key': key }), viaKey(k.key, 'POST', `${org.base}/stock/movements`, body, { 'idempotency-key': key })]);
    expect(a.body.movement.id).toBe(b.body.movement.id);
    expect((await call(org.cookie, 'GET', `${org.base}/products/${p.id}`)).body.product.onHand).toBe(7);
  });
});
