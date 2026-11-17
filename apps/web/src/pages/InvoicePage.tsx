import { useQuery } from '@tanstack/react-query';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import type { Customer, Order } from '@shoplist/shared';
import { api, ApiError } from '../api';
import { dateParts } from '../format';

interface Doc {
  type: 'invoice' | 'receipt';
  documentNumber: string;
  business: { name: string | null; address: string | null; phone: string | null; email: string | null; taxId: string | null; currency: string };
  order: Order;
  customer: Customer | null;
  lines: { name: string; sku: string; quantity: number; unitPriceMinor: number; taxRateBp: number; lineMinor: number; taxMinor: number }[];
}

/** A clean page for printing or "Save as PDF" from the browser. No PDF library, so the app stays small. */
export default function InvoicePage() {
  const { orgId = '', orderId = '' } = useParams();
  const [params] = useSearchParams();
  const type = params.get('type') === 'receipt' ? 'receipt' : 'invoice';
  const q = useQuery({ queryKey: ['document', orgId, orderId, type], queryFn: () => api<Doc>('GET', `/orgs/${orgId}/orders/${orderId}/document?type=${type}`) });
  if (q.isError) return <main className="auth"><div className="auth-card"><h1>Cannot show this</h1><p>{(q.error as ApiError).message}</p><Link className="btn btn-outline full" to={`/o/${orgId}/orders`}>Back to orders</Link></div></main>;
  const d = q.data;
  if (!d) return <div className="boot">Loading…</div>;
  const money = (v: number) => new Intl.NumberFormat(undefined, { style: 'currency', currency: d.business.currency }).format(v / 100);
  const date = dateParts(d.order.createdAt).date;
  const taxed = d.order.taxMode !== 'none';
  return (
    <main className="invoice">
      <div className="invoice-actions no-print">
        <Link className="btn btn-outline" to={`/o/${orgId}/orders`}>Back</Link>
        <button className="btn btn-primary" onClick={() => window.print()}>Print or save as PDF</button>
      </div>
      <header className="invoice-head">
        <div>
          <h1>{d.type === 'receipt' ? 'Receipt' : 'Invoice'}</h1>
          <div className="time">{d.documentNumber} · {date}</div>
        </div>
        <div className="invoice-from">
          <strong>{d.business.name ?? 'Your business'}</strong>
          {d.business.address && <div>{d.business.address}</div>}
          {d.business.phone && <div>{d.business.phone}</div>}
          {d.business.email && <div>{d.business.email}</div>}
          {d.business.taxId && <div>Tax id: {d.business.taxId}</div>}
        </div>
      </header>
      <section className="invoice-to">
        <div className="time">Billed to</div>
        <strong>{d.order.customerName}</strong>
        {d.customer?.address && <div>{d.customer.address}</div>}
        {(d.customer?.email ?? d.order.customerEmail) && <div>{d.customer?.email ?? d.order.customerEmail}</div>}
        {d.customer?.taxId && <div>Tax id: {d.customer.taxId}</div>}
        <div className="time">Order {d.order.number}</div>
      </section>
      <table className="orders-table">
        <thead><tr><th>Item</th><th className="num">Qty</th><th className="num">Unit price</th>{taxed && <th className="num">Tax</th>}<th className="num">Amount</th></tr></thead>
        <tbody>
          {d.lines.map((l, i) => (
            <tr key={i}><td>{l.name}<div className="time">{l.sku}</div></td><td className="num">{l.quantity}</td><td className="num">{money(l.unitPriceMinor)}</td>{taxed && <td className="num">{(l.taxRateBp / 100).toFixed(2)}%</td>}<td className="num">{money(l.lineMinor)}</td></tr>
          ))}
        </tbody>
        <tfoot>
          <tr><th colSpan={taxed ? 4 : 3} className="num">{d.order.taxMode === 'inclusive' ? 'Subtotal (tax included)' : 'Subtotal'}</th><th className="num">{money(d.order.subtotalMinor)}</th></tr>
          {taxed && <tr><th colSpan={4} className="num">{d.order.taxMode === 'inclusive' ? 'Of which tax' : 'Tax'}</th><th className="num">{money(d.order.taxMinor)}</th></tr>}
          <tr><th colSpan={taxed ? 4 : 3} className="num">Total</th><th className="num">{money(d.order.totalMinor)}</th></tr>
        </tfoot>
      </table>
      {d.type === 'receipt' && <p className="time">Paid in full. Thank you.</p>}
    </main>
  );
}
