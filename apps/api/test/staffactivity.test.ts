import { describe, expect, it } from 'vitest';
import { addMember, call, defaultLocation, newOrg, product } from './helpers';

describe('staff activity report', () => {
  it('counts what each person did, by name, and is for people who may read reports', async () => {
    const org = await newOrg('Activity Co');
    const stock = await addMember(org, 'stock');
    const sales = await addMember(org, 'sales');
    const p = await product(org);
    const loc = await defaultLocation(org);
    await call(stock.cookie, 'POST', `${org.base}/stock/movements`, { productId: p.id, locationId: loc, delta: 10, reason: 'receive' });
    await call(stock.cookie, 'POST', `${org.base}/stock/movements`, { productId: p.id, locationId: loc, delta: 5, reason: 'receive' });
    await call(sales.cookie, 'POST', `${org.base}/orders`, { customerName: 'Pat', lines: [{ productId: p.id, quantity: 1 }] });
    const r = await call(org.cookie, 'GET', `${org.base}/reports/staff-activity`);
    expect(r.status).toBe(200);
    expect(r.body.title).toBe('Staff activity');
    const byName = (email: string) => r.body.rows.find((x: any) => x.who === email.split('@')[0] || x.who === email);
    const mine = r.body.rows.find((x: any) => x.actor?.startsWith?.('usr_') && x.stock_moves === 2);
    expect(mine).toBeTruthy();
    expect(r.body.rows.some((x: any) => x.orders === 1)).toBe(true);
    expect(r.body.rows.some((x: any) => x.products === 1)).toBe(true); // the admin created the product
    expect(r.body.totals.total).toBeGreaterThanOrEqual(4);
    expect(r.body.rows.every((x: any) => typeof x.who === 'string' && !x.who.startsWith('usr_'))).toBe(true);
    void byName;
    const csv = await call(org.cookie, 'GET', `${org.base}/reports/staff-activity?format=csv`);
    expect(csv.headers.get('content-type')).toContain('text/csv');
    expect(csv.body).toContain('Person,Order actions');
    // A range with nothing in it is empty, not an error.
    expect((await call(org.cookie, 'GET', `${org.base}/reports/staff-activity?from=2020-01-01&to=2020-01-02`)).body.rows).toEqual([]);
    // Sales and stock roles cannot read reports.
    expect((await call(sales.cookie, 'GET', `${org.base}/reports/staff-activity`)).status).toBe(403);
  });
});
