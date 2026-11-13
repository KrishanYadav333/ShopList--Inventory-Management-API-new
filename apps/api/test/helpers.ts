import { env, SELF } from 'cloudflare:test';
import type { InventoryDO } from '../src/inventory-do';

export const ORIGIN = 'http://localhost:8787';

export interface Res<T = any> {
  status: number;
  body: T;
  headers: Headers;
}

let counter = 0;
/** A distinct client IP per request, so the rate limiter does not interfere unless a test wants it to. */
export const ip = () => `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
export const uid = () => `${Date.now().toString(36)}${(counter++).toString(36)}`;

export async function call<T = any>(
  cookie: string | null,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<Res<T>> {
  const h: Record<string, string> = { origin: ORIGIN, 'cf-connecting-ip': ip(), ...headers };
  if (cookie) h.cookie = cookie;
  if (body !== undefined) h['content-type'] = 'application/json';
  if (method === 'POST' && !('idempotency-key' in headers) && /\/(products|stock\/(movements|transfers|counts))$/.test(path)) {
    h['idempotency-key'] = crypto.randomUUID();
  }
  const res = await SELF.fetch(`${ORIGIN}/api/v1${path}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let parsed: any = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    /* keep text */
  }
  return { status: res.status, body: parsed, headers: res.headers };
}

/** Signs in through the dev-login route and returns the cookie header value. */
export async function login(email = `${uid()}@example.com`, superAdmin = false): Promise<string> {
  const res = await SELF.fetch(`${ORIGIN}/api/v1/auth/dev/login`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json', 'cf-connecting-ip': ip() },
    body: JSON.stringify(superAdmin ? { email, superAdmin: true } : { email }),
  });
  if (res.status !== 200) throw new Error(`login failed: ${res.status} ${await res.text()}`);
  const set = res.headers.get('set-cookie') ?? '';
  const match = set.match(/__Host-sl_session=([^;]+)/);
  if (!match) throw new Error(`no session cookie in: ${set}`);
  return `__Host-sl_session=${match[1]}`;
}

/** A user who owns a fresh organization. */
export async function newOrg(name = 'Test Org') {
  const email = `${uid()}@example.com`;
  const cookie = await login(email);
  const r = await call(cookie, 'POST', '/orgs', { name });
  if (r.status !== 201) throw new Error(`org create failed: ${JSON.stringify(r.body)}`);
  return { cookie, email, orgId: r.body.organization.id as string, base: `/orgs/${r.body.organization.id}` };
}

/** Invites `email` with `role` and has them accept; returns their cookie. */
export async function addMember(owner: { cookie: string; base: string }, role: 'admin' | 'editor' | 'viewer') {
  const email = `${uid()}@example.com`;
  const cookie = await login(email);
  const inv = await call(owner.cookie, 'POST', `${owner.base}/invitations`, { email, role });
  if (inv.status !== 201) throw new Error(`invite failed: ${JSON.stringify(inv.body)}`);
  const acc = await call(cookie, 'POST', `/invitations/${inv.body.token}/accept`, {});
  if (acc.status !== 200) throw new Error(`accept failed: ${JSON.stringify(acc.body)}`);
  const me = await call(cookie, 'GET', '/me');
  return { cookie, email, userId: me.body.user.id as string };
}

export async function product(org: { cookie: string; base: string }, over: Record<string, unknown> = {}) {
  const r = await call(org.cookie, 'POST', `${org.base}/products`, {
    sku: `SKU-${uid()}`,
    name: 'Widget',
    priceMinor: 1000,
    ...over,
  });
  if (r.status !== 201) throw new Error(`product create failed: ${JSON.stringify(r.body)}`);
  return r.body.product as { id: string; sku: string; version: number; onHand: number };
}

export async function defaultLocation(org: { cookie: string; base: string }): Promise<string> {
  const r = await call(org.cookie, 'GET', `${org.base}/locations`);
  return r.body.data.find((l: any) => l.isDefault).id;
}

export function stub(orgId: string) {
  return env.INVENTORY.get(env.INVENTORY.idFromName(orgId)) as DurableObjectStub<InventoryDO>;
}

/** Signs in as the (single) super admin. Only one account holds the role at a time. */
export const loginAdmin = (email = `${uid()}-admin@example.com`) => login(email, true);
