import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { call, ip, ORIGIN, uid } from './helpers';

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

const exchange = (token: unknown) => call(null, 'POST', '/auth/clerk/session', { token });
const bad = (r: { status: number; body: any }) => { expect(r.status).toBe(401); expect(r.body.type).toContain('invalid-token'); };

describe('Clerk sign-in exchange', () => {
  it('turns a valid Clerk token into a ShopList session, as an ordinary user', async () => {
    const r = await call(null, 'POST', '/auth/clerk/session', { token: await mint() });
    expect(r.status).toBe(200);
    expect(r.body.user).toMatchObject({ name: 'Dana Shopkeeper', isSuperAdmin: false });
    const cookie = (r.headers.get('set-cookie') ?? '').match(/__Host-sl_session=[^;]+/)?.[0];
    expect(cookie).toBeTruthy();
    expect(clerkCalls).toEqual(['https://api.clerk.com/v1/users/user_test1']);
    const me = await call(cookie!, 'GET', '/me');
    expect(me.status).toBe(200);
    expect(me.body.user.isSuperAdmin).toBe(false);
    // The same Clerk user signing in again reuses the account.
    const again = await exchange(await mint());
    expect(again.body.user.id).toBe(r.body.user.id);
  });

  it('a Clerk identity can never attach to the owner\'s account, even with the owner\'s verified email', async () => {
    const adminEmail = `${uid()}-owner@example.com`;
    // The owner signs in through the admin door (dev stand-in for GitHub) and so has a GitHub-linked account.
    await call(null, 'POST', '/auth/dev/login', { email: adminEmail, superAdmin: true });
    (profile.email_addresses as any[])[0].email_address = adminEmail;
    const r = await exchange(await mint({ sub: 'user_lookalike' }));
    expect(r.status).toBe(409);
    expect(r.body.type).toContain('email-in-use');
    expect(r.headers.get('set-cookie')).toBeNull();
  });

  it('admin power requires a session from the admin door, not just the admin account', async () => {
    // Even if a customer-door session existed on the owner\'s user row, it carries no admin power.
    const email = `${uid()}-o2@example.com`;
    const admin = (await call(null, 'POST', '/auth/dev/login', { email, superAdmin: true })).headers.get('set-cookie')!.match(/__Host-sl_session=[^;]+/)![0];
    const userId = (await call(admin, 'GET', '/me')).body.user.id;
    expect((await call(admin, 'GET', '/admin/overview')).status).toBe(200);
    const { env: e } = await import('cloudflare:test');
    const token = 'forged-customer-door-session-' + uid();
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)))].map((b) => b.toString(16).padStart(2, '0')).join('');
    const now = new Date().toISOString();
    await e.DB.prepare(`INSERT INTO sessions(token_hash, user_id, created_at, expires_at, last_seen_at, provider) VALUES (?, ?, ?, ?, ?, 'clerk')`).bind(hash, userId, now, new Date(Date.now() + 3600_000).toISOString(), now).run();
    const viaClerk = `__Host-sl_session=${token}`;
    expect((await call(viaClerk, 'GET', '/me')).body.user.isSuperAdmin).toBe(false);
    expect((await call(viaClerk, 'GET', '/admin/overview')).status).toBe(404);
  });

  it('rejects expired, not-yet-valid, and wrong-issuer tokens', async () => {
    const now = Math.floor(Date.now() / 1000);
    bad(await exchange(await mint({ exp: now - 60 })));
    bad(await exchange(await mint({ nbf: now + 600 })));
    bad(await exchange(await mint({ iss: 'https://evil.clerk.accounts.dev' })));
    expect(clerkCalls).toEqual([]); // nothing reaches Clerk's API for a bad token
  });

  it('rejects a token minted for a different site (azp)', async () => {
    bad(await exchange(await mint({ azp: 'https://evil.example' })));
  });

  it('rejects forged signatures and signatures from another key', async () => {
    const other = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
    bad(await exchange(await mint({}, { key: (other as CryptoKeyPair).privateKey })));
    const good = await mint();
    const [h, p, s] = good.split('.');
    bad(await exchange(`${h}.${b64(JSON.stringify({ sub: 'user_admin', iss: 'https://clerk.test', exp: 9999999999 }))}.${s}`)); // payload swapped, old signature
    bad(await exchange(`${h}.${p}.${s.slice(0, -4)}AAAA`)); // corrupted signature
  });

  it('blocks algorithm confusion: alg none and HS256 are refused', async () => {
    const now = Math.floor(Date.now() / 1000);
    const claims = b64(JSON.stringify({ sub: 'user_test1', iss: 'https://clerk.test', exp: now + 60 }));
    bad(await exchange(`${b64(JSON.stringify({ alg: 'none' }))}.${claims}.`));
    bad(await exchange(`${b64(JSON.stringify({ alg: 'none' }))}.${claims}.AAAA`));
    // HS256 signed with the *public key* as the HMAC secret, the classic downgrade attack.
    const pub = (env as unknown as Record<string, string>).CLERK_JWT_KEY;
    const hmacKey = await crypto.subtle.importKey('raw', enc.encode(pub), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const head = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
    const sig = await crypto.subtle.sign('HMAC', hmacKey, enc.encode(`${head}.${claims}`));
    bad(await exchange(`${head}.${claims}.${b64(sig)}`));
    expect(clerkCalls).toEqual([]);
  });

  it('rejects malformed input without crashing', async () => {
    for (const t of ['x'.repeat(30), `${'a'.repeat(10)}.${'b'.repeat(10)}.${'c'.repeat(10)}`, 'a'.repeat(15) + '.b.c.d.' + 'e'.repeat(10), 'ü.ü.ü' + 'x'.repeat(20), '...'.repeat(10)]) bad(await exchange(t));
    expect((await exchange('short')).status).toBe(400); // schema: too short
    expect((await exchange('x'.repeat(5000))).status).toBe(400); // schema: too long
    expect((await exchange(12345)).status).toBe(400);
    expect((await call(null, 'POST', '/auth/clerk/session', {})).status).toBe(400);
    expect((await call(null, 'POST', '/auth/clerk/session', { token: await mint(), extra: 1 })).status).toBe(400); // strict schema
  });

  it('requires a verified primary email and refuses banned or locked accounts', async () => {
    (profile.email_addresses as any[])[0].verification = { status: 'unverified' };
    const unverified = await exchange(await mint());
    expect(unverified.status).toBe(403);
    expect(unverified.body.type).toContain('email-not-verified');

    (profile.email_addresses as any[])[0].verification = { status: 'verified' };
    profile.banned = true;
    expect((await exchange(await mint())).status).toBe(403);
    profile.banned = false;
    profile.locked = true;
    expect((await exchange(await mint())).status).toBe(403);
    profile.locked = false;
    profile.primary_email_address_id = 'idn_missing';
    expect((await exchange(await mint())).status).toBe(403);
  });

  it('a user disabled by the super admin cannot sign in through Clerk either', async () => {
    const r = await exchange(await mint({ sub: 'user_disable_me' }));
    expect(r.status).toBe(200);
    const admin = (await call(null, 'POST', '/auth/dev/login', { email: `${uid()}-a@example.com`, superAdmin: true })).headers.get('set-cookie')!.match(/__Host-sl_session=[^;]+/)![0];
    expect((await call(admin, 'POST', `/admin/users/${r.body.user.id}/disable`, {})).status).toBe(200);
    const again = await exchange(await mint({ sub: 'user_disable_me' }));
    expect(again.status).toBe(403);
    expect(again.body.type).toContain('account-disabled');
  });

  it('reports a clear 502 when Clerk itself is down, and creates no session', async () => {
    (globalThis.fetch as any).mockImplementation(async (input: any) => (String(input).startsWith('https://api.clerk.com/') ? new Response('boom', { status: 500 }) : realFetch(input)));
    const r = await exchange(await mint());
    expect(r.status).toBe(502);
    expect(r.headers.get('set-cookie')).toBeNull();
  });

  it('requires the Origin check like every other write', async () => {
    const r = await call(null, 'POST', '/auth/clerk/session', { token: await mint() }, { origin: 'https://evil.example', 'cf-connecting-ip': ip() });
    expect(r.status).toBe(403);
  });
});
