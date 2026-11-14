import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { Order, OrderState } from '@shoplist/shared';
import { api, ApiError } from '../api';
import { useShell } from '../components/Shell';
import { dateParts, money } from '../format';
import { Icon } from '../icons';
import { canWrite, useOrders } from '../queries';
import { useToast } from '../toast';

const LABEL: Record<OrderState, [string, string]> = {
  payment_required: ['pay', 'Payment required'],
  waiting_for_stock: ['low', 'Waiting for stock'],
  ready_to_ship: ['ready', 'Ready to ship'],
  shipped: ['off', 'Shipped'],
  cancelled: ['warn', 'Cancelled'],
};
const ICON: Record<string, [string, string]> = {
  shopify: ['shopify', 'S'], amazon: ['amazon', 'a'], ebay: ['ebay', 'e'], woocommerce: ['woocommerce', 'W'], magento: ['magento', 'M'], phone: ['phone', '☎'], manual: ['phone', 'M'], other: ['phone', '?'],
};
const TITLE: Record<string, string> = { payment_required: 'Payment required', waiting_for_stock: 'Waiting for stock', ready_to_ship: 'Ready to ship', shipped: 'Shipped', cancelled: 'Cancelled' };

export function OrdersPage() {
  const { org, openOrder } = useShell();
  const toast = useToast();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const [text, setText] = useState(params.get('q') ?? '');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [printing, setPrinting] = useState<Order[] | null>(null);
  const write = canWrite(org.role);
  const state = (params.get('state') as OrderState | null) ?? undefined;

  useEffect(() => {
    const t = setTimeout(() => {
      const next = new URLSearchParams(params);
      if (text.trim()) next.set('q', text.trim()); else next.delete('q');
      if (next.toString() !== params.toString()) setParams(next, { replace: true });
    }, 200);
    return () => clearTimeout(t);
  }, [text]); // eslint-disable-line react-hooks/exhaustive-deps

  const query = useOrders(org.id, { q: params.get('q') ?? undefined, state });
  const rows = useMemo(() => query.data?.pages.flatMap((p) => p.data) ?? [], [query.data]);
  const refresh = () => qc.invalidateQueries({ queryKey: ['org', org.id] });
  const fail = (e: ApiError) => toast({ kind: 'error', text: e.message });

  const act = useMutation({
    mutationFn: (v: { o: Order; what: 'ship' | 'cancel' | 'paid'; paid?: boolean; done: string }) =>
      api<{ order: Order }>('POST', `/orgs/${org.id}/orders/${v.o.id}/${v.what}`, { body: v.what === 'paid' ? { paid: v.paid } : {}, ifMatch: v.o.version }).then(() => v.done),
    onSuccess: (done) => { refresh(); toast({ kind: 'success', text: done }); },
    onError: (e: ApiError) => { fail(e); refresh(); },
  });

  const readySelected = rows.filter((o) => selected.has(o.id) && o.state === 'ready_to_ship');
  const bulkShip = useMutation({
    mutationFn: async () => {
      let shipped = 0;
      for (const o of readySelected) { await api('POST', `/orgs/${org.id}/orders/${o.id}/ship`, { body: {}, ifMatch: o.version }); shipped++; }
      return shipped;
    },
    onSuccess: (n) => { setSelected(new Set()); refresh(); toast({ kind: 'success', text: `Shipped ${n} order${n === 1 ? '' : 's'}` }); },
    onError: (e: ApiError) => { fail(e); refresh(); },
  });

  // Print a pick list for the selected orders (or all ready orders) through the browser's print dialog.
  useEffect(() => {
    if (!printing) return;
    const done = () => setPrinting(null);
    addEventListener('afterprint', done, { once: true });
    const t = setTimeout(() => window.print(), 50);
    return () => { clearTimeout(t); removeEventListener('afterprint', done); };
  }, [printing]);

  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const printable = selected.size ? rows.filter((o) => selected.has(o.id)) : rows.filter((o) => o.state === 'ready_to_ship');
  const empty = !state && !params.get('q');

  return (
    <>
      <header className="top-header">
        <div className="breadcrumb"><span>Orders</span><Icon name="chevron" size={12} /><h1 className="current">{state ? TITLE[state] : 'All orders'}</h1></div>
        <div className="header-actions">
          <div className="search-container">
            <input className="search-input" type="search" placeholder="Search order or customer…" aria-label="Search orders" value={text} onChange={(e) => setText(e.target.value)} />
            <Icon name="search" />
          </div>
          {write && <button className="btn btn-primary" onClick={openOrder}><Icon name="plus" size={14} /> New</button>}
          {write && <button className="btn btn-ghost" disabled={!readySelected.length || bulkShip.isPending} onClick={() => { if (confirm(`Ship ${readySelected.length} order${readySelected.length === 1 ? '' : 's'}? Stock is removed from inventory.`)) bulkShip.mutate(); }}><Icon name="truck" size={14} /> {readySelected.length ? `Ship ${readySelected.length}` : 'Ship'}</button>}
          <button className="btn btn-ghost" disabled={!printable.length} onClick={() => setPrinting(printable)}><Icon name="printer" size={14} /> Print</button>
        </div>
      </header>

      <div className="orders-table-container">
        {query.isError ? (
          <div className="state"><Icon name="alert" size={28} /><h3>Could not load orders</h3><p>{(query.error as ApiError).message}</p><button className="btn btn-primary" onClick={() => query.refetch()}>Try again</button></div>
        ) : query.isLoading || (rows.length === 0 && query.isFetching) ? (
          <table className="orders-table" aria-busy="true"><tbody>{Array.from({ length: 8 }, (_, i) => <tr key={i} className="skeleton-row"><td colSpan={8}><div className="skeleton" /></td></tr>)}</tbody></table>
        ) : rows.length === 0 ? (
          <div className="state">
            <Icon name="cart" size={32} />
            {empty ? (<><h3>No orders yet</h3><p>Orders hold stock for a customer. Create one, then ship it to turn the held stock into a sale.</p>{write && <button className="btn btn-primary" onClick={openOrder}><Icon name="plus" size={14} /> New order</button>}</>)
              : (<><h3>No orders match</h3><p>Try another status or search.</p><button className="btn btn-primary" onClick={() => { setText(''); setParams({}, { replace: true }); }}>Clear filters</button></>)}
          </div>
        ) : (
          <>
            <table className="orders-table orders-list">
              <thead>
                <tr>
                  <th className="checkbox-col"><input type="checkbox" aria-label="Select all" checked={allSelected} onChange={() => setSelected(allSelected ? new Set() : new Set(rows.map((r) => r.id)))} /></th>
                  <th className="icon-col" /><th>Date</th><th>Status</th><th>Order items</th><th>Customer</th><th className="country-col">Country</th><th className="actions-col" />
                </tr>
              </thead>
              <tbody>
                {rows.map((o) => {
                  const { date, time } = dateParts(o.createdAt);
                  const [cls, label] = LABEL[o.state];
                  const [iconCls, letter] = ICON[o.channel] ?? ICON.other;
                  const open = o.state === 'payment_required' || o.state === 'waiting_for_stock' || o.state === 'ready_to_ship';
                  return (
                    <tr key={o.id}>
                      <td className="checkbox-col"><input type="checkbox" aria-label={`Select ${o.number}`} checked={selected.has(o.id)} onChange={() => setSelected((s) => { const n = new Set(s); if (n.has(o.id)) n.delete(o.id); else n.add(o.id); return n; })} /></td>
                      <td className="icon-col"><div className={`order-icon ${iconCls}`} title={o.channel}>{letter}</div></td>
                      <td className="date-col"><div className="date">{date}</div><div className="time">{time}</div></td>
                      <td className="status-col"><span className={`status ${cls}`}>{label}</span></td>
                      <td className="items-col">
                        <div className="order-id">{o.number} <span className="time">· {money(o.totalMinor, org.currency)}</span></div>
                        <div className="item-desc">
                          {o.lines.map((l) => <div key={l.id}>{l.quantity} x {l.name}{open && l.reserved < l.quantity && <span className="short"> ({l.reserved} of {l.quantity} in stock)</span>}</div>)}
                        </div>
                      </td>
                      <td className="customer-col"><div className="customer-name">{o.customerName}</div></td>
                      <td className="country-col">{o.country ?? ''}</td>
                      <td className="actions-col row-actions">
                        {write && o.state === 'payment_required' && <button className="btn btn-outline cell-btn" onClick={() => act.mutate({ o, what: 'paid', paid: true, done: `${o.number} marked paid` })}>Mark paid</button>}
                        {write && o.state === 'ready_to_ship' && <button className="btn btn-primary cell-btn" onClick={() => act.mutate({ o, what: 'ship', done: `${o.number} shipped` })}>Ship</button>}
                        {write && open && <button className="icon-btn" title="Cancel order" aria-label={`Cancel ${o.number}`} onClick={() => { if (confirm(`Cancel ${o.number}? Its held stock is released.`)) act.mutate({ o, what: 'cancel', done: `${o.number} cancelled` }); }}><Icon name="x" size={16} /></button>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div className="table-foot">
              <span>{rows.length} order{rows.length === 1 ? '' : 's'}{query.hasNextPage ? '+' : ''} shown</span>
              {query.hasNextPage && <button className="btn btn-outline" onClick={() => query.fetchNextPage()} disabled={query.isFetchingNextPage}>{query.isFetchingNextPage ? 'Loading…' : 'Load more'}</button>}
            </div>
          </>
        )}
      </div>

      {printing && (
        <div className="print-sheet" aria-hidden="true">
          <h1>Pick list · {org.name}</h1>
          <p>{new Date().toLocaleString()}</p>
          {printing.map((o) => (
            <section key={o.id}>
              <h2>{o.number} · {o.customerName}{o.country ? ` (${o.country})` : ''}</h2>
              <table><thead><tr><th>SKU</th><th>Item</th><th>Qty</th><th>Packed</th></tr></thead>
                <tbody>{o.lines.map((l) => <tr key={l.id}><td>{l.sku}</td><td>{l.name}</td><td>{l.quantity}</td><td>☐</td></tr>)}</tbody></table>
              {o.note && <p>Note: {o.note}</p>}
            </section>
          ))}
        </div>
      )}
    </>
  );
}
