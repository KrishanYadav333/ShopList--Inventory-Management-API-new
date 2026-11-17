import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pruneAuthEvents } from '../src/authevents';
import { addMember, call, loginAdmin, newOrg, ORIGIN, uid } from './helpers';

const enc = new TextEncoder();
const b64 = (b: ArrayBuffer | Uint8Array | string) => {
  const bytes = typeof b === 'string' ? enc.encode(b) : new Uint8Array(b);
  let s = '';
  for (const x of bytes) s += String.fromCharCode(x);
  return btoa(s).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
};
const pemToDer = (pem: string) => Uint8Array.from(atob(pem.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, '')), (c) => c.charCodeAt(0));

const testPrivatePem = (env as unknown as Record<string, string>).TEST_CLERK_PRIVATE_KEY;

async function signingKey(pem = testPrivatePem) {
  return crypto.subtle.importKey('pkcs8', pemToDer(pem), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
}

/** Mints a token like Clerk would, with overridable claims and signing key. */
async function mint(over: Record<string, unknown> = {}, opts: { key?: CryptoKey; header?: Record<string, unknown> } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64(JSON.stringify({ alg: 'RS256', typ: 'JWT', ...opts.header }));
  const payload = b64(JSON.stringify({ sub: 'user_test1', iss: 'https://clerk.test', azp: ORIGIN, iat: now, nbf: now - 5, exp: now + 60, ...over }));
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', opts.key ?? (await signingKey()), enc.encode(`${header}.${payload}`));
  return `${header}.${payload}.${b64(sig)}`;
}

let profile: Record<string, unknown>;
let clerkCalls: string[];
const realFetch = globalThis.fetch;

beforeEach(() => {
  clerkCalls = [];
  profile = {
    banned: false, locked: false, first_name: 'Dana', last_name: 'Shopkeeper', image_url: 'https://img.example/a.png',
    primary_email_address_id: 'idn_1', email_addresses: [{ id: 'idn_1', email_address: `${uid()}@example.com`, verification: { status: 'verified' } }],
  };
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
    if (url.startsWith('https://api.clerk.com/')) {
      clerkCalls.push(url);
      return Response.json(profile);
    }
    return realFetch(input as RequestInfo, init);
  });
});
afterEach(() => vi.restoreAllMocks());

const exchange = (token: unknown, extra: Record<string, string> = {}) => call(null, 'POST', '/auth/clerk/session', { token }, extra);
const events = async (where = '1=1', ...b: unknown[]) => (await env.DB.prepare(`SELECT * FROM auth_events WHERE ${where} ORDER BY at`).bind(...b).all<any>()).results;
const sessionOf = (r: { headers: Headers }) => (r.headers.get('set-cookie') ?? '').match(/__Host-sl_session=[^;]+/)![0];

describe('sign-in history (F22)', () => {
  it('records a successful sign-in with door, browser and country, and no address or token', async () => {
    const r = await exchange(await mint({ sub: `user_${uid()}` }), { 'user-agent': 'Mozilla/5.0 Chrome/120 Safari/537', 'cf-ipcountry': 'NP' });
    expect(r.status).toBe(200);
    const [e] = await events('user_id = ?', r.body.user.id);
    expect(e).toMatchObject({ kind: 'signin_ok', door: 'clerk', browser: 'Chrome', country: 'NP', reason: null, email_hash: null });
    expect(JSON.stringify(e)).not.toContain('@');
  });

  it('records a refused sign-in with a reason and only a hash of the email', async () => {
    const sub = `user_${uid()}`;
    const email = `${uid()}-gone@example.com`;
    (profile.email_addresses as { email_address: string }[])[0].email_address = email;
    const first = await exchange(await mint({ sub }));
    const admin = await loginAdmin();
    expect((await call(admin, 'POST', `/admin/users/${first.body.user.id}/disable`, {})).status).toBe(200);
    const again = await exchange(await mint({ sub }));
    expect(again.status).toBe(403);
    const refused = (await events("kind = 'signin_refused' AND reason = 'account_disabled'")).filter((e) => e.email_hash);
    expect(refused.length).toBeGreaterThan(0);
    const all = JSON.stringify(await events());
    expect(all).not.toContain(email);
    expect((await events("kind = 'user_disabled' AND user_id = ?", first.body.user.id))).toHaveLength(1);
  });

  it('records a bad token as refused with no email at all', async () => {
    const before = (await events("reason = 'invalid_token'")).length;
    expect((await exchange(await mint({ iss: 'https://evil.example' }))).status).toBe(401);
    const after = await events("reason = 'invalid_token'");
    expect(after.length).toBe(before + 1);
    expect(after.at(-1)).toMatchObject({ kind: 'signin_refused', door: 'clerk', user_id: null, email_hash: null });
  });

  it('sign-out and revoking sessions are recorded, and a user sees only their own last events', async () => {
    const a = await exchange(await mint({ sub: `user_${uid()}` }));
    const cookie = sessionOf(a);
    const mine = await call(cookie, 'GET', '/auth/events');
    expect(mine.status).toBe(200);
    expect(mine.body.data[0]).toMatchObject({ kind: 'signin_ok', door: 'clerk' });
    expect(mine.body.data[0]).not.toHaveProperty('user_id');
    await call(cookie, 'POST', '/auth/sessions/revoke-others', {});
    await call(cookie, 'POST', '/auth/logout', {});
    const kinds = (await events('user_id = ?', a.body.user.id)).map((e) => e.kind);
    expect(kinds).toEqual(['signin_ok', 'signout']);
    (profile.email_addresses as { email_address: string }[])[0].email_address = `${uid()}-other@example.com`;
    const other = await exchange(await mint({ sub: `user_${uid()}` }));
    const theirs = await call(sessionOf(other), 'GET', '/auth/events');
    expect(theirs.body.data).toHaveLength(1);
  });

  it('"this was not me" signs out everywhere, tells the admin, and is visible to the owner', async () => {
    const org = await newOrg('Not Me Co');
    const staff = await addMember(org, 'sales');
    const me = await call(staff.cookie, 'GET', '/me');
    const r = await call(staff.cookie, 'POST', '/auth/not-me', {});
    expect(r.status).toBe(200);
    expect((await call(staff.cookie, 'GET', '/me')).status).toBe(401);
    const note = await call(org.cookie, 'GET', '/me/notifications');
    expect(JSON.stringify(note.body)).toContain('not theirs');
    const owner = await loginAdmin();
    const sec = await call(owner, 'GET', '/admin/security');
    expect(sec.status).toBe(200);
    expect(sec.body.last24h.notMe).toBeGreaterThan(0);
    expect(JSON.stringify(sec.body)).toContain(me.body.user.email);
  });

  it('only the owner reads the security center', async () => {
    const org = await newOrg('Sec Co');
    expect((await call(org.cookie, 'GET', '/admin/security')).status).toBe(404); // the owner's pages do not exist for anyone else
    expect((await call(null, 'GET', '/admin/security')).status).toBe(401);
  });

  it('a flood of rate-limited requests writes one row per client per minute', async () => {
    const { recordRateLimited } = await import('../src/authevents');
    const req = new Request('https://x.test/', { headers: { 'cf-connecting-ip': '203.0.113.77' } });
    const before = (await events("kind = 'rate_limited'")).length;
    for (let i = 0; i < 30; i++) await recordRateLimited(env as any, req);
    expect((await events("kind = 'rate_limited'")).length).toBe(before + 1);
    expect(JSON.stringify(await events("kind = 'rate_limited'"))).not.toContain('203.0.113.77');
  });

  it('shows repeated refusals for one hashed address as notable', async () => {
    const { hashOf } = await import('../src/authevents');
    const h = await hashOf(env as any, 'attacker@example.com');
    for (let i = 0; i < 5; i++) await env.DB.prepare(`INSERT INTO auth_events(id, at, kind, email_hash, door, reason) VALUES (?, ?, 'signin_refused', ?, 'clerk', 'not_invited')`).bind(`t${uid()}${i}`, new Date().toISOString(), h).run();
    const sec = await call(await loginAdmin(), 'GET', '/admin/security');
    expect(sec.body.notable.repeatedRefusals.find((x: any) => x.emailHash === h)?.refusals).toBeGreaterThanOrEqual(5);
    expect(sec.body.last24h.refused.not_invited).toBeGreaterThanOrEqual(5);
  });

  it('prunes events older than 90 days and keeps newer ones', async () => {
    const old = new Date(Date.now() - 91 * 86400_000).toISOString();
    const fresh = new Date(Date.now() - 89 * 86400_000).toISOString();
    await env.DB.prepare(`INSERT INTO auth_events(id, at, kind) VALUES ('old1', ?, 'signout'), ('new1', ?, 'signout')`).bind(old, fresh).run();
    expect(await pruneAuthEvents(env)).toBeGreaterThanOrEqual(1);
    expect(await events("id IN ('old1','new1')")).toHaveLength(1);
  });
});
