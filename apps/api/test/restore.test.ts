import { describe, expect, it } from 'vitest';
import { BACKUP_FORMAT, parseBackup } from '@shoplist/shared';
import { call, defaultLocation, newOrg, product, uid } from './helpers';

const file = (over: Record<string, unknown> = {}) => ({
  format: BACKUP_FORMAT, version: 1, organization: { id: 'org_old', name: 'Old Co' },
  locations: [{ id: 'loc_1', name: 'Main', code: 'main' }, { name: 'Shed', code: 'shed' }],
  products: [
    { id: 'prd_1', sku: 'A-1', name: 'Alpha', priceMinor: 500, costMinor: 200, onHand: 7, tags: ['x'], unit: 'each', description: null, barcode: null, reorderPoint: 2, deletedAt: null },
    { id: 'prd_2', sku: 'B-2', name: 'Beta', priceMinor: 900, costMinor: null, onHand: 0, tags: [], deletedAt: null },
  ],
  ...over,
});

describe('restore from a backup file (F26)', () => {
  it('reads a backup into locations and rows, keeping only what an import accepts', () => {
    const r = parseBackup(file());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.backup.fromName).toBe('Old Co');
    expect(r.backup.locations).toEqual([{ name: 'Main', code: 'MAIN' }, { name: 'Shed', code: 'SHED' }]);
    expect(r.backup.rows[0]).toMatchObject({ sku: 'A-1', name: 'Alpha', priceMinor: 500, costMinor: 200, quantity: 7, tags: ['x'], reorderPoint: 2 });
    expect(r.backup.rows).toHaveLength(2);
  });

  it('skips deleted, duplicate and invalid products and says why; accepts files from before the format marker', () => {
    const r = parseBackup({ products: [
      { sku: 'OK', name: 'Fine', priceMinor: 1, onHand: -3 },
      { sku: 'OK', name: 'Again', priceMinor: 1 },
      { sku: 'GONE', name: 'Deleted', priceMinor: 1, deletedAt: '2026-01-01' },
      { sku: 'BAD', name: '', priceMinor: 1 },
      { sku: 'NEG', name: 'Neg', priceMinor: -5 },
      'nonsense',
    ] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.backup.rows.map((x) => [x.sku, x.quantity])).toEqual([['OK', 0]]);
    expect(r.backup.skipped.map((s) => s.sku)).toEqual(['OK', 'BAD', 'NEG', '(no code)']);
  });

  it('refuses things that are not backups, or are from a newer version', () => {
    for (const bad of [null, 'x', [], {}, { products: 'no' }, { format: 'other', products: [] }]) expect(parseBackup(bad).ok, JSON.stringify(bad)).toBe(false);
    const newer = parseBackup(file({ version: 2 }));
    expect(newer.ok).toBe(false);
    if (!newer.ok) expect(newer.error).toContain('newer version');
  });

  it('does not trust the file: unknown fields and wrong types never get through', () => {
    const r = parseBackup(file({ products: [{ sku: 'S', name: 'N', priceMinor: 1, onHand: 'lots', costMinor: 'free', isAdmin: true }] }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.backup.rows).toEqual([]);
    expect(r.backup.skipped[0].sku).toBe('S');
    const ok = parseBackup(file({ products: [{ sku: 'S', name: 'N', priceMinor: 1, isAdmin: true, role: 'admin' }] }));
    if (ok.ok) expect(JSON.stringify(ok.backup.rows)).not.toContain('isAdmin');
  });

  it('restoring through the import route recreates products and quantities, updates matching codes, and is repeatable', async () => {
    const org = await newOrg('Restore Co');
    const existing = await product(org, { sku: 'A-1', name: 'Old name', priceMinor: 1 });
    const r = parseBackup(file());
    if (!r.ok) throw new Error('parse');
    const send = () => call(org.cookie, 'POST', `${org.base}/products/import`, { mode: 'upsert', rows: r.backup.rows }, { 'idempotency-key': uid() });
    const res = await send();
    expect(res.status).toBe(200);
    expect(res.body.results.map((x: { status: string }) => x.status)).toEqual(['updated', 'created']);
    const a = (await call(org.cookie, 'GET', `${org.base}/products/${existing.id}`)).body.product;
    expect(a).toMatchObject({ name: 'Alpha', priceMinor: 500, onHand: 7 });
    // The ledger explains the quantity.
    const loc = await defaultLocation(org);
    const mv = await call(org.cookie, 'GET', `${org.base}/stock/movements?productId=${existing.id}`);
    expect(JSON.stringify(mv.body)).toContain('import');
    expect(loc).toBeTruthy();
    // Restoring the same file again changes nothing.
    expect((await send()).body.results.map((x: { status: string }) => x.status)).toEqual(['unchanged', 'unchanged']);
  });
});
