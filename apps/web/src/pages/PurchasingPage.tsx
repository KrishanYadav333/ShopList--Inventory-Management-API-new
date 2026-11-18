import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Product, PurchaseOrder, Supplier } from '@shoplist/shared';
import { api, ApiError, newKey } from '../api';
import { useShell } from '../components/Shell';
import { dateParts } from '../format';
import { canDo, useLocations } from '../queries';
import { useToast } from '../toast';

const STATE: Record<string, string> = { draft: 'Draft', sent: 'Sent', partially_received: 'Partly received', received: 'Received', cancelled: 'Cancelled', closed: 'Closed' };
interface Suggestion { productId: string; sku: string; name: string; available: number; onOrder: number; reorderPoint: number | null; daysOfCover: number | null; suggested: number; supplierName: string | null; leadTimeDays: number }
interface DraftLine { productId: string; label: string; quantity: number; unitCostMinor: number }

export function PurchasingPage() {
  const { org } = useShell();
  const toast = useToast();
  const qc = useQueryClient();
  const buy = canDo(org.role, 'purchasing:write');
  const receive = canDo(org.role, 'stock:write');
  const seeCost = canDo(org.role, 'cost:read');
  const locations = useLocations(org.id);
  const refresh = () => qc.invalidateQueries({ queryKey: ['org', org.id, 'purchasing'] });
  const fail = (e: ApiError) => { toast({ kind: 'error', text: e.message }); refresh(); };
  const money = (v: number) => new Intl.NumberFormat(undefined, { style: 'currency', currency: org.currency }).format(v / 100);

  const suppliers = useQuery({ queryKey: ['org', org.id, 'purchasing', 'suppliers'], queryFn: () => api<{ data: Supplier[] }>('GET', `/orgs/${org.id}/suppliers`).then((r) => r.data) });
  const orders = useQuery({ queryKey: ['org', org.id, 'purchasing', 'orders'], queryFn: () => api<{ data: PurchaseOrder[] }>('GET', `/orgs/${org.id}/purchase-orders?limit=100`).then((r) => r.data) });

  // ---- reorder suggestions
  const suggestions = useQuery({ enabled: buy, queryKey: ['org', org.id, 'purchasing', 'reorder'], queryFn: () => api<{ data: Suggestion[] }>('GET', `/orgs/${org.id}/purchasing/reorder`).then((r) => r.data) });
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const draftFromSuggestions = useMutation({
    mutationFn: () => api<{ created: PurchaseOrder[]; skippedNoSupplier: string[] }>('POST', `/orgs/${org.id}/purchasing/reorder/draft`, { body: { productIds: [...picked] } }),
    onSuccess: (r) => { setPicked(new Set()); refresh(); toast({ kind: 'success', text: `${r.created.length} draft order${r.created.length === 1 ? '' : 's'} created${r.skippedNoSupplier.length ? `. No usual supplier for: ${r.skippedNoSupplier.join(', ')}` : ''}` }); },
    onError: fail,
  });

  // ---- suppliers
  const [sup, setSup] = useState({ name: '', email: '', phone: '', leadTimeDays: '' });
  const addSupplier = useMutation({
    mutationFn: () => api('POST', `/orgs/${org.id}/suppliers`, { body: { name: sup.name, email: sup.email || null, phone: sup.phone || null, leadTimeDays: sup.leadTimeDays ? Number(sup.leadTimeDays) : null } }),
    onSuccess: () => { setSup({ name: '', email: '', phone: '', leadTimeDays: '' }); refresh(); toast({ kind: 'success', text: 'Supplier added' }); },
    onError: fail,
  });
  const archive = useMutation({ mutationFn: (v: { id: string; archived: boolean }) => api('PATCH', `/orgs/${org.id}/suppliers/${v.id}`, { body: { archived: v.archived } }), onSuccess: refresh, onError: fail });

  // ---- new purchase order
  const [po, setPo] = useState({ supplierId: '', locationId: '', expectedAt: '', note: '' });
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [term, setTerm] = useState('');
  const found = useQuery({ enabled: term.trim().length > 1, queryKey: ['org', org.id, 'purchasing', 'find', term], queryFn: () => api<{ data: Product[] }>('GET', `/orgs/${org.id}/products?q=${encodeURIComponent(term.trim())}&limit=6`).then((r) => r.data) });
  const activeSuppliers = suppliers.data?.filter((s) => !s.archivedAt) ?? [];
  const sites = locations.data?.filter((l) => !l.archivedAt) ?? [];
  const create = useMutation({
    mutationFn: () => api('POST', `/orgs/${org.id}/purchase-orders`, { body: { supplierId: po.supplierId || activeSuppliers[0]?.id, locationId: po.locationId || sites[0]?.id, expectedAt: po.expectedAt || null, note: po.note || null, lines: lines.map((l) => ({ productId: l.productId, quantity: l.quantity, unitCostMinor: l.unitCostMinor })) } }),
    onSuccess: () => { setLines([]); setPo({ supplierId: '', locationId: '', expectedAt: '', note: '' }); refresh(); toast({ kind: 'success', text: 'Draft purchase order created' }); },
    onError: fail,
  });

  // ---- actions on an order
  const act = useMutation({ mutationFn: (v: { id: string; what: 'send' | 'cancel' | 'close'; done: string }) => api('POST', `/orgs/${org.id}/purchase-orders/${v.id}/${v.what}`, { body: {} }).then(() => v.done), onSuccess: (done) => { refresh(); toast({ kind: 'success', text: done }); }, onError: fail });
  const [receiving, setReceiving] = useState<PurchaseOrder | null>(null);
  const [qty, setQty] = useState<Record<string, string>>({});
  const doReceive = useMutation({
    mutationFn: () => api('POST', `/orgs/${org.id}/purchase-orders/${receiving!.id}/receive`, { idempotencyKey: newKey(), body: { lines: Object.entries(qty).filter(([, v]) => Number(v) > 0).map(([lineId, v]) => ({ lineId, quantity: Number(v) })) } }),
    onSuccess: () => { setReceiving(null); setQty({}); refresh(); qc.invalidateQueries({ queryKey: ['org', org.id] }); toast({ kind: 'success', text: 'Goods received. Stock updated.' }); },
    onError: fail,
  });
  const submit = (fn: () => void) => (e: FormEvent) => { e.preventDefault(); fn(); };

  return (
    <>
      <header className="top-header"><div className="breadcrumb"><span>Inventory</span><h1 className="current">Purchasing</h1></div></header>
      <div className="settings">
        <section className="card">
          <h2>Purchase orders</h2>
          {orders.isError ? <p className="field-error" role="alert">Could not load purchase orders.</p> : !orders.data?.length ? <p className="hint">{orders.isLoading ? 'Loading…' : 'No purchase orders yet.'}</p> : (
            <ul className="list">
              {orders.data.map((o) => (
                <li key={o.id}>
                  <span>
                    <strong>{o.number}</strong> <span className="tag">{STATE[o.state] ?? o.state}</span> · {o.supplierName}
                    <div className="time">{o.lines.length} item{o.lines.length === 1 ? '' : 's'}{seeCost ? ` · ${money(o.totalCostMinor)}` : ''}{o.expectedAt ? ` · expected ${dateParts(`${o.expectedAt}T00:00:00Z`).date}` : ''} · {o.lines.reduce((a, l) => a + l.received, 0)}/{o.lines.reduce((a, l) => a + l.quantity, 0)} received</div>
                  </span>
                  <span className="row">
                    {buy && o.state === 'draft' && <button className="btn btn-primary" onClick={() => act.mutate({ id: o.id, what: 'send', done: `${o.number} marked as sent` })}>Mark sent</button>}
                    {buy && (o.state === 'sent' || o.state === 'partially_received') && <button className="btn btn-outline" title="Make a link the supplier can open to confirm and dispatch" onClick={() => api<{ link: string }>('POST', `/orgs/${org.id}/purchase-orders/${o.id}/share`, { body: {} }).then((r) => navigator.clipboard.writeText(r.link).then(() => toast({ kind: 'success', text: `Supplier link for ${o.number} copied` })).catch(() => window.prompt('Copy this link', r.link))).catch((e) => fail(e as ApiError))}>Share with supplier</button>}
                    {o.supplierConfirmedAt && <span className="tag">Supplier confirmed</span>}{o.supplierDispatchedAt && <span className="tag">Dispatched</span>}
                    {receive && (o.state === 'sent' || o.state === 'partially_received') && <button className="btn btn-primary" onClick={() => { setReceiving(o); setQty({}); }}>Receive</button>}
                    {buy && (o.state === 'draft' || (o.state === 'sent' && o.lines.every((l) => l.received === 0))) && <button className="btn btn-outline" onClick={() => { if (confirm(`Cancel ${o.number}?`)) act.mutate({ id: o.id, what: 'cancel', done: `${o.number} cancelled` }); }}>Cancel</button>}
                    {buy && o.state === 'partially_received' && <button className="btn btn-outline" onClick={() => { if (confirm(`Close ${o.number}? The rest will not be received.`)) act.mutate({ id: o.id, what: 'close', done: `${o.number} closed` }); }}>Close short</button>}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {receiving && (
            <form className="invite-link" onSubmit={submit(() => doReceive.mutate())} aria-label={`Receive ${receiving.number}`}>
              <p><strong>Receive {receiving.number}</strong>: enter how many of each arrived today.</p>
              {receiving.lines.filter((l) => l.received < l.quantity).map((l) => (
                <div className="field" key={l.id}>
                  <label htmlFor={`rcv-${l.id}`}>{l.name} <span className="time">({l.sku}) · {Math.max(l.quantity - l.received, 0)} still expected (up to {Math.floor(l.quantity * 1.1) - l.received} accepted)</span></label>
                  <input id={`rcv-${l.id}`} type="number" min={0} max={Math.max(Math.floor(l.quantity * 1.1) - l.received, 0)} value={qty[l.id] ?? ''} onChange={(e) => setQty({ ...qty, [l.id]: e.target.value })} />
                </div>
              ))}
              <span className="row">
                <button className="btn btn-primary" disabled={doReceive.isPending || !Object.values(qty).some((v) => Number(v) > 0)}>{doReceive.isPending ? 'Receiving…' : 'Receive into stock'}</button>
                <button type="button" className="btn btn-outline" onClick={() => setReceiving(null)}>Cancel</button>
              </span>
            </form>
          )}
        </section>

        {buy && (
          <section className="card">
            <h2>What to reorder</h2>
            <p className="hint">Products that are low or selling fast. Quantities cover the supplier's lead time plus two weeks of sales, minus what is already on order. The usual supplier is whoever you last ordered the product from.</p>
            {!suggestions.data?.length ? <p className="hint">{suggestions.isLoading ? 'Loading…' : 'Nothing needs ordering right now.'}</p> : (
              <>
                <div className="orders-table-container">
                  <table className="orders-table">
                    <thead><tr><th className="checkbox-col"><span className="sr-only">Pick</span></th><th>Product</th><th className="num">Available</th><th className="num">On order</th><th className="num">Days left</th><th>Usual supplier</th><th className="num">Suggested</th></tr></thead>
                    <tbody>
                      {suggestions.data.map((r) => (
                        <tr key={r.productId}>
                          <td className="checkbox-col"><input type="checkbox" aria-label={`Pick ${r.name}`} checked={picked.has(r.productId)} onChange={() => setPicked((p) => { const n = new Set(p); if (n.has(r.productId)) n.delete(r.productId); else n.add(r.productId); return n; })} /></td>
                          <td><strong>{r.name}</strong><div className="time">{r.sku}</div></td>
                          <td className="num">{r.available}</td><td className="num">{r.onOrder}</td><td className="num">{r.daysOfCover ?? '—'}</td>
                          <td>{r.supplierName ?? <span className="time">none yet</span>}</td><td className="num"><strong>{r.suggested}</strong></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <button className="btn btn-primary" disabled={!picked.size || draftFromSuggestions.isPending} onClick={() => draftFromSuggestions.mutate()}>Create draft orders ({picked.size})</button>
              </>
            )}
          </section>
        )}

        {buy && (
          <section className="card">
            <h2>New purchase order</h2>
            {!activeSuppliers.length ? <p className="hint">Add a supplier first.</p> : (
              <form className="settings-grid" onSubmit={submit(() => create.mutate())}>
                <div className="field"><label htmlFor="po-sup">Supplier</label><select id="po-sup" value={po.supplierId || activeSuppliers[0].id} onChange={(e) => setPo({ ...po, supplierId: e.target.value })}>{activeSuppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></div>
                <div className="field"><label htmlFor="po-loc">Deliver to</label><select id="po-loc" value={po.locationId || sites[0]?.id} onChange={(e) => setPo({ ...po, locationId: e.target.value })}>{sites.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></div>
                <div className="field"><label htmlFor="po-exp">Expected on</label><input id="po-exp" type="date" value={po.expectedAt} onChange={(e) => setPo({ ...po, expectedAt: e.target.value })} /></div>
                <div className="field"><label htmlFor="po-note">Note</label><input id="po-note" maxLength={500} value={po.note} onChange={(e) => setPo({ ...po, note: e.target.value })} /></div>
                <div className="field" style={{ gridColumn: '1 / -1' }}>
                  <label htmlFor="po-find">Add a product</label>
                  <input id="po-find" value={term} onChange={(e) => setTerm(e.target.value)} placeholder="Search by name, SKU or barcode" autoComplete="off" />
                  {found.data?.length ? (
                    <ul className="list">
                      {found.data.filter((p) => !lines.some((l) => l.productId === p.id)).map((p) => (
                        <li key={p.id}><span>{p.name} <span className="time">{p.sku}</span></span><button type="button" className="btn btn-outline" onClick={() => { setLines([...lines, { productId: p.id, label: `${p.name} (${p.sku})`, quantity: 1, unitCostMinor: p.costMinor ?? p.priceMinor }]); setTerm(''); }}>Add</button></li>
                      ))}
                    </ul>
                  ) : null}
                </div>
                {lines.length > 0 && (
                  <div style={{ gridColumn: '1 / -1' }} className="orders-table-container">
                    <table className="orders-table">
                      <thead><tr><th>Product</th><th className="num">Quantity</th><th className="num">Unit cost</th><th className="actions-col"><span className="sr-only">Remove</span></th></tr></thead>
                      <tbody>
                        {lines.map((l, i) => (
                          <tr key={l.productId}>
                            <td>{l.label}</td>
                            <td className="num"><input aria-label={`Quantity of ${l.label}`} className="mini" type="number" min={1} value={l.quantity} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, quantity: Math.max(1, Number(e.target.value) || 1) } : x)))} /></td>
                            <td className="num"><input aria-label={`Unit cost of ${l.label}`} className="mini" type="number" min={0} step="0.01" value={l.unitCostMinor / 100} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, unitCostMinor: Math.round(Number(e.target.value) * 100) } : x)))} /></td>
                            <td className="actions-col"><button type="button" className="btn btn-outline cell-btn" onClick={() => setLines(lines.filter((_, j) => j !== i))}>Remove</button></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <p className="hint">Total {money(lines.reduce((a, l) => a + l.quantity * l.unitCostMinor, 0))}</p>
                  </div>
                )}
                <button className="btn btn-primary" disabled={create.isPending || !lines.length}>{create.isPending ? 'Creating…' : 'Create draft'}</button>
              </form>
            )}
          </section>
        )}

        <section className="card">
          <h2>Suppliers</h2>
          {!suppliers.data?.length ? <p className="hint">{suppliers.isLoading ? 'Loading…' : 'No suppliers yet.'}</p> : (
            <ul className="list">
              {suppliers.data.map((s) => (
                <li key={s.id}>
                  <span><strong>{s.name}</strong>{s.archivedAt && <span className="tag">archived</span>}<div className="time">{[s.email, s.phone, s.leadTimeDays != null ? `${s.leadTimeDays} days lead time` : null].filter(Boolean).join(' · ') || 'No contact details'}</div></span>
                  {buy && <button className="btn btn-outline" onClick={() => archive.mutate({ id: s.id, archived: !s.archivedAt })}>{s.archivedAt ? 'Restore' : 'Archive'}</button>}
                </li>
              ))}
            </ul>
          )}
          {buy && (
            <form className="settings-grid" onSubmit={submit(() => addSupplier.mutate())}>
              <div className="field"><label htmlFor="su-name">Name</label><input id="su-name" required maxLength={120} value={sup.name} onChange={(e) => setSup({ ...sup, name: e.target.value })} /></div>
              <div className="field"><label htmlFor="su-email">Email</label><input id="su-email" type="email" value={sup.email} onChange={(e) => setSup({ ...sup, email: e.target.value })} /></div>
              <div className="field"><label htmlFor="su-phone">Phone</label><input id="su-phone" maxLength={40} value={sup.phone} onChange={(e) => setSup({ ...sup, phone: e.target.value })} /></div>
              <div className="field"><label htmlFor="su-lead">Lead time (days)</label><input id="su-lead" type="number" min={0} max={365} value={sup.leadTimeDays} onChange={(e) => setSup({ ...sup, leadTimeDays: e.target.value })} /></div>
              <button className="btn btn-primary" disabled={addSupplier.isPending || !sup.name.trim()}>Add supplier</button>
            </form>
          )}
        </section>
      </div>
    </>
  );
}
