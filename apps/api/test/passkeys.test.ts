import { describe, expect, it } from 'vitest';
import { call, login, ORIGIN, uid } from './helpers';
import { authenticator, b64, cat, sha, enc } from './webauthn-helper';

async function enroll(cookie: string, auth: Awaited<ReturnType<typeof authenticator>>) {
  const opt = await call(cookie, 'POST', '/auth/passkeys/register/options', {});
  expect(opt.status).toBe(200);
  const att = await auth.register(opt.body.publicKey.challenge);
  return call(cookie, 'POST', '/auth/passkeys/register', { token: opt.body.token, ...att, name: 'Test key' });
}
async function signIn(auth: Awaited<ReturnType<typeof authenticator>>, over: Parameters<Awaited<ReturnType<typeof authenticator>>['assert']>[1] = {}) {
  const opt = await call(null, 'POST', '/auth/passkeys/login/options', {});
  expect(opt.status).toBe(200);
  const a = await auth.assert(opt.body.publicKey.challenge, over);
  const r = await call(null, 'POST', '/auth/passkeys/login', { token: opt.body.token, ...a });
  return { ...r, cookie: r.headers.get('set-cookie')?.match(/((?:__Host-)?sl_session=[^;]+)/)?.[1] };
}

describe('passkeys', () => {
  it('registers a passkey and signs in with it, without super-admin power', async () => {
    const cookie = await login(`${uid()}@example.com`);
    const auth = await authenticator();
    expect((await enroll(cookie, auth)).status).toBe(201);
    expect((await call(cookie, 'GET', '/auth/passkeys')).body.data).toHaveLength(1);

    const r = await signIn(auth);
    expect(r.status).toBe(200);
    const me = await call(r.cookie!, 'GET', '/me');
    expect(me.status).toBe(200);
    expect(me.body.user.isSuperAdmin).toBe(false);
  });

  it('a passkey session on the owner account has no admin power', async () => {
    const adminCookie = await login(`${uid()}-owner@example.com`, true); // dev login links the GitHub owner identity
    expect((await call(adminCookie, 'GET', '/admin/overview')).status).toBe(200);
    const auth = await authenticator();
    expect((await enroll(adminCookie, auth)).status).toBe(201);
    const r = await signIn(auth);
    expect((await call(r.cookie!, 'GET', '/me')).body.user.isSuperAdmin).toBe(false);
    expect((await call(r.cookie!, 'GET', '/admin/overview')).status).toBe(404);
  });

  it('rejects a wrong origin, wrong ceremony, bad signature and unknown passkey', async () => {
    const cookie = await login(`${uid()}@example.com`);
    const auth = await authenticator();
    await enroll(cookie, auth);
    expect((await signIn(auth, { origin: 'https://evil.example' })).status).toBe(400);
    expect((await signIn(auth, { type: 'webauthn.create' })).status).toBe(400);
    expect((await signIn(auth, { tamper: true })).status).toBe(400);
    expect((await signIn(await authenticator())).status).toBe(400); // never registered
    expect((await signIn(auth)).status).toBe(200); // the real one still works
  });

  it('rejects a registration with the wrong origin, relying party or no user verification', async () => {
    const cookie = await login(`${uid()}@example.com`);
    for (const bad of [{ origin: 'https://evil.example' }, { rp: 'evil.example' }, { uv: false }]) {
      const opt = await call(cookie, 'POST', '/auth/passkeys/register/options', {});
      const att = await (await authenticator()).register(opt.body.publicKey.challenge, bad);
      expect((await call(cookie, 'POST', '/auth/passkeys/register', { token: opt.body.token, ...att })).status, JSON.stringify(bad)).toBe(400);
    }
  });

  it('rejects a replayed or rolled-back sign count (cloned authenticator)', async () => {
    const cookie = await login(`${uid()}@example.com`);
    const auth = await authenticator();
    await enroll(cookie, auth);
    expect((await signIn(auth, { counter: 5 })).status).toBe(200);
    expect((await signIn(auth, { counter: 5 })).status).toBe(400);
    expect((await signIn(auth, { counter: 3 })).status).toBe(400);
    expect((await signIn(auth, { counter: 6 })).status).toBe(200);
  });

  it('challenges are tied to their purpose and cannot be forged', async () => {
    const cookie = await login(`${uid()}@example.com`);
    const auth = await authenticator();
    await enroll(cookie, auth);
    const loginOpt = await call(null, 'POST', '/auth/passkeys/login/options', {});
    const a = await auth.assert(loginOpt.body.publicKey.challenge);
    // A login challenge cannot be used to register, and a tampered token is refused.
    const wrongPurpose = await call(cookie, 'POST', '/auth/passkeys/register', { token: loginOpt.body.token, clientDataJSON: a.clientDataJSON, attestationObject: a.authenticatorData });
    expect(wrongPurpose.status).toBe(400);
    const forged = await call(null, 'POST', '/auth/passkeys/login', { token: loginOpt.body.token.slice(0, -2) + 'AA', ...a });
    expect(forged.status).toBe(400);
  });

  it("one user cannot register a passkey using another user's challenge", async () => {
    const alice = await login(`${uid()}@example.com`);
    const bob = await login(`${uid()}@example.com`);
    const opt = await call(alice, 'POST', '/auth/passkeys/register/options', {});
    const att = await (await authenticator()).register(opt.body.publicKey.challenge);
    expect((await call(bob, 'POST', '/auth/passkeys/register', { token: opt.body.token, ...att })).status).toBe(400);
  });

  it('removing a passkey stops it working, and only its owner can remove it', async () => {
    const owner = await login(`${uid()}@example.com`);
    const other = await login(`${uid()}@example.com`);
    const auth = await authenticator();
    const reg = await enroll(owner, auth);
    expect((await call(other, 'DELETE', `/auth/passkeys/${reg.body.id}`)).status).toBe(404);
    expect((await call(owner, 'DELETE', `/auth/passkeys/${reg.body.id}`)).status).toBe(200);
    expect((await signIn(auth)).status).toBe(400);
  });

  it('a disabled account cannot sign in with a passkey', async () => {
    const { env } = await import('cloudflare:test');
    const email = `${uid()}@example.com`;
    const cookie = await login(email);
    const auth = await authenticator();
    await enroll(cookie, auth);
    await env.DB.prepare(`UPDATE users SET disabled_at = ? WHERE email = ?`).bind(new Date().toISOString(), email).run();
    expect((await signIn(auth)).status).toBe(400);
  });

  it('passkey routes need a session where they should', async () => {
    expect((await call(null, 'POST', '/auth/passkeys/register/options', {})).status).toBe(401);
    expect((await call(null, 'GET', '/auth/passkeys')).status).toBe(401);
  });
});
