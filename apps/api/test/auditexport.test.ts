import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { dailyJob } from '../src/index';
import { addMember, call, loginAdmin, newOrg, product, stub, uid } from './helpers';

const day = (offsetDays = 0) => new Date(Date.now() + offsetDays * 86400_000).toISOString().slice(0, 10);
const ago = (days: number) => new Date(Date.now() - days * 86400_000).toISOString();
const ageAudit = (orgId: string, days: number) => runInDurableObject(stub(orgId), (_i, state) => { state.storage.sql.exec(`UPDATE audit_log SET created_at = ?`, ago(days)); });
const auditCount = async (org: { cookie: string; base: string }) => (await call(org.cookie, 'GET', `${org.base}/audit?limit=200`)).body.data.length;

describe('activity log export (F30)', () => {
  it('exports a date range as CSV, with people shown by name', async () => {
    const org = await newOrg();
    await env.DB.prepare(`UPDATE users SET name = 'Dana Owner' WHERE email = ?`).bind(org.email).run();
    await product(org, { name: 'Exported widget' });
    const r = await call(org.cookie, 'GET', `${org.base}/audit?format=csv&from=${day(-1)}&to=${day()}`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('text/csv');
    expect(r.headers.get('content-disposition')).toContain('attachment');
    const lines = (r.body as string).trim().split('\n');
    expect(lines[0]).toBe('Time,Who,Action,What,Id,Details');
    const row = lines.find((l) => l.includes('product.create'))!;
    expect(row).toContain('Dana Owner');
    expect(row).toContain('Exported widget');
  });

  it('respects the range and rejects bad ones', async () => {
    const org = await newOrg();
    await product(org);
    const none = await call(org.cookie, 'GET', `${org.base}/audit?format=csv&from=${day(1)}&to=${day(2)}`);
    expect((none.body as string).trim().split('\n')).toHaveLength(1); // header only
    expect((await call(org.cookie, 'GET', `${org.base}/audit?format=xml`)).status).toBe(400);
    expect((await call(org.cookie, 'GET', `${org.base}/audit?format=csv&from=yesterday`)).status).toBe(400);
  });

  it('keeps spreadsheet formulas from running', async () => {
    const org = await newOrg();
    await env.DB.prepare(`UPDATE users SET name = '=HYPERLINK("http://evil.example","x")' WHERE email = ?`).bind(org.email).run();
    await product(org);
    const csv = (await call(org.cookie, 'GET', `${org.base}/audit?format=csv`)).body as string;
    expect(csv).toContain(`"'=HYPERLINK(""http://evil.example"",""x"")"`);
    expect(csv).not.toMatch(/(^|,)=HYPERLINK/m);
  });

  it('is for roles that may read the log, and never for API keys', async () => {
    const org = await newOrg();
    const viewer = await addMember(org, 'viewer');
    const acc = await addMember(org, 'accountant');
    expect((await call(viewer.cookie, 'GET', `${org.base}/audit?format=csv`)).status).toBe(403);
    expect((await call(acc.cookie, 'GET', `${org.base}/audit?format=csv`)).status).toBe(200);
    const key = await call(org.cookie, 'POST', `${org.base}/api-keys`, { name: 'k', scopes: ['inventory:read', 'reports:read'] });
    expect((await call(null, 'GET', `${org.base}/audit?format=csv`, undefined, { authorization: `Bearer ${key.body.secret ?? key.body.key}` })).status).toBe(403);
  });

  it('the owner exports the platform log, and nobody else can', async () => {
    const dev = await loginAdmin();
    const org = await newOrg();
    await call(dev, 'PATCH', `/admin/orgs/${org.orgId}/plan`, { plan: 'standard' });
    const r = await call(dev, 'GET', `/admin/audit?format=csv&from=${day(-1)}&to=${day()}`);
    expect(r.status).toBe(200);
    expect((r.body as string).split('\n')[0]).toBe('Time,Who,Action,Target,Details');
    expect(r.body).toContain('org.plan');
    expect((await call(org.cookie, 'GET', '/admin/audit?format=csv')).status).toBe(404);
  });
});

describe('retention (F30)', () => {
  it('the activity log keeps 2 years by default and removes older rows in the daily job', async () => {
    const org = await newOrg();
    await product(org);
    await ageAudit(org.orgId, 400); // older than a year, younger than two
    await dailyJob(env);
    expect(await auditCount(org)).toBeGreaterThan(0);
    await ageAudit(org.orgId, 800);
    await dailyJob(env);
    expect(await auditCount(org)).toBe(0);
  });

  it('a business can ask for a different period, between 1 and 7 years', async () => {
    const org = await newOrg();
    expect((await call(org.cookie, 'PATCH', `${org.base}/settings`, { auditRetentionYears: 0 })).status).toBe(400);
    expect((await call(org.cookie, 'PATCH', `${org.base}/settings`, { auditRetentionYears: 8 })).status).toBe(400);
    expect((await call(org.cookie, 'GET', `${org.base}/settings`)).body.settings.auditRetentionYears).toBe(2);
    expect((await call(org.cookie, 'PATCH', `${org.base}/settings`, { auditRetentionYears: 1 })).status).toBe(200);
    await product(org);
    await ageAudit(org.orgId, 400);
    await dailyJob(env);
    expect(await auditCount(org)).toBe(0);
    expect((await call(org.cookie, 'PATCH', `${org.base}/settings`, { auditRetentionYears: 7 })).body.settings.auditRetentionYears).toBe(7);
  });

  it('the platform log keeps one year and notifications 60 days', async () => {
    const id = `pau_old_${uid()}`;
    const fresh = `pau_new_${uid()}`;
    await env.DB.prepare(`INSERT INTO platform_audit(id, actor, action, target, detail, request_id, created_at) VALUES (?, 'x', 'old', NULL, NULL, 'r', ?), (?, 'x', 'new', NULL, NULL, 'r', ?)`).bind(id, ago(400), fresh, ago(300)).run();
    const org = await newOrg();
    const me = (await call(org.cookie, 'GET', '/me')).body.user.id;
    await env.DB.prepare(`INSERT INTO notifications(id, user_id, org_id, kind, title, created_at) VALUES (?, ?, ?, 'stock.low', 't', ?), (?, ?, ?, 'stock.low', 't', ?)`).bind(`ntf_old_${uid()}`, me, org.orgId, ago(61), `ntf_new_${uid()}`, me, org.orgId, ago(59)).run();
    await dailyJob(env);
    const pa = await env.DB.prepare(`SELECT id FROM platform_audit WHERE id IN (?, ?)`).bind(id, fresh).all<{ id: string }>();
    expect(pa.results.map((r) => r.id)).toEqual([fresh]);
    const n = await env.DB.prepare(`SELECT COUNT(*) AS n FROM notifications WHERE user_id = ?`).bind(me).first<{ n: number }>();
    expect(n?.n).toBe(1);
  });
});
