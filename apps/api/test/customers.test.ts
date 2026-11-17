import { describe, expect, it } from 'vitest';
import { addMember, call, newOrg, product, stub } from './helpers';

async function shop(tax?: Record<string, unknown>) {
  const admin = await newOrg();
  if (tax) {
    const full = (await call(admin.cookie, 'GET', `${admin.base}/settings`)).body.settings;
    expect((await call(admin.cookie, 'PATCH', `${admin.base}/settings`, { ...full, ...tax })).status).toBe(200);
  }
  const p = await product(admin, { sku: 'T-1', name: 'Taxable', priceMinor: 1000, costMinor: 400, initialQuantity: 20 });
  const q = await product(admin, { sku: 'T-2', name: 'Other', priceMinor: 333, costMinor: 100, initialQuantity: 20 });
  const order = (over: Record<string, unknown> = {}) => call(admin.cookie, 'POST', `${admin.base}/orders`, { customerName: 'Dana', customerEmail: 'dana@example.com', lines: [{ productId: p.id, quantity: 2 }, { productId: q.id, quantity: 3 }], ...over });
  return { admin, p, q, order };
}

describe('F16 tax', () => {
  it('no tax by default', async () => {
    const { order } = await shop();
    const o = (await order()).body.order;
    expect(o).toMatchObject({ subtotalMinor: 2999, taxMinor: 0, totalMinor: 2999, taxMode: 'none' });
  });

  it('tax added on top: rounded half up per line, total = subtotal + tax', async () => {
    const { order } = await shop({ taxMode: 'exclusive', taxRateBp: 1300 });
    const o = (await order()).body.order;
    // 2000 -> 260.00 ; 999 -> 129.87 -> 130 (half up per line)
    expect(o).toMatchObject({ subtotalMinor: 2999, taxMinor: 260 + 130, totalMinor: 2999 + 390, taxMode: 'exclusive' });
  });

  it('prices that include tax: tax is inside the price, total does not change', async () => {
    const { order } = await shop({ taxMode: 'inclusive', taxRateBp: 1300 });
    const o = (await order()).body.order;
    // 2000*1300/11300 = 230.09 -> 230 ; 999*1300/11300 = 114.93 -> 115
    expect(o).toMatchObject({ subtotalMinor: 2999, taxMinor: 230 + 115, totalMinor: 2999, taxMode: 'inclusive' });
  });

  it('an order keeps the tax it was made with, even after the settings change', async () => {
    const { admin, order } = await shop({ taxMode: 'exclusive', taxRateBp: 1000 });
    const o = (await order()).body.order;
    const full = (await call(admin.cookie, 'GET', `${admin.base}/settings`)).body.settings;
    await call(admin.cookie, 'PATCH', `${admin.base}/settings`, { ...full, taxMode: 'none', taxRateBp: 0 });
    const again = (await call(admin.cookie, 'GET', `${admin.base}/orders/${o.id}`)).body.order;
    expect(again).toMatchObject({ taxMinor: o.taxMinor, totalMinor: o.totalMinor, taxMode: 'exclusive' });
    expect(await stub(admin.orgId).verifyIntegrity()).toEqual({ ok: true, drift: [] });
  });
});

describe('F16 customers', () => {
  it('orders create the customer by email once, and a customer page shows their history', async () => {
    const { admin, order } = await shop();
    const first = (await order()).body.order;
    const second = (await order({ customerName: 'Dana S.', customerEmail: 'DANA@example.com' })).body.order;
    expect(second.customerId).toBe(first.customerId); // same person, different case
    const list = await call(admin.cookie, 'GET', `${admin.base}/customers`);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0]).toMatchObject({ email: 'dana@example.com', orders: 2, spentMinor: 2 * 2999 });
    const one = await call(admin.cookie, 'GET', `${admin.base}/customers/${first.customerId}`);
    expect(one.body.orders).toHaveLength(2);
    expect((await call(admin.cookie, 'GET', `${admin.base}/customers?q=dana`)).body.data).toHaveLength(1);
    expect((await call(admin.cookie, 'GET', `${admin.base}/customers?q=zzz`)).body.data).toHaveLength(0);
  });

  it('can be added by hand, chosen on an order, edited and archived; duplicate emails are refused', async () => {
    const { admin, order } = await shop();
    const made = await call(admin.cookie, 'POST', `${admin.base}/customers`, { name: 'Walk-in Wes', phone: '555', email: 'wes@example.com' });
    expect(made.status).toBe(201);
    expect((await call(admin.cookie, 'POST', `${admin.base}/customers`, { name: 'Other Wes', email: 'WES@example.com' })).status).toBe(409);
    const o = (await order({ customerName: 'Wes', customerEmail: undefined, customerId: made.body.customer.id })).body.order;
    expect(o.customerId).toBe(made.body.customer.id);
    expect((await call(admin.cookie, 'PATCH', `${admin.base}/customers/${made.body.customer.id}`, { phone: '999', taxId: 'T-1' })).body.customer).toMatchObject({ phone: '999', taxId: 'T-1' });
    await call(admin.cookie, 'PATCH', `${admin.base}/customers/${made.body.customer.id}`, { archived: true });
    expect((await order({ customerId: made.body.customer.id })).status).toBe(404); // archived customers cannot be used
    expect((await call(admin.cookie, 'GET', `${admin.base}/customers`)).body.data.map((c: { id: string }) => c.id)).not.toContain(made.body.customer.id);
  });

  it('contact details are for sales, accountants, managers and admins; stock keepers and viewers keep the name only', async () => {
    const { admin, order } = await shop();
    const o = (await order()).body.order;
    const withContact = [await addMember(admin, 'sales'), await addMember(admin, 'accountant'), await addMember(admin, 'manager')];
    const without = [await addMember(admin, 'stock'), await addMember(admin, 'viewer')];
    for (const w of withContact) {
      expect((await call(w.cookie, 'GET', `${admin.base}/orders/${o.id}`)).body.order.customerEmail).toBe('dana@example.com');
      expect((await call(w.cookie, 'GET', `${admin.base}/customers`)).status).toBe(200);
    }
    for (const w of without) {
      const seen = await call(w.cookie, 'GET', `${admin.base}/orders/${o.id}`);
      expect(seen.body.order.customerName).toBe('Dana');
      expect(JSON.stringify(seen.body)).not.toContain('dana@example.com');
      expect(JSON.stringify((await call(w.cookie, 'GET', `${admin.base}/orders`)).body)).not.toContain('dana@example.com');
      expect((await call(w.cookie, 'GET', `${admin.base}/customers`)).status).toBe(403);
      expect((await call(w.cookie, 'GET', `${admin.base}/orders/${o.id}/document`)).status).toBe(403);
    }
    expect((await call(withContact[1].cookie, 'POST', `${admin.base}/customers`, { name: 'No' })).status).toBe(403); // accountants read only
  });
});

describe('F16 invoices and receipts', () => {
  it('the document carries the business, the customer, the lines and totals that match the order', async () => {
    const { admin, order } = await shop({ taxMode: 'exclusive', taxRateBp: 1300, legalName: 'Acme Pvt Ltd', taxId: 'GST-77', invoicePrefix: 'INV-' });
    const o = (await order({ paid: true })).body.order;
    const d = (await call(admin.cookie, 'GET', `${admin.base}/orders/${o.id}/document?type=invoice`)).body;
    expect(d.documentNumber).toBe(`INV-${o.number.replace(/^\D+/, '')}`);
    expect(d.business).toMatchObject({ name: 'Acme Pvt Ltd', taxId: 'GST-77' });
    expect(d.customer.email).toBe('dana@example.com');
    expect(d.lines.reduce((a: number, l: { lineMinor: number }) => a + l.lineMinor, 0)).toBe(o.subtotalMinor);
    expect(d.lines.reduce((a: number, l: { taxMinor: number }) => a + l.taxMinor, 0)).toBe(o.taxMinor);
    expect(d.order.totalMinor).toBe(o.totalMinor);
    const r = (await call(admin.cookie, 'GET', `${admin.base}/orders/${o.id}/document?type=receipt`)).body;
    expect(r.documentNumber).toMatch(/^RCT-/);
  });

  it('a receipt needs a paid order', async () => {
    const { admin, order } = await shop();
    const o = (await order()).body.order;
    expect((await call(admin.cookie, 'GET', `${admin.base}/orders/${o.id}/document?type=receipt`)).status).toBe(409);
    expect((await call(admin.cookie, 'GET', `${admin.base}/orders/${o.id}/document?type=invoice`)).status).toBe(200);
  });
});
