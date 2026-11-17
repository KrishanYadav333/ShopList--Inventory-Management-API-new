import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CountTask } from '@shoplist/shared';
import { api, ApiError } from '../api';
import { useShell } from '../components/Shell';
import { dateParts } from '../format';
import { canDo, useLocations, useMe } from '../queries';
import { useToast } from '../toast';

type Row = Omit<CountTask, 'lines'>;
interface Member { id: string; name: string; role: string; deactivatedAt?: string | null }

export function CountsPage() {
  const { org } = useShell();
  const toast = useToast();
  const qc = useQueryClient();
  const me = useMe();
  const assign = canDo(org.role, 'counts:assign');
  const locations = useLocations(org.id);
  const sites = locations.data?.filter((l) => !l.archivedAt) ?? [];
  const refresh = () => qc.invalidateQueries({ queryKey: ['org', org.id, 'counts'] });
  const fail = (e: ApiError) => { toast({ kind: 'error', text: e.message }); refresh(); };

  const tasks = useQuery({ queryKey: ['org', org.id, 'counts', 'list'], queryFn: () => api<{ data: Row[] }>('GET', `/orgs/${org.id}/count-tasks?limit=100`).then((r) => r.data) });
  const members = useQuery({ enabled: assign, queryKey: ['org', org.id, 'members'], queryFn: () => api<{ data: Member[] }>('GET', `/orgs/${org.id}/members`).then((r) => r.data) });
  const nameOf = (id: string | null) => (id ? members.data?.find((m) => m.id === id)?.name ?? 'Someone' : 'Anyone');

  // ---- create
  const [f, setF] = useState({ title: '', locationId: '', kind: 'all', tag: '', days: '30', assignedTo: '', dueAt: '', blind: true });
  const create = useMutation({
    mutationFn: () => api('POST', `/orgs/${org.id}/count-tasks`, { body: {
      title: f.title || null, locationId: f.locationId || sites[0]?.id, blind: f.blind, assignedTo: f.assignedTo || null, dueAt: f.dueAt || null,
      scope: f.kind === 'tag' ? { kind: 'tag', tag: f.tag } : f.kind === 'stale' ? { kind: 'stale', days: Number(f.days) || 30 } : { kind: 'all' },
    } }),
    onSuccess: () => { setF({ ...f, title: '', tag: '' }); refresh(); toast({ kind: 'success', text: 'Count created' }); },
    onError: fail,
  });

  // ---- work a count
  const [openId, setOpenId] = useState<string | null>(null);
  const [vals, setVals] = useState<Record<string, string>>({});
  const detail = useQuery({ enabled: !!openId, queryKey: ['org', org.id, 'counts', 'one', openId], queryFn: () => api<{ task: CountTask }>('GET', `/orgs/${org.id}/count-tasks/${openId}`).then((r) => r.task) });
  const t = detail.data;
  const payload = () => Object.entries(vals).filter(([, v]) => v !== '' && Number.isInteger(Number(v)) && Number(v) >= 0).map(([productId, v]) => ({ productId, counted: Number(v) }));
  const save = useMutation({ mutationFn: () => api('POST', `/orgs/${org.id}/count-tasks/${openId}/lines`, { body: { lines: payload() } }), onSuccess: () => { refresh(); toast({ text: 'Progress saved' }); }, onError: fail });
  const submit = useMutation({
    mutationFn: async () => { if (payload().length) await api('POST', `/orgs/${org.id}/count-tasks/${openId}/lines`, { body: { lines: payload() } }); return api<{ applied: number; waitingForApproval: number }>('POST', `/orgs/${org.id}/count-tasks/${openId}/submit`, { body: {} }); },
    onSuccess: (r) => { setVals({}); refresh(); qc.invalidateQueries({ queryKey: ['org', org.id] }); toast({ kind: 'success', text: `Count submitted: ${r.applied} correction${r.applied === 1 ? '' : 's'} made${r.waitingForApproval ? `, ${r.waitingForApproval} waiting for approval` : ''}` }); },
    onError: fail,
  });
  const cancel = useMutation({ mutationFn: (id: string) => api('POST', `/orgs/${org.id}/count-tasks/${id}/cancel`, { body: {} }), onSuccess: () => { setOpenId(null); refresh(); toast({ text: 'Count cancelled' }); }, onError: fail });
  const submitForm = (fn: () => void) => (e: FormEvent) => { e.preventDefault(); fn(); };
  const when = (iso: string) => dateParts(iso).date;

  return (
    <>
      <header className="top-header"><div className="breadcrumb"><span>Inventory</span><h1 className="current">Counts</h1></div></header>
      <div className="settings">
        <section className="card">
          <h2>{assign ? 'Stock counts' : 'My counts'}</h2>
          {tasks.isError ? <p className="field-error" role="alert">Could not load counts.</p> : !tasks.data?.length ? <p className="hint">{tasks.isLoading ? 'Loading…' : assign ? 'No counts yet. Create one below.' : 'Nothing assigned to you.'}</p> : (
            <ul className="list">
              {tasks.data.map((x) => (
                <li key={x.id}>
                  <span><strong>{x.title ?? 'Stock count'}</strong> <span className="tag">{x.state}</span>{x.blind && <span className="tag">blind</span>}
                    <div className="time">{assign ? `For ${nameOf(x.assignedTo)} · ` : ''}{x.summary?.counted}/{x.summary?.total} counted{x.dueAt ? ` · due ${when(`${x.dueAt}T00:00:00Z`)}` : ''}{x.state === 'submitted' && x.summary ? ` · ${x.summary.variances} difference${x.summary.variances === 1 ? '' : 's'}` : ''}</div></span>
                  <button className="btn btn-outline" onClick={() => { setOpenId(openId === x.id ? null : x.id); setVals({}); }} aria-expanded={openId === x.id}>{x.state === 'open' ? 'Count' : 'View'}</button>
                </li>
              ))}
            </ul>
          )}
        </section>

        {openId && t && (
          <section className="card" aria-label="Count sheet">
            <h2>{t.title ?? 'Stock count'}</h2>
            <p className="hint">{t.blind && t.state === 'open' ? 'Count what is on the shelf. Expected quantities are hidden until you submit.' : 'Enter what you count. Leave blank anything you did not count.'}</p>
            <div className="orders-table-container">
              <table className="orders-table">
                <thead><tr><th>Product</th>{(t.state !== 'open' || !t.blind || assign) && <th className="num">System says</th>}<th className="num">Counted</th></tr></thead>
                <tbody>
                  {t.lines.map((l) => (
                    <tr key={l.productId}>
                      <td><strong>{l.name}</strong><div className="time">{l.sku}</div></td>
                      {(t.state !== 'open' || !t.blind || assign) && <td className="num">{l.expected ?? '—'}</td>}
                      <td className="num">
                        {t.state === 'open'
                          ? <input aria-label={`Counted ${l.name}`} className="mini" type="number" min={0} value={vals[l.productId] ?? (l.counted ?? '')} onChange={(e) => setVals({ ...vals, [l.productId]: e.target.value })} />
                          : <span className={l.counted !== null && l.expected !== null && l.counted !== l.expected ? 'status low' : ''}>{l.counted ?? 'not counted'}</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {t.state === 'open' && (
              <form className="row" onSubmit={submitForm(() => { if (confirm('Submit this count? Differences are written to stock now.')) submit.mutate(); })}>
                <button type="button" className="btn btn-outline" disabled={save.isPending || !payload().length} onClick={() => save.mutate()}>Save progress</button>
                <button className="btn btn-primary" disabled={submit.isPending}>{submit.isPending ? 'Submitting…' : 'Submit count'}</button>
                {assign && <button type="button" className="btn btn-outline" onClick={() => { if (confirm('Cancel this count?')) cancel.mutate(t.id); }}>Cancel count</button>}
              </form>
            )}
          </section>
        )}

        {assign && (
          <section className="card">
            <h2>New count</h2>
            <form className="settings-grid" onSubmit={submitForm(() => create.mutate())}>
              <div className="field"><label htmlFor="c-title">Title</label><input id="c-title" maxLength={100} value={f.title} placeholder="e.g. Aisle 3, weekly" onChange={(e) => setF({ ...f, title: e.target.value })} /></div>
              <div className="field"><label htmlFor="c-loc">Location</label><select id="c-loc" value={f.locationId || sites[0]?.id} onChange={(e) => setF({ ...f, locationId: e.target.value })}>{sites.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></div>
              <div className="field"><label htmlFor="c-kind">Which products</label>
                <select id="c-kind" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}><option value="all">Everything</option><option value="tag">A tag</option><option value="stale">Not counted for a while</option></select></div>
              {f.kind === 'tag' && <div className="field"><label htmlFor="c-tag">Tag</label><input id="c-tag" value={f.tag} onChange={(e) => setF({ ...f, tag: e.target.value })} /></div>}
              {f.kind === 'stale' && <div className="field"><label htmlFor="c-days">Days since last count</label><input id="c-days" type="number" min={1} max={365} value={f.days} onChange={(e) => setF({ ...f, days: e.target.value })} /></div>}
              <div className="field"><label htmlFor="c-who">Assign to</label>
                <select id="c-who" value={f.assignedTo} onChange={(e) => setF({ ...f, assignedTo: e.target.value })}><option value="">Anyone who can count</option>{members.data?.filter((m) => !m.deactivatedAt && m.id !== me.data?.user.id).map((m) => <option key={m.id} value={m.id}>{m.name} ({m.role})</option>)}</select></div>
              <div className="field"><label htmlFor="c-due">Due</label><input id="c-due" type="date" value={f.dueAt} onChange={(e) => setF({ ...f, dueAt: e.target.value })} /></div>
              <label className="check"><input type="checkbox" checked={f.blind} onChange={(e) => setF({ ...f, blind: e.target.checked })} /> Blind count (hide expected quantities from the counter)</label>
              <button className="btn btn-primary" disabled={create.isPending || (f.kind === 'tag' && !f.tag.trim())}>Create count</button>
            </form>
          </section>
        )}
      </div>
    </>
  );
}
