import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { detectAlerts } from '../src/alerts';
import { call, loginAdmin, newOrg } from './helpers';

const ev = (kind: string, over: Record<string, unknown> = {}) =>
  env.DB.prepare(`INSERT INTO auth_events(id, at, kind, user_id, email_hash, door, country, browser, reason) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`)
    .bind(`aev_${Math.random().toString(36).slice(2)}`, new Date().toISOString(), kind, over.user ?? null, over.hash ?? null, over.door ?? null, over.country ?? null, over.reason ?? null).run();

beforeEach(async () => {
  await env.DB.prepare(`DELETE FROM security_alerts`).run();
  await env.DB.prepare(`DELETE FROM auth_events`).run();
});

describe('security alerts (O2)', () => {
  it('five refusals for one address make one alert, and later ones update it instead of adding more', async () => {
    for (let i = 0; i < 5; i++) await ev('signin_refused', { hash: 'abcdef1234567890', reason: 'not_invited' });
    expect(await detectAlerts(env)).toEqual({ created: 1, updated: 0 });
    await ev('signin_refused', { hash: 'abcdef1234567890' });
    expect(await detectAlerts(env)).toEqual({ created: 0, updated: 1 });
    const dev = await loginAdmin();
    const r = await call(dev, 'GET', '/admin/security/alerts');
    expect(r.body.data).toHaveLength(1);
    expect(r.body.data[0]).toMatchObject({ kind: 'repeated_refusals', severity: 'medium', state: 'open', count: 6, who: 'address abcdef12' });
  });

  it('four refusals are not enough', async () => {
    for (let i = 0; i < 4; i++) await ev('signin_refused', { hash: 'zzz' });
    expect(await detectAlerts(env)).toEqual({ created: 0, updated: 0 });
  });

  it('any refusal at the owner door is a high alert', async () => {
    await ev('signin_refused', { door: 'github', country: 'DE', hash: 'h1' });
    await detectAlerts(env);
    const dev = await loginAdmin();
    const a = (await call(dev, 'GET', '/admin/security/alerts')).body.data[0];
    expect(a).toMatchObject({ kind: 'owner_door', severity: 'high', who: 'the owner sign-in' });
    expect(a.detail).toEqual({ country: 'DE' });
  });

  it('a "not me" report is a high alert named by the person', async () => {
    const org = await newOrg('Alert Co');
    const dev = await loginAdmin();
    const me = (await call(org.cookie, 'GET', '/me')).body.user;
    await ev('not_me', { user: me.id });
    await detectAlerts(env);
    const a = (await call(dev, 'GET', '/admin/security/alerts')).body.data[0];
    expect(a).toMatchObject({ kind: 'not_me', severity: 'high', who: me.email });
  });

  it('the owner can move an alert through its states with a note, and each change is audited', async () => {
    await ev('signin_refused', { door: 'github' });
    await detectAlerts(env);
    const dev = await loginAdmin();
    const id = (await call(dev, 'GET', '/admin/security/alerts')).body.data[0].id;
    expect((await call(dev, 'PATCH', `/admin/security/alerts/${id}`, { state: 'investigating', note: 'checking logs' })).status).toBe(200);
    expect((await call(dev, 'PATCH', `/admin/security/alerts/${id}`, { state: 'resolved' })).status).toBe(200);
    const list = (await call(dev, 'GET', '/admin/security/alerts?state=resolved')).body.data;
    expect(list[0]).toMatchObject({ id, state: 'resolved', note: 'checking logs' });
    expect((await call(dev, 'GET', '/admin/security/alerts?state=open')).body.data).toHaveLength(0);
    const n = await env.DB.prepare(`SELECT COUNT(*) AS n FROM platform_audit WHERE action = 'security.alert' AND target = ?`).bind(id).first<{ n: number }>();
    expect(n!.n).toBe(2);
    expect((await call(dev, 'PATCH', `/admin/security/alerts/${id}`, { state: 'bogus' })).status).toBe(400);
    expect((await call(dev, 'PATCH', '/admin/security/alerts/sal_missing', { state: 'resolved' })).status).toBe(404);
    expect((await call(dev, 'GET', '/admin/security/alerts?state=bogus')).status).toBe(400);
  });

  it('only the owner can see or change alerts', async () => {
    const org = await newOrg('Nosy Co');
    expect((await call(org.cookie, 'GET', '/admin/security/alerts')).status).toBe(404);
    expect((await call(org.cookie, 'PATCH', '/admin/security/alerts/x', { state: 'resolved' })).status).toBe(404);
  });
});
