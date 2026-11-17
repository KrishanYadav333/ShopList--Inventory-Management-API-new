import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { checkUsage } from '../src/index';
import { foldUsage, overLine, resetUsageCache, FREE_LIMITS } from '../src/usage';
import { call, loginAdmin, newOrg } from './helpers';

const g = globalThis as unknown as { __cf: { graphql: any; sql: any[]; status: number } };
const today = new Date().toISOString().slice(0, 10);
const raw = (over: { requests?: number; written?: number } = {}) => ({
  data: { viewer: { accounts: [{
    w: [{ dimensions: { date: '2026-11-16' }, sum: { requests: 270, errors: 1 }, quantiles: { cpuTimeP50: 693, cpuTimeP99: 6841 } }, { dimensions: { date: today }, sum: { requests: over.requests ?? 320, errors: 0 }, quantiles: { cpuTimeP50: 715, cpuTimeP99: 9444 } }],
    d: [{ dimensions: { date: today }, sum: { rowsRead: 1201, rowsWritten: over.written ?? 149 } }],
    o: [{ dimensions: { date: today }, sum: { requests: 64 } }],
    q: [{ dimensions: { date: today }, sum: { billableOperations: 9 } }],
  }] } }, errors: null,
});
beforeEach(() => { resetUsageCache(); g.__cf.graphql = raw(); g.__cf.sql = []; g.__cf.status = 200; });

describe('usage dashboard (F21)', () => {
  it('folds Cloudflare\'s four result sets into one row per day', () => {
    const rows = foldUsage(raw());
    expect(rows.map((r) => r.date)).toEqual(['2026-11-16', today]);
    expect(rows[1]).toEqual({ date: today, requests: 320, errors: 0, cpuP50Us: 715, cpuP99Us: 9444, d1RowsRead: 1201, d1RowsWritten: 149, doRequests: 64, queueOps: 9 });
    expect(foldUsage({ data: { viewer: { accounts: [] } } })).toEqual([]);
  });

  it('flags a metric at 70% of its free allowance and not below', () => {
    const d = foldUsage(raw({ requests: 70_000 })).at(-1)!;
    expect(overLine(d).map((x) => x.metric)).toEqual(['requests']);
    expect(overLine(foldUsage(raw({ requests: 69_999 })).at(-1)!)).toEqual([]);
    expect(overLine(undefined)).toEqual([]);
    expect(FREE_LIMITS.requests).toBe(100_000);
  });

  it('only the owner reads it, and it shows days, limits and warnings', async () => {
    const org = await newOrg();
    expect((await call(org.cookie, 'GET', '/admin/usage')).status).toBe(404);
    expect((await call(null, 'GET', '/admin/usage')).status).toBe(401);
    g.__cf.graphql = raw({ written: 80_000 });
    const r = await call(await loginAdmin(), 'GET', '/admin/usage');
    expect(r.status).toBe(200);
    expect(r.body.days.at(-1)).toMatchObject({ requests: 320, d1RowsWritten: 80_000 });
    expect(r.body.warnings).toEqual([expect.objectContaining({ metric: 'd1RowsWritten', label: 'Database rows written' })]);
    expect(r.body.limits.requests).toBe(100_000);
  });

  it('lists the busiest businesses with their names and counts', async () => {
    const org = await newOrg('Busy Co');
    g.__cf.sql = [{ orgId: org.orgId, requests: '1234', errors: '2' }];
    const r = await call(await loginAdmin(), 'GET', '/admin/usage');
    expect(r.body.businesses[0]).toMatchObject({ orgId: org.orgId, name: 'Busy Co', requests: 1234, errors: 2, products: 0, members: 1 });
  });

  it('says so plainly when Cloudflare cannot be reached, and never leaks the token', async () => {
    g.__cf.status = 403;
    const r = await call(await loginAdmin(), 'GET', '/admin/usage');
    expect(r.status).toBe(503);
    expect(r.body.type).toContain('usage-unavailable');
    expect(JSON.stringify(r.body)).not.toContain('cfut_');
  });

  it('tells the owner once a day per metric when a limit passes 70%', async () => {
    const dev = await loginAdmin();
    g.__cf.graphql = raw({ requests: 85_000 });
    expect(await checkUsage(env as any)).toBe(1);
    expect(await checkUsage(env as any)).toBe(0); // same day, same metric: already told
    const notes = JSON.stringify((await call(dev, 'GET', '/me/notifications')).body);
    expect(notes).toContain('Worker requests is at 85%');
    resetUsageCache();
    g.__cf.graphql = raw({ requests: 85_000, written: 90_000 });
    expect(await checkUsage(env as any)).toBe(1); // a second metric is news
  });

  it('writes one counting data point per business request, and none for other routes', async () => {
    const points: any[] = [];
    const real = (env as any).ANALYTICS;
    (env as any).ANALYTICS = { writeDataPoint: (p: unknown) => points.push(p) };
    try {
      const org = await newOrg('Counted');
      await call(org.cookie, 'GET', `${org.base}/products`);
      await call(null, 'GET', '/health');
      expect(points.filter((p) => p.indexes[0] === org.orgId && p.blobs[0] === 'products')).toHaveLength(1);
      expect(points.every((p) => p.indexes[0] !== undefined)).toBe(true);
    } finally { (env as any).ANALYTICS = real; }
  });
});
