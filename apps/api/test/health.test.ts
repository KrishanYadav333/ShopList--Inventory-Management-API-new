import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { scoreHealth, HEALTH_WEIGHTS } from '@shoplist/shared';
import { computeHealth } from '../src/index';
import { call, loginAdmin, newOrg, product } from './helpers';

const base = { changes14d: 30, adminSeenDaysAgo: 1, backupDays: 7, backupOkDays: 7, limitUse: 0.1 };

describe('business health score (O3)', () => {
  it('the weights add up to 100 and a perfect business scores 100', () => {
    expect(Object.values(HEALTH_WEIGHTS).reduce((a, b) => a + b, 0)).toBe(100);
    expect(scoreHealth(base)).toMatchObject({ score: 100, label: 'healthy' });
  });

  it('a silent business is Watch, and one that also fails its backups is At risk; the parts add up to the score', () => {
    const r = scoreHealth({ changes14d: 0, adminSeenDaysAgo: null, backupDays: 7, backupOkDays: 7, limitUse: 0.1 });
    expect(r.label).toBe('watch');
    expect(r.parts).toEqual({ activity: 0, adminSignIn: 0, backups: 20, headroom: 20 });
    expect(r.score).toBe(40);
    expect(scoreHealth({ changes14d: 0, adminSeenDaysAgo: null, backupDays: 7, backupOkDays: 0, limitUse: 0.1 }).label).toBe('at_risk');
    expect(Object.values(r.parts).reduce((a, b) => a + b, 0)).toBe(r.score);
  });

  it('each part moves the score the way the plan says', () => {
    expect(scoreHealth({ ...base, changes14d: 3 }).parts.activity).toBe(15);
    expect(scoreHealth({ ...base, changes14d: 10 }).parts.activity).toBe(30);
    expect(scoreHealth({ ...base, adminSeenDaysAgo: 20 }).parts.adminSignIn).toBe(10);
    expect(scoreHealth({ ...base, adminSeenDaysAgo: 45 }).parts.adminSignIn).toBe(0);
    expect(scoreHealth({ ...base, backupOkDays: 4, backupDays: 8 }).parts.backups).toBe(10);
    expect(scoreHealth({ ...base, backupDays: 0, backupOkDays: 0 }).parts.backups).toBe(20);
    expect(scoreHealth({ ...base, limitUse: 0.8 }).parts.headroom).toBe(10);
    expect(scoreHealth({ ...base, limitUse: 1 }).parts.headroom).toBe(0);
  });

  it('only the owner can read it', async () => {
    const org = await newOrg('Health Nosy');
    expect((await call(org.cookie, 'GET', '/admin/health')).status).toBe(404);
  });

  it('a business younger than two weeks is shown as new, an older one is scored', async () => {
    const dev = await loginAdmin();
    const young = await newOrg('Young Co');
    const old = await newOrg('Old Co');
    await product(old);
    await env.DB.prepare(`UPDATE organizations SET created_at = ? WHERE id = ?`).bind(new Date(Date.now() - 30 * 86400_000).toISOString(), old.orgId).run();
    const run = await computeHealth(env);
    expect(run.scored).toBeGreaterThanOrEqual(1);
    const list = (await call(dev, 'GET', '/admin/health')).body.data as { id: string; status: string; score: number | null; parts: Record<string, number> | null }[];
    expect(list.find((x) => x.id === young.orgId)!.status).toBe('new');
    const o = list.find((x) => x.id === old.orgId)!;
    expect(['healthy', 'watch', 'at_risk']).toContain(o.status);
    expect(Object.values(o.parts!).reduce((a, b) => a + b, 0)).toBe(o.score);
  });

  it('suspended and deleting businesses are listed under their own label, not scored', async () => {
    const dev = await loginAdmin();
    const org = await newOrg('Paused Co');
    await env.DB.prepare(`UPDATE organizations SET suspended_at = ? WHERE id = ?`).bind(new Date().toISOString(), org.orgId).run();
    const o = ((await call(dev, 'GET', '/admin/health')).body.data as { id: string; status: string }[]).find((x) => x.id === org.orgId)!;
    expect(o.status).toBe('suspended');
  });
});
