import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { render, ORG_DAILY_CAP, sendMail } from '../src/email';
import { sendDigests } from '../src/index';
import { addMember, call, defaultLocation, newOrg, product, uid } from './helpers';
import type { SentMail } from './apply-migrations';

const g = globalThis as unknown as { __mail: SentMail[]; __mailFail?: boolean };
beforeEach(() => { g.__mail.length = 0; g.__mailFail = false; });
const to = (addr: string) => g.__mail.filter((m) => m.to === addr);
const settle = () => new Promise((r) => setTimeout(r, 150)); // sends run after the response

describe('email (F23)', () => {
  it('an invitation is emailed with its link, no sign-in needed to receive it', async () => {
    const org = await newOrg('Mail Co');
    const email = `${uid()}-new@example.com`;
    const r = await call(org.cookie, 'POST', `${org.base}/invitations`, { email, role: 'manager' });
    expect(r.status).toBe(201);
    await settle();
    const m = to(email)[0];
    expect(m.subject).toBe('You are invited to Mail Co on ShopList');
    expect(m.text).toContain(r.body.link);
    expect(m.html).toContain('Accept the invitation');
    expect(m.html).not.toContain('<script');
  });

  it('approval requests reach managers by email by default; low stock does not', async () => {
    const org = await newOrg('Approve Co');
    const mgr = await addMember(org, 'manager');
    const mgrEmail = (await call(mgr.cookie, 'GET', '/me')).body.user.email;
    const staff = await addMember(org, 'stock');
    await call(org.cookie, 'PATCH', `${org.base}/settings`, { approvals: { largeAdjustment: { on: false, units: 20, valueMinor: 50000 }, damage: { on: true }, countVariance: { on: false, units: 20 }, cancelPaid: { on: false }, priceDrop: { on: false, percent: 30 } } });
    const p = await product(org);
    const loc = await defaultLocation(org);
    await call(org.cookie, 'POST', `${org.base}/stock/movements`, { productId: p.id, locationId: loc, delta: 5, reason: 'receive' });
    g.__mail.length = 0;
    const r = await call(staff.cookie, 'POST', `${org.base}/stock/movements`, { productId: p.id, locationId: loc, delta: -1, reason: 'damage' });
    expect(r.status).toBe(202);
    await settle();
    expect(to(mgrEmail).some((m) => m.subject.includes('Needs approval'))).toBe(true);
    const mail = to(mgrEmail).find((m) => m.subject.includes('Needs approval'))!;
    expect(mail.headers?.['List-Unsubscribe']).toMatch(/email\/unsubscribe\?t=/);
    expect(g.__mail.some((m) => m.subject.includes('Low stock'))).toBe(false);
  });

  it('one-click unsubscribe switches off just that kind, and a bad link does nothing', async () => {
    const org = await newOrg('Unsub Co');
    const mgr = await addMember(org, 'manager');
    const me = (await call(mgr.cookie, 'GET', '/me')).body.user;
    const sender = await addMember(org, 'stock');
    await call(org.cookie, 'PATCH', `${org.base}/settings`, { approvals: { largeAdjustment: { on: false, units: 20, valueMinor: 50000 }, damage: { on: true }, countVariance: { on: false, units: 20 }, cancelPaid: { on: false }, priceDrop: { on: false, percent: 30 } } });
    const p = await product(org);
    const loc = await defaultLocation(org);
    await call(org.cookie, 'POST', `${org.base}/stock/movements`, { productId: p.id, locationId: loc, delta: 9, reason: 'receive' });
    const dmg = () => call(sender.cookie, 'POST', `${org.base}/stock/movements`, { productId: p.id, locationId: loc, delta: -1, reason: 'damage' });
    g.__mail.length = 0;
    await dmg(); await settle();
    const link = decodeURIComponent((to(me.email)[0].headers!['List-Unsubscribe']).slice(1, -1).split('?t=')[1]);
    const res = await call(null, 'GET', `/email/unsubscribe?t=${encodeURIComponent(link)}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
    g.__mail.length = 0;
    await dmg(); await settle();
    expect(to(me.email)).toHaveLength(0); // email is off now
    // The in-app notice is untouched.
    expect(JSON.stringify((await call(mgr.cookie, 'GET', '/me/notifications')).body)).toContain('Needs approval');
    expect((await call(null, 'GET', '/email/unsubscribe?t=garbage')).status).toBe(400);
    expect((await call(null, 'GET', '/email/unsubscribe')).status).toBe(400);
    const prefs = await call(mgr.cookie, 'GET', `/me/notification-preferences?org=${org.orgId}`);
    expect(prefs.body.data.find((k: any) => k.kind === 'approval.requested')).toMatchObject({ email: false, inApp: true });
  });

  it('people choose their own email settings, per business', async () => {
    const org = await newOrg('Prefs Co');
    const prefs = () => call(org.cookie, 'GET', `/me/notification-preferences?org=${org.orgId}`);
    const first = (await prefs()).body;
    expect(first.data.find((k: any) => k.kind === 'stock.low').email).toBe(false);
    expect(first.data.find((k: any) => k.kind === 'approval.requested').email).toBe(true);
    expect(first.digest).toBe(false);
    expect((await call(org.cookie, 'PATCH', '/me/notification-preferences', { orgId: org.orgId, kind: 'stock.low', email: true })).status).toBe(200);
    expect((await call(org.cookie, 'PATCH', '/me/notification-preferences', { orgId: org.orgId, kind: 'digest', email: true })).status).toBe(200);
    const next = (await prefs()).body;
    expect(next.data.find((k: any) => k.kind === 'stock.low').email).toBe(true);
    expect(next.digest).toBe(true);
    expect((await call(org.cookie, 'PATCH', '/me/notification-preferences', { orgId: org.orgId, kind: 'bogus', email: true })).status).toBe(400);
    const other = await newOrg('Not Mine');
    expect((await call(org.cookie, 'PATCH', '/me/notification-preferences', { orgId: other.orgId, kind: 'digest', email: true })).status).toBe(404);
  });

  it('a business cannot use more than its daily cap, and a failing provider never breaks anything', async () => {
    const scope = `org_cap_${uid()}`;
    const m = { to: { email: 'a@example.com' }, subject: 's', lines: ['x'] };
    let ok = 0;
    for (let i = 0; i < ORG_DAILY_CAP + 5; i++) if (await sendMail(env as any, scope, m)) ok++;
    expect(ok).toBe(ORG_DAILY_CAP);
    g.__mailFail = true;
    expect(await sendMail(env as any, `org_fail_${uid()}`, m)).toBe(false);
    const org = await newOrg('Fail Co');
    expect((await call(org.cookie, 'POST', `${org.base}/invitations`, { email: `${uid()}@example.com`, role: 'viewer' })).status).toBe(201);
  });

  it('nothing is sent without the provider key', async () => {
    expect(await sendMail({ ...env, BREVO_API_KEY: undefined } as any, 'x', { to: { email: 'a@example.com' }, subject: 's', lines: ['x'] })).toBe(false);
    expect(g.__mail).toHaveLength(0);
  });

  it('emails escape HTML and carry plain text too', () => {
    const { html, text } = render({ to: { email: 'a@b.c' }, subject: 's', lines: ['<script>alert(1)</script> & co'], link: { url: 'https://x.test/?a=1&b="2"', label: 'Go' } });
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('a=1&amp;b=&quot;2&quot;');
    expect(text).toContain('Go: https://x.test/');
  });
});

describe('morning summary (F23)', () => {
  async function opted(tz: string, role: 'admin' | 'manager' | 'stock') {
    const org = await newOrg('Digest Co');
    await call(org.cookie, 'PATCH', `${org.base}/settings`, { timezone: tz });
    const who = role === 'admin' ? org : await addMember(org, role);
    const email = role === 'admin' ? org.email : (await call(who.cookie, 'GET', '/me')).body.user.email;
    await call(who.cookie, 'PATCH', '/me/notification-preferences', { orgId: org.orgId, kind: 'digest', email: true });
    return { org, who, email };
  }
  const at = (hourUtc: number) => new Date(Date.UTC(2026, 5, 1, hourUtc, 15));

  it('goes out at 08:00 in the business timezone, once per hour check, only to people who asked', async () => {
    const { email } = await opted('Asia/Kathmandu', 'admin'); // UTC+5:45 -> 08:15 local is 02:30 UTC
    g.__mail.length = 0;
    await sendDigests(env as any, at(12));
    expect(to(email)).toHaveLength(0);
    await sendDigests(env as any, new Date(Date.UTC(2026, 5, 1, 2, 30)));
    expect(to(email)).toHaveLength(1);
    expect(to(email)[0].subject).toBe('Digest Co: your morning summary');
    expect(to(email)[0].headers?.['List-Unsubscribe']).toBeTruthy();
  });

  it('shows sales only to people who may see reports', async () => {
    const a = await opted('UTC', 'admin');
    const s = await opted('UTC', 'stock');
    g.__mail.length = 0;
    await sendDigests(env as any, at(8));
    expect(to(a.email)[0].text).toContain('Yesterday:');
    expect(to(s.email)[0].text).not.toContain('Yesterday:');
    expect(to(s.email)[0].text).not.toContain('Waiting for approval');
    expect(to(s.email)[0].text).toContain('Low stock:');
  });

  it('skips a deactivated person and a business scheduled for deletion', async () => {
    const a = await opted('UTC', 'manager');
    await call(a.org.cookie, 'POST', `${a.org.base}/members/${(await call(a.who.cookie, 'GET', '/me')).body.user.id}/deactivate`, {});
    const b = await opted('UTC', 'admin');
    await call(b.org.cookie, 'DELETE', b.org.base, { confirmName: 'Digest Co' });
    g.__mail.length = 0;
    await sendDigests(env as any, at(8));
    expect(to(a.email)).toHaveLength(0);
    expect(to(b.email)).toHaveLength(0);
  });
});
