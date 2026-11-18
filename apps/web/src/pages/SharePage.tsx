import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
import { api, ApiError } from '../api';
import { dateParts } from '../format';

interface Biz { name: string; address: string | null }
interface OrderData { business: Biz; currency: string; order: { number: string; state: string; paid: boolean; createdAt: string; shippedAt: string | null; taxMode: string; subtotalMinor: number; taxMinor: number; totalMinor: number; lines: { name: string; quantity: number; unitPriceMinor: number; lineMinor: number }[] } }
interface PoData { business: Biz; currency: string; po: { number: string; state: string; expectedAt: string | null; note: string | null; supplierName: string; createdAt: string; confirmedAt: string | null; dispatchedAt: string | null; supplierNote: string | null; lines: { sku: string; name: string; quantity: number; received: number; unitCostMinor: number }[]; totalMinor: number } }

const ORDER_STATE: Record<string, string> = { payment_required: 'Received, waiting for payment', waiting_for_stock: 'Paid, waiting for stock', ready_to_ship: 'Ready to ship', shipped: 'Shipped', cancelled: 'Cancelled' };

/** Public page for a customer (order status) or a supplier (purchase order), reached by a private link. No sign-in, no menus. */
export default function SharePage() {
  const { kind = '', token = '' } = useParams();
  const isOrder = kind === 'o';
  const path = `/s/${isOrder ? 'o' : 'po'}/${token}`;
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['share', path], queryFn: () => api<OrderData | PoData>('GET', path), retry: false });
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const act = useMutation({
    mutationFn: (what: 'confirm' | 'dispatched') => api('POST', `${path}/${what}`, { body: { note: note.trim() || undefined } }),
    onSuccess: () => { setError(''); setNote(''); qc.invalidateQueries({ queryKey: ['share', path] }); },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Something went wrong. Please try again.'),
  });

  if (q.isError) return <main className="auth"><div className="auth-card"><h1>This link is not valid</h1><p>{(q.error as ApiError).message}</p></div></main>;
  const d = q.data;
  if (!d) return <div className="boot">Loading…</div>;
  const money = (v: number) => new Intl.NumberFormat(undefined, { style: 'currency', currency: d.currency }).format(v / 100);
  const day = (iso: string) => dateParts(iso).date;

  return (
    <main className="invoice" id="main">
      <header>
        <h1>{d.business.name}</h1>
        {d.business.address && <p style={{ whiteSpace: 'pre-line' }}>{d.business.address}</p>}
      </header>
      {isOrder ? (() => {
        const o = (d as OrderData).order;
        return (
          <>
            <h2>Order {o.number}</h2>
            <p><strong>{ORDER_STATE[o.state] ?? o.state}</strong>{o.paid && o.state !== 'cancelled' ? ' · paid' : ''}</p>
            <p className="time">Placed {day(o.createdAt)}{o.shippedAt ? ` · shipped ${day(o.shippedAt)}` : ''}</p>
            <table className="orders-table">
              <caption className="sr-only">Items in this order</caption>
              <thead><tr><th scope="col">Item</th><th scope="col">Qty</th><th scope="col">Price</th><th scope="col">Total</th></tr></thead>
              <tbody>{o.lines.map((l, i) => <tr key={i}><td>{l.name}</td><td>{l.quantity}</td><td>{money(l.unitPriceMinor)}</td><td>{money(l.lineMinor)}</td></tr>)}</tbody>
            </table>
            {o.taxMode !== 'none' && <p>{o.taxMode === 'inclusive' ? 'Tax included' : 'Tax'}: {money(o.taxMinor)}</p>}
            <p><strong>Total {money(o.totalMinor)}</strong></p>
          </>
        );
      })() : (() => {
        const p = (d as PoData).po;
        const open = p.state === 'sent' || p.state === 'partially_received';
        return (
          <>
            <h2>Purchase order {p.number}</h2>
            <p>For {p.supplierName} · issued {day(p.createdAt)}{p.expectedAt ? ` · expected ${day(`${p.expectedAt}T00:00:00Z`)}` : ''}</p>
            {p.note && <p>Note: {p.note}</p>}
            <table className="orders-table">
              <caption className="sr-only">Items ordered</caption>
              <thead><tr><th scope="col">Code</th><th scope="col">Item</th><th scope="col">Qty</th><th scope="col">Unit cost</th><th scope="col">Received</th></tr></thead>
              <tbody>{p.lines.map((l, i) => <tr key={i}><td>{l.sku}</td><td>{l.name}</td><td>{l.quantity}</td><td>{money(l.unitCostMinor)}</td><td>{l.received}</td></tr>)}</tbody>
            </table>
            <p><strong>Total {money(p.totalMinor)}</strong></p>
            <section aria-labelledby="h-reply">
              <h3 id="h-reply">Your reply</h3>
              {p.confirmedAt && <p role="status">Confirmed {day(p.confirmedAt)}</p>}
              {p.dispatchedAt && <p role="status">Dispatched {day(p.dispatchedAt)}{p.supplierNote ? ` · ${p.supplierNote}` : ''}</p>}
              {open && !(p.confirmedAt && p.dispatchedAt) ? (
                <>
                  <div className="field"><label htmlFor="sh-note">Note for the buyer (optional, for example a tracking number)</label><input id="sh-note" maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} /></div>
                  {error && <p role="alert" className="field-error">{error}</p>}
                  <p>
                    {!p.confirmedAt && <button className="btn btn-primary" disabled={act.isPending} onClick={() => act.mutate('confirm')}>Confirm this order</button>}{' '}
                    {!p.dispatchedAt && <button className="btn btn-outline" disabled={act.isPending} onClick={() => act.mutate('dispatched')}>Mark as dispatched</button>}
                  </p>
                </>
              ) : !open ? <p>This order is no longer open. Please contact the buyer.</p> : null}
            </section>
          </>
        );
      })()}
    </main>
  );
}
