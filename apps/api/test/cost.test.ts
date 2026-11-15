import { describe, expect, it } from 'vitest';
import { addMember, call, defaultLocation, newOrg, product } from './helpers';

const FORBIDDEN = ['costMinor', 'inventoryValueMinor'];

describe('cost visibility', () => {
  it('only roles with cost:read ever receive cost or inventory value, from any product-returning route', async () => {
    const admin = await newOrg();
    const p = await product(admin, { costMinor: 700 });
    const loc = await defaultLocation(admin);
    await call(admin.cookie, 'POST', `${admin.base}/stock/movements`, { productId: p.id, locationId: loc, delta: 5, reason: 'receive' });
    const paths = [
      `${admin.base}/products`,
      `${admin.base}/products/${p.id}`,
      `${admin.base}/products/lookup?code=${encodeURIComponent(p.sku)}`,
      `${admin.base}/dashboard`,
    ];
    const withCost = [admin, await addMember(admin, 'manager')];
    const without = [await addMember(admin, 'sales'), await addMember(admin, 'stock'), await addMember(admin, 'viewer')];

    for (const who of withCost) {
      const bodies = await Promise.all(paths.map((path) => call(who.cookie, 'GET', path)));
      expect(JSON.stringify(bodies.map((b) => b.body))).toContain('costMinor');
      expect(JSON.stringify(bodies.map((b) => b.body))).toContain('inventoryValueMinor');
    }
    for (const who of without) {
      for (const path of paths) {
        const r = await call(who.cookie, 'GET', path);
        expect(r.status, path).toBe(200);
        for (const f of FORBIDDEN) expect(JSON.stringify(r.body), `${path} ${f}`).not.toContain(f);
      }
    }
  });
});
