import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { addMember, call, login, loginAdmin, newOrg, uid } from './helpers';
import { authenticator } from './webauthn-helper';

const setEnforce = (on: boolean) => env.DB.prepare(`INSERT INTO platform_settings(key, value, updated_at) VALUES ('passkey_enforce', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).bind(on ? 'on' : 'off', new Date().toISOString()).run();
beforeEach(async () => { await setEnforce(false); });
/** Pretend this is a new session: the first passkey confirms the session it was added in, so tests clear that. */
const forget = () => env.DB.prepare(`UPDATE sessions SET passkey_at = NULL`).run();

async function enroll(cookie: string, auth: Awaited<ReturnType<typeof authenticator>>) {
  const opt = await call(cookie, 'POST', '/auth/passkeys/register/options', {});
  const att = await auth.register(opt.body.publicKey.challenge);
  return call(cookie, 'POST', '/auth/passkeys/register', { token: opt.body.token, ...att, name: 'k' });
}
async function verify(cookie: string, auth: Awaited<ReturnType<typeof authenticator>>) {
  const opt = await call(cookie, 'POST', '/auth/passkeys/verify/options', {});
  if (opt.status !== 200) return opt;
  const a = await auth.assert(opt.body.publicKey.challenge);
  return call(cookie, 'POST', '/auth/passkeys/verify', { token: opt.body.token, ...a });
}

describe('passkeys required for owner and admins (A3)', () => {
  it('nothing changes while enforcement is off', async () => {
    const org = await newOrg('Off Co');
    expect((await call(org.cookie, 'GET', `${org.base}/products`)).status).toBe(200);
    const dev = await loginAdmin();
    expect((await call(dev, 'GET', '/admin/overview')).status).toBe(200);
  });

  it('the registration options can ask the browser for a phone QR code or this device', async () => {
    const cookie = await login(`${uid()}@example.com`);
    const phone = await call(cookie, 'POST', '/auth/passkeys/register/options', { where: 'phone' });
    expect(phone.body.publicKey.hints).toEqual(['hybrid']);
    const device = await call(cookie, 'POST', '/auth/passkeys/register/options', { where: 'device' });
    expect(device.body.publicKey.hints).toEqual(['client-device']);
    expect((await call(cookie, 'POST', '/auth/passkeys/register/options', {})).body.publicKey.hints).toBeUndefined();
  });

  it('the owner cannot turn it on without a passkey of their own, and can with one', async () => {
    const dev = await loginAdmin();
    const r = await call(dev, 'POST', '/admin/passkey-enforcement', { on: true });
    expect(r.status).toBe(409);
    expect(r.body.type).toContain('owner-needs-passkey');
    await enroll(dev, await authenticator());
    expect((await call(dev, 'POST', '/admin/passkey-enforcement', { on: true })).body.on).toBe(true);
    expect((await call(dev, 'GET', '/admin/passkey-enforcement')).body).toMatchObject({ on: true, ownerHasPasskey: true });
  });

  it('with it on, an owner session without a passkey is stopped, and tapping a passkey unlocks it', async () => {
    const dev = await loginAdmin();
    const key = await authenticator();
    await enroll(dev, key);
    await forget();
    await setEnforce(true);
    const blocked = await call(dev, 'GET', '/admin/overview');
    expect(blocked.status).toBe(403);
    expect(blocked.body.type).toContain('passkey-required');
    expect((await call(dev, 'GET', '/me')).status).toBe(200); // account routes stay open
    expect((await verify(dev, key)).status).toBe(200);
    expect((await call(dev, 'GET', '/admin/overview')).status).toBe(200);
    expect((await call(dev, 'GET', '/auth/passkey-status')).body).toMatchObject({ enforced: true, applies: 'owner', hasPasskey: true, verified: true });
  });

  it('an owner with no passkey is told to add one, and a stale confirmation counts as none', async () => {
    const dev = await loginAdmin();
    await setEnforce(true);
    const r = await call(dev, 'GET', '/admin/overview');
    expect(r.body.type).toContain('passkey-setup-required');
    const key = await authenticator();
    await enroll(dev, key);
    await verify(dev, key);
    await env.DB.prepare(`UPDATE sessions SET passkey_at = ?`).bind(new Date(Date.now() - 13 * 3600_000).toISOString()).run();
    expect((await call(dev, 'GET', '/admin/overview')).body.type).toContain('passkey-required');
  });

  it('a business admin gets a 7-day grace period, then must add a passkey', async () => {
    const org = await newOrg('Grace Co');
    await setEnforce(true);
    expect((await call(org.cookie, 'GET', `${org.base}/products`)).status).toBe(200); // starts the grace period
    const g = await env.DB.prepare(`SELECT passkey_grace_until AS g FROM users WHERE id = (SELECT user_id FROM memberships WHERE org_id = ? AND role = 'admin')`).bind(org.orgId).first<{ g: string }>();
    expect(Date.parse(g!.g)).toBeGreaterThan(Date.now() + 6 * 86400_000);
    await env.DB.prepare(`UPDATE users SET passkey_grace_until = ? WHERE id = (SELECT user_id FROM memberships WHERE org_id = ? AND role = 'admin')`).bind(new Date(Date.now() - 1000).toISOString(), org.orgId).run();
    const r = await call(org.cookie, 'GET', `${org.base}/products`);
    expect(r.status).toBe(403);
    expect(r.body.type).toContain('passkey-setup-required');
  });

  it('an admin with a passkey must tap it; a passkey sign-in already counts', async () => {
    const org = await newOrg('Tap Co');
    const key = await authenticator();
    await enroll(org.cookie, key);
    await forget();
    await setEnforce(true);
    expect((await call(org.cookie, 'GET', `${org.base}/products`)).body.type).toContain('passkey-required');
    expect((await verify(org.cookie, key)).status).toBe(200);
    expect((await call(org.cookie, 'GET', `${org.base}/products`)).status).toBe(200);

    // Signing in with the passkey itself needs no second tap.
    const opt = await call(null, 'POST', '/auth/passkeys/login/options', {});
    const a = await key.assert(opt.body.publicKey.challenge);
    const r = await call(null, 'POST', '/auth/passkeys/login', { token: opt.body.token, ...a });
    const cookie = r.headers.get('set-cookie')!.match(/((?:__Host-)?sl_session=[^;]+)/)![1];
    expect((await call(cookie, 'GET', `${org.base}/products`)).status).toBe(200);
  });

  it('the first passkey confirms the session it was added in, a later one does not (a stolen session cannot add its way in)', async () => {
    const org = await newOrg('First Co');
    await setEnforce(true);
    expect((await call(org.cookie, 'GET', `${org.base}/products`)).status).toBe(200); // grace
    expect((await enroll(org.cookie, await authenticator())).status).toBe(201);
    expect((await call(org.cookie, 'GET', '/auth/passkey-status')).body.verified).toBe(true);
    await forget();
    expect((await call(org.cookie, 'GET', '/auth/passkey-status')).body.verified).toBe(false);
    expect((await enroll(org.cookie, await authenticator())).status).toBe(201);
    expect((await call(org.cookie, 'GET', '/auth/passkey-status')).body.verified).toBe(false);
    expect((await call(org.cookie, 'GET', `${org.base}/products`)).body.type).toContain('passkey-required');
  });

  it('staff are never blocked, even with it on', async () => {
    const org = await newOrg('Staff Co');
    const staff = await addMember(org, 'manager');
    await setEnforce(true);
    expect((await call(staff.cookie, 'GET', `${org.base}/products`)).status).toBe(200);
    expect((await call(staff.cookie, 'GET', '/auth/passkey-status')).body).toMatchObject({ enforced: true, applies: null });
  });

  it("another person's passkey cannot confirm this session", async () => {
    const a = await newOrg('A Co');
    const b = await newOrg('B Co');
    const keyA = await authenticator();
    await enroll(a.cookie, keyA);
    await enroll(b.cookie, await authenticator());
    const opt = await call(b.cookie, 'POST', '/auth/passkeys/verify/options', {});
    const asn = await keyA.assert(opt.body.publicKey.challenge);
    expect((await call(b.cookie, 'POST', '/auth/passkeys/verify', { token: opt.body.token, ...asn })).status).toBe(400);
  });

  it('the owner can reset a locked-out admin, who gets a fresh grace period', async () => {
    const org = await newOrg('Locked Co');
    const dev = await loginAdmin();
    await enroll(org.cookie, await authenticator());
    await forget();
    const adminId = (await env.DB.prepare(`SELECT user_id AS id FROM memberships WHERE org_id = ? AND role = 'admin'`).bind(org.orgId).first<{ id: string }>())!.id;
    await setEnforce(true);
    expect((await call(org.cookie, 'GET', `${org.base}/products`)).status).toBe(403);
    // The owner needs a confirmed session to act while enforcement is on.
    const ownerKey = await authenticator();
    await setEnforce(false);
    await enroll(dev, ownerKey);
    await forget();
    await setEnforce(true);
    await verify(dev, ownerKey);
    expect((await call(dev, 'POST', `/admin/users/${adminId}/reset-passkeys`, {})).status).toBe(200);
    expect((await call(org.cookie, 'GET', '/auth/passkeys')).body.data).toHaveLength(0);
    expect((await call(org.cookie, 'GET', `${org.base}/products`)).status).toBe(200);
    expect((await call(org.cookie, 'POST', '/admin/users/x/reset-passkeys', {})).status).toBe(404);
  });
});
