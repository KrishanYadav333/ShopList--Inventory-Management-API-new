import { useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { Product } from '@shoplist/shared';
import { api, ApiError, newKey } from '../api';
import { fromMinor, toMinor } from '../format';
import { useProduct, type OrgSummary } from '../queries';
import { useToast } from '../toast';
import { Modal } from './Modal';

const LABELS: Record<string, string> = { sku: 'SKU', name: 'Name', description: 'Description', barcode: 'Barcode', unit: 'Unit', priceMinor: 'Price', costMinor: 'Cost', reorderPoint: 'Reorder point', tags: 'Tags' };

interface FormState {
  sku: string; name: string; barcode: string; unit: string; price: string; cost: string; reorder: string; tags: string; description: string; initial: string;
}
const empty: FormState = { sku: '', name: '', barcode: '', unit: 'each', price: '', cost: '', reorder: '', tags: '', description: '', initial: '' };
const fromProduct = (p: Product): FormState => ({
  sku: p.sku, name: p.name, barcode: p.barcode ?? '', unit: p.unit, price: fromMinor(p.priceMinor), cost: fromMinor(p.costMinor),
  reorder: p.reorderPoint == null ? '' : String(p.reorderPoint), tags: p.tags.join(', '), description: p.description ?? '', initial: '',
});

export function ProductDialog({ org, productId, onClose }: { org: OrgSummary; productId?: string; onClose: () => void }) {
  const loaded = useProduct(org.id, productId ?? null);
  if (productId && loaded.isLoading) return <Modal title="Edit product" onClose={onClose}><div className="modal-body">Loading…</div></Modal>;
  if (productId && !loaded.data) return <Modal title="Edit product" onClose={onClose}><div className="modal-body"><p>This product could not be loaded. It may have been deleted.</p></div></Modal>;
  return <Form org={org} product={loaded.data?.product} onClose={onClose} />;
}

function Form({ org, product, onClose }: { org: OrgSummary; product?: Product; onClose: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [f, setF] = useState<FormState>(product ? fromProduct(product) : empty);
  const [key] = useState(newKey); // one key per submit attempt: a retry of the same click never creates a second product
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [conflict, setConflict] = useState<Product | null>(null);
  const set = (k: keyof FormState) => (e: { target: { value: string } }) => setF((s) => ({ ...s, [k]: e.target.value }));

  /** Pure: validates the form and builds the request body. Safe to call while rendering. */
  function build(): { errs: Record<string, string>; value: Record<string, unknown> | null } {
    const errs: Record<string, string> = {};
    const price = toMinor(f.price);
    if (!f.sku.trim()) errs.sku = 'SKU is required';
    if (!f.name.trim()) errs.name = 'Name is required';
    if (price === null) errs.price = 'Enter a price like 12.50';
    const cost = f.cost.trim() ? toMinor(f.cost) : null;
    if (f.cost.trim() && cost === null) errs.cost = 'Enter a cost like 7.25';
    const reorder = f.reorder.trim() ? Number(f.reorder) : null;
    if (reorder !== null && (!Number.isInteger(reorder) || reorder < 0)) errs.reorder = 'Whole number, 0 or more';
    const initial = f.initial.trim() ? Number(f.initial) : 0;
    if (!product && (!Number.isInteger(initial) || initial < 0)) errs.initial = 'Whole number, 0 or more';
    if (Object.keys(errs).length) return { errs, value: null };
    return {
      errs,
      value: {
        sku: f.sku.trim(), name: f.name.trim(), barcode: f.barcode.trim() || null, unit: f.unit.trim() || 'each', priceMinor: price!, costMinor: cost,
        reorderPoint: reorder, description: f.description.trim() || null,
        tags: f.tags.split(',').map((t) => t.trim()).filter(Boolean),
        ...(product ? {} : { initialQuantity: initial }),
      },
    };
  }

  const save = useMutation({
    mutationFn: async ({ version }: { version?: number }) => {
      const { errs, value: b } = build();
      setFieldErrors(errs);
      if (!b) throw new ApiError({ status: 400, type: 'validation', detail: 'Fix the highlighted fields.' });
      return product
        ? api<{ product: Product }>('PATCH', `/orgs/${org.id}/products/${product.id}`, { body: b, ifMatch: version ?? product.version })
        : api<{ product: Product }>('POST', `/orgs/${org.id}/products`, { body: b, idempotencyKey: key });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['org', org.id] });
      toast({ kind: 'success', text: product ? 'Product saved' : 'Product created' });
      onClose();
    },
    onError: (e: ApiError) => {
      if (e.status === 412) return setConflict(e.current as Product);
      if (e.errors.length) setFieldErrors(Object.fromEntries(e.errors.filter((x) => x.field).map((x) => [({ priceMinor: 'price', costMinor: 'cost', reorderPoint: 'reorder' } as Record<string, string>)[x.field!] ?? x.field!, e.message])));
      if (e.status !== 400 || !e.errors.length) toast({ kind: 'error', text: e.message });
    },
  });

  const submit = (e: FormEvent) => { e.preventDefault(); save.mutate({}); };

  if (conflict && product) {
    const mine = build().value;
    const theirs = conflict as unknown as Record<string, unknown>;
    const rows = Object.keys(LABELS).flatMap((k) => {
      const m = mine ? (mine as Record<string, unknown>)[k] : undefined;
      const t = theirs[k];
      return m !== undefined && JSON.stringify(m) !== JSON.stringify(t) ? [{ k, m, t }] : [];
    });
    const show = (k: string, v: unknown) => (k.endsWith('Minor') && typeof v === 'number' ? (v / 100).toFixed(2) : Array.isArray(v) ? v.join(', ') : v == null || v === '' ? '—' : String(v));
    return (
      <Modal title="Someone else changed this product" onClose={onClose} wide>
        <div className="modal-body">
          <p>Your changes were not saved. Compare the two versions and choose what to keep.</p>
          <table className="diff"><thead><tr><th>Field</th><th>Your change</th><th>Current value</th></tr></thead>
            <tbody>{rows.length ? rows.map((r) => <tr key={r.k}><td>{LABELS[r.k]}</td><td>{show(r.k, r.m)}</td><td>{show(r.k, r.t)}</td></tr>) : <tr><td colSpan={3}>No field differs, you can save again.</td></tr>}</tbody></table>
        </div>
        <div className="modal-foot">
          <button className="btn btn-outline" onClick={() => { qc.invalidateQueries({ queryKey: ['org', org.id] }); onClose(); }}>Use theirs</button>
          <button className="btn btn-primary" disabled={save.isPending} onClick={() => { const v = conflict.version; setConflict(null); save.mutate({ version: v }); }}>Keep mine</button>
        </div>
      </Modal>
    );
  }

  const field = (id: keyof FormState, label: string, props: Record<string, unknown> = {}, wide = false) => (
    <div className={`field${wide ? ' span-2' : ''}`}>
      <label htmlFor={`pf-${id}`}>{label}</label>
      <input id={`pf-${id}`} value={f[id]} onChange={set(id)} aria-invalid={!!fieldErrors[id]} aria-describedby={fieldErrors[id] ? `pf-${id}-err` : undefined} {...props} />
      {fieldErrors[id] && <div className="field-error" id={`pf-${id}-err`}>{fieldErrors[id]}</div>}
    </div>
  );

  return (
    <Modal title={product ? 'Edit product' : 'New product'} onClose={onClose} wide>
      <form onSubmit={submit} noValidate>
        <div className="modal-body form-grid">
          {field('name', 'Name', { maxLength: 200, autoComplete: 'off' }, true)}
          {field('sku', 'SKU', { maxLength: 64, autoComplete: 'off' })}
          {field('barcode', 'Barcode', { maxLength: 64, inputMode: 'numeric', autoComplete: 'off' })}
          {field('price', `Price (${org.currency})`, { inputMode: 'decimal', placeholder: '0.00' })}
          {field('cost', `Cost (${org.currency}, optional)`, { inputMode: 'decimal', placeholder: '0.00' })}
          {field('reorder', 'Reorder point', { inputMode: 'numeric', placeholder: 'Alert when stock reaches…' })}
          {field('unit', 'Unit', { maxLength: 20 })}
          {!product && field('initial', 'Starting stock', { inputMode: 'numeric', placeholder: '0' })}
          {field('tags', 'Tags (comma separated)', {}, true)}
          <div className="field span-2">
            <label htmlFor="pf-description">Description</label>
            <textarea id="pf-description" rows={3} maxLength={5000} value={f.description} onChange={set('description')} />
          </div>
        </div>
        <div className="modal-foot">
          <button type="button" className="btn btn-outline" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={save.isPending}>{save.isPending ? 'Saving…' : product ? 'Save changes' : 'Create product'}</button>
        </div>
      </form>
    </Modal>
  );
}
