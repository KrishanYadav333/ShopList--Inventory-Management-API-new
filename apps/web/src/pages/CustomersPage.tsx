import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Customer } from '@shoplist/shared';
import { api, ApiError } from '../api';
import { useShell } from '../components/Shell';
import { dateParts } from '../format';
import { canDo } from '../queries';
import { useToast } from '../toast';

interface Detail { customer: Customer; orders: { id: string; number: string; state: string; totalMinor: number; createdAt: string }[] }

export function CustomersPage() {
  const { org } = useShell();
  const toast = useToast();
  const qc = useQueryClient();
  const edit = canDo(org.role, 'orders:write');
  const [text, setText] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const money = (v: number) => new Intl.NumberFormat(undefined, { style: 'currency', currency: org.currency }).format(v / 100);
  const refresh = () => qc.invalidateQueries({ queryKey: ['org', org.id, 'customers'] });
  const fail = (e: ApiError) => toast({ kind: 'error', text: e.message });
  const list = useQuery({ queryKey: ['org', org.id, 'customers', 'list', text], queryFn: () => api<{ data: Customer[] }>('GET', `/orgs/${org.id}/customers${text.trim() ? `?q=${encodeURIComponent(text.trim())}` : ''}`).then((r) => r.data) });
  const detail = useQuery({ enabled: !!openId, queryKey: ['org', org.id, 'customers', 'one', openId], queryFn: () => api<Detail>('GET', `/orgs/${org.id}/customers/${openId}`) });
  const [f, setF] = useState({ name: '', email: '', phone: '', address: '', taxId: '' });
  const add = useMutation({
    mutationFn: () => api('POST', `/orgs/${org.id}/customers`, { body: { name: f.name, email: f.email || null, phone: f.phone || null, address: f.address || null, taxId: f.taxId || null } }),
    onSuccess: () => { setF({ name: '', email: '', phone: '', address: '', taxId: '' }); refresh(); toast({ kind: 'success', text: 'Customer added' }); },
    onError: fail,
  });
  const archive = useMutation({ mutationFn: (id: string) => api('PATCH', `/orgs/${org.id}/customers/${id}`, { body: { archived: true } }), onSuccess: () => { setOpenId(null); refresh(); toast({ text: 'Customer archived' }); }, onError: fail });
  const submit = (e: FormEvent) => { e.preventDefault(); add.mutate(); };

  return (
    <>
      <header className="top-header"><div className="breadcrumb"><span>Inventory</span><h1 className="current">Customers</h1></div></header>
      <div className="settings">
        <section className="card">
          <div className="field"><label htmlFor="cu-q">Search</label><input id="cu-q" type="search" value={text} onChange={(e) => setText(e.target.value)} placeholder="Name, email or phone" /></div>
          {!list.data?.length ? <p className="hint">{list.isLoading ? 'Loading…' : 'No customers yet. They are added automatically when an order has an email address.'}</p> : (
            <ul className="list">
              {list.data.map((c) => (
                <li key={c.id}>
                  <span><strong>{c.name}</strong><div className="time">{[c.email, c.phone].filter(Boolean).join(' · ') || 'No contact details'} · {c.orders} order{c.orders === 1 ? '' : 's'} · {money(c.spentMinor)}{c.lastOrderAt ? ` · last ${dateParts(c.lastOrderAt).date}` : ''}</div></span>
                  <button className="btn btn-outline" onClick={() => setOpenId(openId === c.id ? null : c.id)} aria-expanded={openId === c.id}>Orders</button>
                </li>
              ))}
            </ul>
          )}
          {openId && detail.data && (
            <div className="invite-link" role="region" aria-label="Customer orders">
              <p><strong>{detail.data.customer.name}</strong>{detail.data.customer.address ? ` · ${detail.data.customer.address}` : ''}{detail.data.customer.taxId ? ` · tax id ${detail.data.customer.taxId}` : ''}</p>
              {!detail.data.orders.length ? <p className="hint">No orders yet.</p> : (
                <ul className="list">{detail.data.orders.map((o) => <li key={o.id}><span><strong>{o.number}</strong> <span className="tag">{o.state.replace(/_/g, ' ')}</span><div className="time">{dateParts(o.createdAt).date}</div></span><span>{money(o.totalMinor)}</span></li>)}</ul>
              )}
              {edit && <button className="btn btn-outline" onClick={() => { if (confirm(`Archive ${detail.data!.customer.name}? Their orders stay.`)) archive.mutate(openId); }}>Archive customer</button>}
            </div>
          )}
        </section>
        {edit && (
          <section className="card">
            <h2>Add a customer</h2>
            <form className="settings-grid" onSubmit={submit}>
              <div className="field"><label htmlFor="cu-name">Name</label><input id="cu-name" required maxLength={120} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></div>
              <div className="field"><label htmlFor="cu-email">Email</label><input id="cu-email" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></div>
              <div className="field"><label htmlFor="cu-phone">Phone</label><input id="cu-phone" maxLength={40} value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></div>
              <div className="field"><label htmlFor="cu-addr">Address</label><input id="cu-addr" maxLength={300} value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} /></div>
              <div className="field"><label htmlFor="cu-tax">Tax id</label><input id="cu-tax" maxLength={40} value={f.taxId} onChange={(e) => setF({ ...f, taxId: e.target.value })} /></div>
              <button className="btn btn-primary" disabled={add.isPending || !f.name.trim()}>Add customer</button>
            </form>
          </section>
        )}
      </div>
    </>
  );
}
