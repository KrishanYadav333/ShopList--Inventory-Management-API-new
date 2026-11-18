import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { remindOverdueCounts } from '../src/index';
import { addMember, call, defaultLocation, newOrg, product } from './helpers';

const day = (offset: number) => new Date(Date.now() + offset * 86400_000).toISOString().slice(0, 10);

describe('overdue count reminders', () => {
  it('tells the assignee about a count that is past due, and nobody about one that is not', async () => {
    const org = await newOrg('Late Co');
    const worker = await addMember(org, 'stock');
    await product(org);
    const loc = await defaultLocation(org);
    const mk = (title: string, dueAt: string) => call(org.cookie, 'POST', `${org.base}/count-tasks`, { title, locationId: loc, scope: { kind: 'all' }, assignedTo: worker.userId, dueAt });
    expect((await mk('Aisle 1', day(-3))).status).toBe(201);
    expect((await mk('Aisle 2', day(5))).status).toBe(201);
    const before = JSON.stringify((await call(worker.cookie, 'GET', '/me/notifications')).body);
    expect(before).not.toContain('Overdue');
    expect(await remindOverdueCounts(env as any)).toBeGreaterThanOrEqual(1);
    const notes = (await call(worker.cookie, 'GET', '/me/notifications')).body.data.filter((n: any) => n.kind === 'count.overdue');
    expect(notes).toHaveLength(1);
    expect(notes[0].title).toContain('Aisle 1');
    expect(notes[0].link).toBe(`/o/${org.orgId}/counts`);
  });

  it('respects the person\'s in-app switch, skips unassigned and submitted counts', async () => {
    const org = await newOrg('Late Co 2');
    const worker = await addMember(org, 'stock');
    await product(org);
    const loc = await defaultLocation(org);
    await call(worker.cookie, 'PATCH', '/me/notification-preferences', { orgId: org.orgId, kind: 'count.overdue', inApp: false });
    await call(org.cookie, 'POST', `${org.base}/count-tasks`, { title: 'Quiet', locationId: loc, scope: { kind: 'all' }, assignedTo: worker.userId, dueAt: day(-2) });
    await call(org.cookie, 'POST', `${org.base}/count-tasks`, { title: 'Nobody', locationId: loc, scope: { kind: 'all' }, dueAt: day(-2) });
    await remindOverdueCounts(env as any);
    expect((await call(worker.cookie, 'GET', '/me/notifications')).body.data.filter((n: any) => n.kind === 'count.overdue')).toHaveLength(0);
    expect((await call(org.cookie, 'GET', '/me/notifications')).body.data.filter((n: any) => n.kind === 'count.overdue')).toHaveLength(0);
  });
});
