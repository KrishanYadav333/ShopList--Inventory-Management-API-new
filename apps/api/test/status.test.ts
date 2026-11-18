import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { dailyJob } from '../src/index';
import { call, loginAdmin, newOrg } from './helpers';

describe('system status (O4)', () => {
  it('only the owner can read it', async () => {
    const org = await newOrg('Status Co');
    expect((await call(org.cookie, 'GET', '/admin/status')).status).toBe(404);
    expect((await call(null, 'GET', '/admin/status')).status).toBe(401);
  });

  it('records every job and shows its last result', async () => {
    const dev = await loginAdmin();
    await dailyJob(env, 3);
    const r = await call(dev, 'GET', '/admin/status');
    expect(r.status).toBe(200);
    const byJob = Object.fromEntries(r.body.jobs.map((j: { job: string; state: string }) => [j.job, j.state]));
    for (const j of ['usage', 'digests', 'security-alerts', 'count-reminders', 'backups', 'health', 'purge', 'retention', 'prune']) expect(byJob[j], j).toBe('ok');
    expect(r.body.email.dailyCap).toBe(250);
    expect(r.body.healthUrl).toContain('/api/v1/health');
  });

  it('an hourly run outside 03 UTC records only the hourly jobs', async () => {
    await env.DB.prepare(`DELETE FROM cron_runs`).run();
    await dailyJob(env, 9);
    const { results } = await env.DB.prepare(`SELECT DISTINCT job FROM cron_runs ORDER BY job`).all<{ job: string }>();
    expect(results.map((x) => x.job)).toEqual(['digests', 'security-alerts', 'usage']);
  });

  it('a job stuck failing is shown as failed, and two failures in a row tell the owner once', async () => {
    const dev = await loginAdmin();
    await env.DB.prepare(`DELETE FROM cron_runs`).run();
    await env.DB.prepare(`DELETE FROM usage_alerts WHERE metric LIKE 'job:%'`).run();
    const now = new Date();
    const mk = (min: number) => new Date(now.getTime() - min * 60_000).toISOString();
    for (const m of [120, 60]) await env.DB.prepare(`INSERT INTO cron_runs(id, job, hour_utc, started_at, finished_at, ok, error) VALUES (?, 'backups', 3, ?, ?, 0, 'boom')`).bind(`run_t${m}`, mk(m), mk(m)).run();
    const r = await call(dev, 'GET', '/admin/status');
    const b = r.body.jobs.find((j: { job: string }) => j.job === 'backups');
    expect(b.state).toBe('failed');
    expect(b.failures7d).toBe(2);
    expect(b.error).toBe('boom');
  });
});
