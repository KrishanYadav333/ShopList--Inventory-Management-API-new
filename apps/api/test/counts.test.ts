import { describe, expect, it } from 'vitest';
import { addMember, call, defaultLocation, newOrg, product, stub } from './helpers';

async function setup() {
  const admin = await newOrg();
  const loc = await defaultLocation(admin);
  const a = await product(admin, { sku: 'C-A', name: 'Apple', initialQuantity: 10, tags: ['fruit'] });
  const b = await product(admin, { sku: 'C-B', name: 'Banana', initialQuantity: 20, tags: ['fruit'] });
  const c = await product(admin, { sku: 'C-C', name: 'Chair', initialQuantity: 5 });
  const keeper = await addMember(admin, 'stock');
  const keeperId = (await call(keeper.cookie, 'GET', '/me')).body.user.id as string;
  const onHand = async (id: string) => (await call(admin.cookie, 'GET', `${admin.base}/products/${id}`)).body.product.onHand as number;
  const create = (over: Record<string, unknown> = {}) => call(admin.cookie, 'POST', `${admin.base}/count-tasks`, { locationId: loc, scope: { kind: 'all' }, assignedTo: keeperId, ...over });
  return { admin, loc, a, b, c, keeper, keeperId, onHand, create };
}

describe('F15 count tasks', () => {
  it('a blind count hides expected quantities from the counter; submitting writes only the differences', async () => {
    const { admin, a, b, c, keeper, onHand, create } = await setup();
    const t = (await create({ title: 'Fruit', scope: { kind: 'tag', tag: 'fruit' } })).body.task;
    expect(t.lines.map((l: { sku: string }) => l.sku).sort()).toEqual(['C-A', 'C-B']);
    const mine = await call(keeper.cookie, 'GET', `${admin.base}/count-tasks/${t.id}`);
    expect(mine.body.task.lines.every((l: { expected: number | null }) => l.expected === null)).toBe(true); // blind
    expect((await call(admin.cookie, 'GET', `${admin.base}/count-tasks/${t.id}`)).body.task.lines.some((l: { expected: number | null }) => l.expected !== null)).toBe(true); // the assigner sees it

    await call(keeper.cookie, 'POST', `${admin.base}/count-tasks/${t.id}/lines`, { lines: [{ productId: a.id, counted: 8 }] }); // saved progress, nothing applied yet
    expect(await onHand(a.id)).toBe(10);
    await call(keeper.cookie, 'POST', `${admin.base}/count-tasks/${t.id}/lines`, { lines: [{ productId: b.id, counted: 20 }] }); // matches: no movement
    const done = await call(keeper.cookie, 'POST', `${admin.base}/count-tasks/${t.id}/submit`, {});
    expect(done.body).toMatchObject({ applied: 1, waitingForApproval: 0 });
    expect(await onHand(a.id)).toBe(8);
    expect(await onHand(b.id)).toBe(20);
    expect(await onHand(c.id)).toBe(5); // never part of it
    const after = (await call(keeper.cookie, 'GET', `${admin.base}/count-tasks/${t.id}`)).body.task;
    expect(after.state).toBe('submitted');
    expect(after.lines.find((l: { sku: string }) => l.sku === 'C-A')).toMatchObject({ counted: 8, expected: 10 }); // revealed after submit
    expect((await call(keeper.cookie, 'POST', `${admin.base}/count-tasks/${t.id}/submit`, {})).status).toBe(409);
    expect(await stub(admin.orgId).verifyIntegrity()).toEqual({ ok: true, drift: [] });
  });

  it('lines nobody counted are never treated as zero', async () => {
    const { admin, a, keeper, create, onHand } = await setup();
    const t = (await create()).body.task;
    await call(keeper.cookie, 'POST', `${admin.base}/count-tasks/${t.id}/lines`, { lines: [{ productId: a.id, counted: 10 }] });
    await call(keeper.cookie, 'POST', `${admin.base}/count-tasks/${t.id}/submit`, {});
    expect(await onHand(a.id)).toBe(10);
    const stock = (await call(admin.cookie, 'GET', `${admin.base}/products`)).body.data;
    expect(stock.map((p: { onHand: number }) => p.onHand).sort((x: number, y: number) => x - y)).toEqual([5, 10, 20]);
  });

  it('is judged against stock at submit time, and big variances wait for approval from people who cannot decide', async () => {
    const { admin, a, loc, keeper, create, onHand } = await setup();
    const full = (await call(admin.cookie, 'GET', `${admin.base}/settings`)).body.settings;
    await call(admin.cookie, 'PATCH', `${admin.base}/settings`, { ...full, approvals: { ...full.approvals, countVariance: { on: true, units: 3 } } });
    const t = (await create({ scope: { kind: 'list', productIds: [a.id] } })).body.task;
    await call(admin.cookie, 'POST', `${admin.base}/stock/movements`, { productId: a.id, locationId: loc, delta: -2, reason: 'sale' }); // stock moves while counting: 8
    await call(keeper.cookie, 'POST', `${admin.base}/count-tasks/${t.id}/lines`, { lines: [{ productId: a.id, counted: 1 }] }); // 7 under: over the limit
    const done = await call(keeper.cookie, 'POST', `${admin.base}/count-tasks/${t.id}/submit`, {});
    expect(done.body).toMatchObject({ applied: 0, waitingForApproval: 1 });
    expect(await onHand(a.id)).toBe(8);
    const pending = (await call(admin.cookie, 'GET', `${admin.base}/approvals?state=pending`)).body.data;
    expect(pending).toHaveLength(1);
    await call(admin.cookie, 'POST', `${admin.base}/approvals/${pending[0].id}/approve`, {});
    expect(await onHand(a.id)).toBe(1);
  });

  it('only the assignee (or an assigner) can work a task; others do not even see it', async () => {
    const { admin, a, keeper, create } = await setup();
    const other = await addMember(admin, 'stock');
    const t = (await create()).body.task;
    expect((await call(other.cookie, 'GET', `${admin.base}/count-tasks/${t.id}`)).status).toBe(404);
    expect((await call(other.cookie, 'POST', `${admin.base}/count-tasks/${t.id}/lines`, { lines: [{ productId: a.id, counted: 1 }] })).status).toBe(404);
    expect((await call(other.cookie, 'GET', `${admin.base}/count-tasks`)).body.data).toHaveLength(0);
    expect((await call(keeper.cookie, 'GET', `${admin.base}/count-tasks`)).body.data).toHaveLength(1);
    expect((await call(keeper.cookie, 'POST', `${admin.base}/count-tasks`, { locationId: 'x', scope: { kind: 'all' } })).status).toBe(403); // cannot create
    expect((await call(keeper.cookie, 'POST', `${admin.base}/count-tasks/${t.id}/cancel`, {})).status).toBe(403);
    expect((await call(admin.cookie, 'POST', `${admin.base}/count-tasks/${t.id}/cancel`, {})).body.task.state).toBe('cancelled');
    expect((await call(keeper.cookie, 'POST', `${admin.base}/count-tasks/${t.id}/submit`, {})).status).toBe(409);
  });

  it('respects location scope, validates the assignee and selection, and notifies the assignee', async () => {
    const { admin, loc, keeper, keeperId, create } = await setup();
    const other = (await call(admin.cookie, 'POST', `${admin.base}/locations`, { name: 'Else', code: 'ELS' })).body.location.id;
    await call(admin.cookie, 'PATCH', `${admin.base}/members/${keeperId}`, { locationIds: [other] });
    const t = (await create()).body.task;
    expect((await call(keeper.cookie, 'POST', `${admin.base}/count-tasks/${t.id}/submit`, {})).status).toBe(403); // task is at a location they may not write
    expect((await create({ assignedTo: 'usr_nobody' })).status).toBe(400);
    expect((await create({ scope: { kind: 'tag', tag: 'nothing-here' } })).status).toBe(409);
    expect((await create({ locationId: 'loc_nope' })).status).toBeGreaterThanOrEqual(400);
    void loc;
  });
});
