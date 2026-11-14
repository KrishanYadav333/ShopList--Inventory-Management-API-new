import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ORDER_CHANNELS, type Order, type Product } from '@shoplist/shared';
import { api, ApiError, newKey } from '../api';
import { money } from '../format';
import { Icon } from '../icons';
import { useLocations, type OrgSummary } from '../queries';
import { useToast } from '../toast';
import { Modal } from './Modal';
import { ScanButton } from './Scanner';

interface Line { product: Product; quantity: string }

/** Creates an order. Stock is held as soon as it is created; anything short waits and is filled when stock arrives. */
export function OrderDialog({ org, onClose }: { org: OrgSummary; onClose: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const locations = useLocations(org.id);
  const [key] = useState(newKey);
  const [f, setF] = useState({ customerName: '', customerEmail: '', country: '', channel: 'manual', note: '', locationId: '', paid: false });
  const [lines, setLines] = useState<Line[]>([]);
  const [term, setTerm] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});

  const matches = useQuery({
    queryKey: ['org', org.id, 'order-product-search', term],
    enabled: term.trim().length > 0,
    queryFn: () => api<{ data: Product[] }>('GET', `/orgs/${org.id}/products?limit=6&q=${encodeURIComponent(term.trim())}`),
  });

  const add = (p: Product) => {
    setLines((l) => (l.some((x) => x.product.id === p.id) ? l : [...l, { product: p, quantity: '1' }]));
    setTerm('');
  };
  async function addByCode(code: string) {
    try {
      const r = await api<{ product: Product }>('GET', `/orgs/${org.id}/products/lookup?code=${encodeURIComponent(code.trim())}`);
      add(r.product);
    } catch {
      toast({ kind: 'error', text: `Nothing matches ${code}.` });
    }
  }
  const total = lines.reduce((sum, l) => sum + (Number(l.quantity) || 0) * l.product.priceMinor, 0);

  const save = useMutation({
    mutationFn: () => {
      const errs: Record<string, string> = {};
      if (!f.customerName.trim()) errs.customerName = 'Customer name is required';
      if (f.country && !/^[a-zA-Z]{2}$/.test(f.country)) errs.country = 'Two letters, e.g. GB';
      if (!lines.length) errs.lines = 'Add at least one item';
      if (lines.some((l) => !Number.isInteger(Number(l.quantity)) || Number(l.quantity) < 1)) errs.lines = 'Quantities must be whole numbers, 1 or more';
      setErrors(errs);
      if (Object.keys(errs).length) throw new ApiError({ status: 400, type: 'validation', detail: 'Fix the highlighted fields.' });
      return api<{ order: Order }>('POST', `/orgs/${org.id}/orders`, {
        idempotencyKey: key,
        body: {
          customerName: f.customerName.trim(), customerEmail: f.customerEmail.trim() || null, country: f.country.trim() || null,
          channel: f.channel, note: f.note.trim() || null, locationId: f.locationId || null, paid: f.paid,
          lines: lines.map((l) => ({ productId: l.product.id, quantity: Number(l.quantity) })),
        },
      });
    },
    onSuccess: ({ order }) => {
      qc.invalidateQueries({ queryKey: ['org', org.id] });
      const short = order.lines.filter((l) => l.reserved < l.quantity).length;
      toast({ kind: 'success', text: `${order.number} created${short ? `, ${short} item${short === 1 ? '' : 's'} waiting for stock` : ''}` });
      onClose();
    },
    onError: (e: ApiError) => {
      if (e.status !== 400 || !e.errors.length) toast({ kind: 'error', text: e.message });
      else setErrors({ lines: e.message });
    },
  });
  const submit = (e: FormEvent) => { e.preventDefault(); save.mutate(); };
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((s) => ({ ...s, [k]: e.target.value }));

  return (
    <Modal title="New order" onClose={onClose} wide>
      <form onSubmit={submit} noValidate>
        <div className="modal-body">
          <div className="form-grid">
            <div className="field span-2">
              <label htmlFor="o-cust">Customer</label>
              <input id="o-cust" value={f.customerName} onChange={set('customerName')} maxLength={120} autoComplete="off" aria-invalid={!!errors.customerName} />
              {errors.customerName && <div className="field-error">{errors.customerName}</div>}
            </div>
            <div className="field"><label htmlFor="o-email">Email (optional)</label><input id="o-email" type="email" value={f.customerEmail} onChange={set('customerEmail')} /></div>
            <div className="field">
              <label htmlFor="o-country">Country</label>
              <input id="o-country" value={f.country} onChange={set('country')} maxLength={2} placeholder="GB" aria-invalid={!!errors.country} />
              {errors.country && <div className="field-error">{errors.country}</div>}
            </div>
            <div className="field"><label htmlFor="o-channel">Channel</label>
              <select id="o-channel" value={f.channel} onChange={set('channel')}>{ORDER_CHANNELS.map((c) => <option key={c} value={c}>{c}</option>)}</select></div>
            <div className="field"><label htmlFor="o-loc">Ship from</label>
              <select id="o-loc" value={f.locationId} onChange={set('locationId')}>
                <option value="">Default location</option>
                {locations.data?.filter((l) => !l.archivedAt).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select></div>
          </div>

          <div className="field">
            <label htmlFor="o-add">Items</label>
            <div className="scan-row"><input id="o-add" value={term} onChange={(e) => setTerm(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); if (term.trim()) void addByCode(term); } }} placeholder="Search, or scan a barcode and press Enter" autoComplete="off" /><Icon name="search" /></div>
            <ScanButton onResult={(code) => void addByCode(code)} label="Scan to add" />
            {term.trim() && (
              <ul className="results" role="listbox">
                {matches.data?.data.map((p) => (
                  <li key={p.id}><button type="button" onClick={() => add(p)}><strong>{p.name}</strong><span>{p.sku} · {p.available} available</span></button></li>
                ))}
                {matches.data && !matches.data.data.length && <li className="results-empty">Nothing matches “{term}”.</li>}
              </ul>
            )}
            {errors.lines && <div className="field-error">{errors.lines}</div>}
            {lines.length > 0 && (
              <table className="diff lines">
                <thead><tr><th>Product</th><th className="num">Available</th><th className="num">Qty</th><th className="num">Total</th><th /></tr></thead>
                <tbody>
                  {lines.map((l, i) => {
                    const q = Number(l.quantity) || 0;
                    return (
                      <tr key={l.product.id}>
                        <td><strong>{l.product.name}</strong><div className="time">{l.product.sku}</div></td>
                        <td className="num">{l.product.available}{q > l.product.available && <div className="time warn">{q - l.product.available} will wait</div>}</td>
                        <td className="num"><input className="qty-input" inputMode="numeric" aria-label={`Quantity of ${l.product.name}`} value={l.quantity} onChange={(e) => setLines((all) => all.map((x, j) => (j === i ? { ...x, quantity: e.target.value.replace(/\D/g, '') } : x)))} /></td>
                        <td className="num">{money(q * l.product.priceMinor, org.currency)}</td>
                        <td><button type="button" className="icon-btn" aria-label={`Remove ${l.product.name}`} onClick={() => setLines((all) => all.filter((_, j) => j !== i))}><Icon name="x" size={14} /></button></td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot><tr><td colSpan={3} className="num"><strong>Order total</strong></td><td className="num"><strong>{money(total, org.currency)}</strong></td><td /></tr></tfoot>
              </table>
            )}
          </div>

          <div className="field"><label htmlFor="o-note">Note (optional)</label><input id="o-note" value={f.note} onChange={set('note')} maxLength={500} /></div>
          <label className="check"><input type="checkbox" checked={f.paid} onChange={(e) => setF((s) => ({ ...s, paid: e.target.checked }))} /> Already paid</label>
        </div>
        <div className="modal-foot">
          <button type="button" className="btn btn-outline" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={save.isPending}>{save.isPending ? 'Creating…' : 'Create order'}</button>
        </div>
      </form>
    </Modal>
  );
}
