import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CLIENT_REASONS, type Movement, type Product, type StockLevel } from '@shoplist/shared';
import { api, ApiError, newKey } from '../api';
import { REASON_LABELS } from '../format';
import { Icon } from '../icons';
import { useLocations, useProduct, type OrgSummary } from '../queries';
import { useToast } from '../toast';
import { Modal } from './Modal';

/** Sign of the change each reason implies, so staff only type a positive number. */
const SIGN: Record<string, 1 | -1 | 0> = { receive: 1, return: 1, sale: -1, damage: -1, adjust: 0 };

export function AdjustDialog({ org, productId, onClose }: { org: OrgSummary; productId?: string; onClose: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [pid, setPid] = useState<string | null>(productId ?? null);
  const [term, setTerm] = useState('');
  const [reason, setReason] = useState<(typeof CLIENT_REASONS)[number]>('receive');
  const [qty, setQty] = useState('1');
  const [direction, setDirection] = useState<1 | -1>(1); // only used for "adjust"
  const [locationId, setLocationId] = useState('');
  const [note, setNote] = useState('');
  const [reference, setReference] = useState('');
  const [key, setKey] = useState(newKey);

  const locations = useLocations(org.id);
  const selected = useProduct(org.id, pid);

  useEffect(() => {
    if (!locationId && locations.data) setLocationId(locations.data.find((l) => l.isDefault)?.id ?? locations.data[0]?.id ?? '');
  }, [locations.data, locationId]);

  // Search or scan: an exact barcode/SKU wins, otherwise show matches.
  const matches = useQuery({
    queryKey: ['org', org.id, 'adjust-search', term],
    enabled: !pid && term.trim().length > 0,
    queryFn: () => api<{ data: Product[] }>('GET', `/orgs/${org.id}/products?limit=6&q=${encodeURIComponent(term.trim())}`),
  });
  async function lookup(e: FormEvent) {
    e.preventDefault();
    const code = term.trim();
    if (!code) return;
    try {
      const r = await api<{ product: Product }>('GET', `/orgs/${org.id}/products/lookup?code=${encodeURIComponent(code)}`);
      setPid(r.product.id);
    } catch {
      if (matches.data?.data.length === 1) setPid(matches.data.data[0].id);
    }
  }

  const level: StockLevel | undefined = selected.data?.levels.find((l) => l.locationId === locationId);
  const available = level?.available ?? 0;
  const n = Number(qty);
  const signed = useMemo(() => (SIGN[reason] === 0 ? direction * n : SIGN[reason] * n), [reason, direction, n]);
  const valid = pid && locationId && Number.isInteger(n) && n > 0;

  const save = useMutation({
    mutationFn: () =>
      api<{ movement: Movement; stock: StockLevel }>('POST', `/orgs/${org.id}/stock/movements`, {
        idempotencyKey: key,
        body: { productId: pid, locationId, delta: signed, reason, reference: reference.trim() || null, note: note.trim() || null },
      }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['org', org.id] });
      const name = selected.data?.product.name ?? 'product';
      toast({
        kind: 'success',
        text: `${name}: ${signed > 0 ? '+' : ''}${signed}, now ${r.stock.onHand} on hand`,
        action: {
          label: 'Undo',
          run: () =>
            api('POST', `/orgs/${org.id}/stock/movements`, { idempotencyKey: newKey(), body: { productId: pid, locationId, delta: -signed, reason: 'adjust', note: 'Undo of previous change' } })
              .then(() => qc.invalidateQueries({ queryKey: ['org', org.id] }))
              .catch((e: ApiError) => toast({ kind: 'error', text: `Could not undo: ${e.message}` })),
        },
      });
      onClose();
    },
    onError: (e: ApiError) => { toast({ kind: 'error', text: e.message }); setKey(newKey()); },
  });

  return (
    <Modal title="Adjust stock" onClose={onClose}>
      <form onSubmit={(e) => { e.preventDefault(); if (valid) save.mutate(); }}>
        <div className="modal-body">
          {!pid ? (
            <div className="field">
              <label htmlFor="adj-q">Find a product or scan a barcode</label>
              <div className="scan-row">
                <input id="adj-q" value={term} onChange={(e) => setTerm(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && lookup(e)} placeholder="Name, SKU or barcode" autoComplete="off" />
                <Icon name="scan" />
              </div>
              <ul className="results" role="listbox">
                {matches.data?.data.map((p) => (
                  <li key={p.id}><button type="button" onClick={() => setPid(p.id)}><strong>{p.name}</strong><span>{p.sku} · {p.onHand} on hand</span></button></li>
                ))}
                {matches.data && !matches.data.data.length && <li className="results-empty">Nothing matches “{term}”.</li>}
              </ul>
            </div>
          ) : selected.isLoading ? (
            <p>Loading…</p>
          ) : selected.data ? (
            <>
              <div className="picked">
                <div><strong>{selected.data.product.name}</strong><div className="time">{selected.data.product.sku}</div></div>
                {!productId && <button type="button" className="btn btn-outline" onClick={() => { setPid(null); setTerm(''); }}>Change</button>}
              </div>
              <div className="field">
                <label htmlFor="adj-loc">Location</label>
                <select id="adj-loc" value={locationId} onChange={(e) => setLocationId(e.target.value)}>
                  {locations.data?.filter((l) => !l.archivedAt).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                </select>
                <div className="hint">{level ? `${level.onHand} on hand, ${available} available here` : 'None here yet'}</div>
              </div>
              <div className="field">
                <span className="label">Reason</span>
                <div className="chips" role="radiogroup" aria-label="Reason">
                  {CLIENT_REASONS.map((r) => (
                    <button key={r} type="button" role="radio" aria-checked={reason === r} className={`chip${reason === r ? ' on' : ''}`} onClick={() => setReason(r)}>{REASON_LABELS[r]}</button>
                  ))}
                </div>
              </div>
              <div className="field">
                <label htmlFor="adj-qty">Quantity</label>
                <div className="stepper">
                  <button type="button" aria-label="Decrease" onClick={() => setQty(String(Math.max(1, n - 1)))}>−</button>
                  <input id="adj-qty" inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value.replace(/\D/g, ''))} />
                  <button type="button" aria-label="Increase" onClick={() => setQty(String(n + 1))}>+</button>
                  {reason === 'adjust' && (
                    <button type="button" className="btn btn-outline dir" onClick={() => setDirection((d) => (d === 1 ? -1 : 1))}>{direction === 1 ? 'Add' : 'Remove'}</button>
                  )}
                </div>
                <div className="hint">{valid ? `Result: ${(level?.onHand ?? 0) + signed} on hand` : 'Enter a whole number above 0'}</div>
              </div>
              <div className="form-grid">
                <div className="field"><label htmlFor="adj-ref">Reference (optional)</label><input id="adj-ref" value={reference} onChange={(e) => setReference(e.target.value)} maxLength={100} placeholder="Order or PO number" /></div>
                <div className="field"><label htmlFor="adj-note">Note (optional)</label><input id="adj-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} /></div>
              </div>
            </>
          ) : (
            <p>That product could not be loaded.</p>
          )}
        </div>
        <div className="modal-foot">
          <button type="button" className="btn btn-outline" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={!valid || save.isPending}>{save.isPending ? 'Saving…' : 'Save'}</button>
        </div>
      </form>
    </Modal>
  );
}
