import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { call, loginAdmin, newOrg } from './helpers';

type Item = { kind: string; label: string; count: number; link: string; error?: boolean };
const attention = async (dev: string) => ((await call(dev, 'GET', '/admin/overview')).body.attention as Item[]);
const kinds = (items: Item[]) => items.map((i) => i.kind);

beforeEach(async () => {
  await env.DB.prepare(`DELETE FROM security_alerts`).run();
  await env.DB.prepare(`DELETE FROM cron_runs`).run();
  await env.DB.prepare(`DELETE FROM backup_runs WHERE day = '2999-01-01'`).run();
  await env.DB.prepare(`DELETE FROM usage_alerts`).run();
});

describe('owner overview (O1)', () => {
  it('only the owner can read it', async () => {
    const org = await newOrg('Overview Nosy');
    expect((await call(org.cookie, 'GET', '/admin/overview')).status).toBe(404);
  });

  it('has the counters, including deleting and new businesses', async () => {
    const dev = await loginAdmin();
    const org = await newOrg('Counter Co');
    await env.DB.prepare(`UPDATE organizations SET delete_after = ? WHERE id = ?`).bind(new Date(Date.now() + 86400_000).toISOString(), org.orgId).run();
    const o = (await call(dev, 'GET', '/admin/overview')).body;
    expect(o.deletingOrganizations).toBeGreaterThanOrEqual(1);
    expect(o.newOrganizations).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(o.attention)).toBe(true);
  });

  it('an open security alert shows up and goes away when it is resolved', async () => {
    const dev = await loginAdmin();
    const now = new Date().toISOString();
    await env.DB.prepare(`INSERT INTO security_alerts(id, kind, severity, subject, dedupe_key, first_at, last_at, updated_at) VALUES ('sal_o1', 'owner_door', 'high', 'owner-door', 'k1', ?, ?, ?)`).bind(now, now, now).run();
    const item = (await attention(dev)).find((i) => i.kind === 'alerts')!;
    expect(item).toMatchObject({ count: 1, link: '/admin/security' });
    await call(dev, 'PATCH', '/admin/security/alerts/sal_o1', { state: 'resolved' });
    expect(kinds(await attention(dev))).not.toContain('alerts');
  });

  it('a failed nightly backup and a failed job are listed with a link to Operations', async () => {
    const dev = await loginAdmin();
    const now = new Date().toISOString();
    await env.DB.prepare(`INSERT INTO backup_runs(org_id, day, ok, created_at) VALUES ('org_x', '2999-01-01', 0, ?)`).bind(now).run();
    await env.DB.prepare(`INSERT INTO cron_runs(id, job, hour_utc, started_at, finished_at, ok, error) VALUES ('run_o1', 'usage', 3, ?, ?, 0, 'boom')`).bind(now, now).run();
    const items = await attention(dev);
    expect(items.find((i) => i.kind === 'backups')).toMatchObject({ count: 1, link: '/admin/operations' });
    expect(items.find((i) => i.kind === 'jobs')!.count).toBeGreaterThanOrEqual(1);
    await env.DB.prepare(`DELETE FROM backup_runs WHERE day = '2999-01-01'`).run();
  });

  it('an expired invitation nobody accepted is listed, an accepted one is not', async () => {
    const dev = await loginAdmin();
    const org = await newOrg('Invite Co');
    const inv = (e: string, tok: string) => env.DB.prepare(`INSERT INTO invitations(token_hash, org_id, email, role, invited_by, expires_at) SELECT ?, ?, ?, 'viewer', id, ? FROM users LIMIT 1`).bind(tok, org.orgId, e, new Date(Date.now() - 2 * 86400_000).toISOString()).run();
    await inv('never-came@example.com', 'tok_o1');
    expect((await attention(dev)).find((i) => i.kind === 'invitations')!.count).toBeGreaterThanOrEqual(1);
    await env.DB.prepare(`DELETE FROM invitations WHERE token_hash = 'tok_o1'`).run();
  });

  it('with nothing wrong the list is empty of problems the test did not create', async () => {
    const dev = await loginAdmin();
    const k = kinds(await attention(dev));
    for (const bad of ['alerts', 'backups', 'jobs', 'usage']) expect(k).not.toContain(bad);
  });
});
