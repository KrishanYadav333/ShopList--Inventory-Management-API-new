import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { backupOrg, BACKUP_KEEP_DAYS, readBackup, runBackups } from '../src/backups';
import { call, defaultLocation, loginAdmin, newOrg, product, uid } from './helpers';

async function busy() {
  const org = await newOrg('Backup Co');
  await call(org.cookie, 'PATCH', `${org.base}/settings`, { taxMode: 'exclusive', taxRateBp: 1000, legalName: 'Backup Company' });
  const a = await product(org, { sku: 'A-1', name: 'Alpha thing', costMinor: 100, tags: ['red'] });
  const b = await product(org, { sku: 'B-2', name: 'Beta thing' });
  const loc = await defaultLocation(org);
  await call(org.cookie, 'POST', `${org.base}/stock/movements`, { productId: a.id, locationId: loc, delta: 12, reason: 'receive' });
  await call(org.cookie, 'POST', `${org.base}/stock/movements`, { productId: b.id, locationId: loc, delta: 3, reason: 'receive' });
  const o = (await call(org.cookie, 'POST', `${org.base}/orders`, { customerName: 'Dana', customerEmail: 'dana@example.com', lines: [{ productId: a.id, quantity: 2 }] })).body.order;
  const sup = (await call(org.cookie, 'POST', `${org.base}/suppliers`, { name: 'Acme' })).body.supplier;
  await call(org.cookie, 'POST', `${org.base}/purchase-orders`, { supplierId: sup.id, locationId: loc, lines: [{ productId: b.id, quantity: 5, unitCostMinor: 90 }] });
  return { org, a, b, o };
}
const day = () => new Date().toISOString().slice(0, 10);

describe('nightly backups (F29, interim in D1)', () => {
  it('copies a business, compressed, and records size and rows', async () => {
    const { org } = await busy();
    const r = await backupOrg(env as any, org.orgId);
    expect(r.ok).toBe(true);
    const run = await env.DB.prepare(`SELECT * FROM backup_runs WHERE org_id = ?`).bind(org.orgId).first<any>();
    expect(run).toMatchObject({ day: day(), ok: 1, parts: 1 });
    expect(run.row_count).toBeGreaterThan(10);
    expect(run.size_bytes).toBe(r.bytes);
    const json = JSON.parse((await readBackup(env as any, org.orgId, day()))!);
    expect(json.format).toBe('shoplist-nightly');
    expect(json.tables.products).toHaveLength(2);
    expect(json.tables.products_fts).toBeUndefined();
    expect(json.tables.idempotency_keys).toBeUndefined();
  });

  it('a copy loaded into a new business gives the same products, stock, orders and settings, and a working search', async () => {
    const { org, a, o } = await busy();
    const dev = await loginAdmin();
    await backupOrg(env as any, org.orgId);
    const r = await call(dev, 'POST', `/admin/backups/${org.orgId}/${day()}/restore`, { adminEmail: `${uid()}-restored@example.com` });
    expect(r.status).toBe(201);
    expect(r.body.organization.name).toBe(`Backup Co (restored ${day()})`);
    expect(r.body.invitation.link).toContain('/invite/');
    const now = await call(dev, 'GET', `/admin/orgs/${r.body.organization.id}`);
    expect(now.body.counts).toMatchObject({ products: 2, openOrders: 1 });
    // The new business's admin signs in and accepts the invitation from the link.
    const email = (await env.DB.prepare(`SELECT email FROM invitations WHERE org_id = ?`).bind(r.body.organization.id).first<{ email: string }>())!.email;
    const cookie = await (await import('./helpers')).login(email);
    expect((await call(cookie, 'POST', `/invitations/${r.body.invitation.link.split('/').pop()}/accept`, {})).status).toBe(200);
    const base = `/orgs/${r.body.organization.id}`;
    const prods = await call(cookie, 'GET', `${base}/products`);
    expect(prods.body.data.map((p: any) => [p.sku, p.onHand]).sort()).toEqual([['A-1', 12], ['B-2', 3]]);
    expect((await call(cookie, 'GET', `${base}/products?q=Alpha`)).body.data).toHaveLength(1);
    const orders = await call(cookie, 'GET', `${base}/orders`);
    expect(orders.body.data[0]).toMatchObject({ number: o.number, customerName: 'Dana' });
    expect(orders.body.data[0].lines[0].quantity).toBe(2);
    expect((await call(cookie, 'GET', `${base}/settings`)).body.settings).toMatchObject({ taxMode: 'exclusive', taxRateBp: 1000, legalName: 'Backup Company' });
    expect((await call(cookie, 'GET', `${base}/products/${a.id}`)).body.product.tags).toEqual(['red']);
    expect((await call(cookie, 'GET', `${base}/purchase-orders`)).body.data).toHaveLength(1);
    // And it keeps working: a new product and order continue the numbering.
    expect((await call(cookie, 'POST', `${base}/products`, { sku: 'C-3', name: 'New', priceMinor: 5 })).status).toBe(201);
    const next = (await call(cookie, 'POST', `${base}/orders`, { customerName: 'Next', lines: [{ productId: a.id, quantity: 1 }] })).body.order;
    expect(Number(next.number.replace(/\D/g, ''))).toBe(Number(o.number.replace(/\D/g, '')) + 1);
    // The original is untouched.
    expect((await call(org.cookie, 'GET', `${org.base}/products`)).body.data).toHaveLength(2);
  });

  it('refuses to load into a business that already has data, and for unknown backups or days', async () => {
    const { org } = await busy();
    await backupOrg(env as any, org.orgId);
    const json = (await readBackup(env as any, org.orgId, day()))!;
    const run = runInDurableObject as unknown as (stub: unknown, fn: (inst: any) => unknown) => Promise<unknown>;
    const refused = await run((env as any).INVENTORY.get((env as any).INVENTORY.idFromName(org.orgId)), (inst) => { try { inst.restoreAll(json); return 'loaded'; } catch (e) { return (e as any).code; } });
    expect(refused).toBe('not_empty');
    const dev = await loginAdmin();
    expect((await call(dev, 'POST', `/admin/backups/${org.orgId}/2020-01-01/restore`, {})).status).toBe(404);
    expect((await call(dev, 'POST', `/admin/backups/${org.orgId}/yesterday/restore`, {})).status).toBe(400);
    expect((await call(dev, 'POST', '/admin/backups/org_nope/2026-01-01/restore', {})).status).toBe(404);
  });

  it('is for the owner only, shows metadata and never contents', async () => {
    const { org } = await busy();
    await backupOrg(env as any, org.orgId);
    expect((await call(org.cookie, 'GET', '/admin/backups')).status).toBe(404);
    expect((await call(org.cookie, 'POST', '/admin/backups/run', {})).status).toBe(404);
    const r = await call(await loginAdmin(), 'GET', '/admin/backups');
    const mine = r.body.data.find((x: any) => x.orgId === org.orgId);
    expect(mine).toMatchObject({ name: 'Backup Co', ok: true, day: day() });
    expect(mine.days).toContain(day());
    expect(JSON.stringify(r.body)).not.toContain('Alpha');
    expect(JSON.stringify(r.body)).not.toContain('dana@example.com');
  });

  it('the owner can run one business now, and a failure is recorded, not thrown', async () => {
    const { org } = await busy();
    const dev = await loginAdmin();
    expect((await call(dev, 'POST', '/admin/backups/run', { orgId: org.orgId })).body).toEqual({ ok: 1, failed: 0 });
    expect((await call(dev, 'POST', '/admin/backups/run', { orgId: 'org_nope' })).status).toBe(404);
    const stub = { INVENTORY: { idFromName: () => 'x', get: () => ({ dumpAll: () => { throw new Error('boom'); } }) }, DB: env.DB } as any;
    const bad = await backupOrg(stub, 'org_broken', '2026-01-02');
    expect(bad.ok).toBe(false);
    expect(await env.DB.prepare(`SELECT ok, error FROM backup_runs WHERE org_id = 'org_broken'`).first()).toEqual({ ok: 0, error: 'boom' });
  });

  it('keeps 30 days and removes older copies; deleted businesses are not copied', async () => {
    const { org } = await busy();
    const old = new Date(Date.now() - (BACKUP_KEEP_DAYS + 2) * 86400_000).toISOString().slice(0, 10);
    await env.DB.prepare(`INSERT INTO backups(org_id, day, part, data) VALUES (?, ?, 0, x'00')`).bind(org.orgId, old).run();
    await env.DB.prepare(`INSERT INTO backup_runs(org_id, day, ok, created_at) VALUES (?, ?, 1, ?)`).bind(org.orgId, old, new Date().toISOString()).run();
    const gone = await newOrg('Gone Co');
    await env.DB.prepare(`UPDATE organizations SET deleted_at = ? WHERE id = ?`).bind(new Date().toISOString(), gone.orgId).run();
    await runBackups(env as any);
    expect(await env.DB.prepare(`SELECT 1 AS x FROM backups WHERE org_id = ? AND day = ?`).bind(org.orgId, old).first()).toBeNull();
    expect(await env.DB.prepare(`SELECT 1 AS x FROM backups WHERE org_id = ? AND day = ?`).bind(org.orgId, day()).first()).not.toBeNull();
    expect(await env.DB.prepare(`SELECT 1 AS x FROM backup_runs WHERE org_id = ?`).bind(gone.orgId).first()).toBeNull();
  });
});
