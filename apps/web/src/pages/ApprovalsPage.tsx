import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ApprovalView } from '@shoplist/shared';
import { api, ApiError } from '../api';
import { useShell } from '../components/Shell';
import { dateParts } from '../format';
import { canDo } from '../queries';
import { useToast } from '../toast';

const STATE_LABEL: Record<string, string> = { pending: 'Waiting', approved: 'Approved', applied: 'Approved and done', rejected: 'Not approved', withdrawn: 'Withdrawn', expired: 'Expired', failed: 'Could not be applied' };

export function ApprovalsPage() {
  const { org } = useShell();
  const toast = useToast();
  const qc = useQueryClient();
  const decide = canDo(org.role, 'approvals:decide');
  const q = useQuery({ queryKey: ['org', org.id, 'approvals'], queryFn: () => api<{ data: ApprovalView[]; pending: number | null }>('GET', `/orgs/${org.id}/approvals?limit=100`), refetchInterval: 30_000 });
  const refresh = () => { qc.invalidateQueries({ queryKey: ['org', org.id] }); };
  const fail = (e: ApiError) => { toast({ kind: 'error', text: e.message }); refresh(); };
  const approve = useMutation({ mutationFn: (id: string) => api<{ approval: ApprovalView }>('POST', `/orgs/${org.id}/approvals/${id}/approve`, { body: {} }), onSuccess: (r) => { refresh(); toast(r.approval.state === 'applied' ? { kind: 'success', text: 'Approved and applied' } : { kind: 'error', text: `Could not be applied: ${r.approval.note ?? ''}` }); }, onError: fail });
  const reject = useMutation({ mutationFn: (v: { id: string; note: string }) => api('POST', `/orgs/${org.id}/approvals/${v.id}/reject`, { body: { note: v.note } }), onSuccess: () => { refresh(); toast({ text: 'Rejected' }); }, onError: fail });
  const withdraw = useMutation({ mutationFn: (id: string) => api('POST', `/orgs/${org.id}/approvals/${id}/withdraw`, { body: {} }), onSuccess: () => { refresh(); toast({ text: 'Withdrawn' }); }, onError: fail });

  const rows = q.data?.data ?? [];
  const pending = rows.filter((r) => r.state === 'pending');
  const past = rows.filter((r) => r.state !== 'pending');
  const when = (iso: string) => { const { date, time } = dateParts(iso); return `${date} ${time}`; };

  return (
    <>
      <header className="top-header"><div className="breadcrumb"><span>Inventory</span><h1 className="current">Approvals</h1></div></header>
      <div className="settings">
        <section className="card">
          <h2>{decide ? 'Waiting for you' : 'My requests waiting'}</h2>
          {q.isError ? <p className="hint">Could not load approvals.</p> : !pending.length ? <p className="hint">{q.isLoading ? 'Loading…' : decide ? 'Nothing needs your approval.' : 'Nothing waiting.'}</p> : (
            <ul className="list">
              {pending.map((a) => (
                <li key={a.id}>
                  <span><strong>{a.summary}</strong><div className="time">asked {when(a.createdAt)} · expires {dateParts(a.expiresAt).date}</div></span>
                  <span className="row">
                    {decide && <button className="btn btn-primary" disabled={approve.isPending} onClick={() => approve.mutate(a.id)}>Approve</button>}
                    {decide && <button className="btn btn-outline" onClick={() => { const note = prompt('Why not? This is shown to the person who asked.'); if (note?.trim()) reject.mutate({ id: a.id, note: note.trim() }); }}>Reject</button>}
                    {!decide && <button className="btn btn-outline" onClick={() => withdraw.mutate(a.id)}>Withdraw</button>}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="card">
          <h2>{decide ? 'Decided' : 'My earlier requests'}</h2>
          {!past.length ? <p className="hint">Nothing yet.</p> : (
            <ul className="list">
              {past.map((a) => <li key={a.id}><span><strong>{a.summary}</strong><div className="time">{STATE_LABEL[a.state] ?? a.state}{a.note ? ` · ${a.note}` : ''} · {when(a.decidedAt ?? a.createdAt)}</div></span></li>)}
            </ul>
          )}
        </section>
      </div>
    </>
  );
}
