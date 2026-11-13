import { useMemo, useState } from 'react';
import { MOVEMENT_REASONS } from '@shoplist/shared';
import type { ApiError } from '../api';
import { useShell } from '../components/Shell';
import { dateParts, REASON_LABELS } from '../format';
import { Icon } from '../icons';
import { useLocations, useMe, useMovements } from '../queries';

export function HistoryPage() {
  const { org } = useShell();
  const [reason, setReason] = useState('');
  const [locationId, setLocationId] = useState('');
  const me = useMe();
  const locations = useLocations(org.id);
  const q = useMovements(org.id, { reason: reason || undefined, locationId: locationId || undefined });
  const rows = useMemo(() => q.data?.pages.flatMap((p) => p.data) ?? [], [q.data]);
  const locName = (id: string) => locations.data?.find((l) => l.id === id)?.name ?? '—';
  const who = (actor: string) => (actor === me.data?.user.id ? 'You' : actor.startsWith('key_') ? 'API key' : 'Teammate');

  return (
    <>
      <header className="top-header">
        <div className="breadcrumb"><span>Inventory</span><Icon name="chevron" size={12} /><span className="current">Stock history</span></div>
        <div className="header-actions">
          <select className="top-select" aria-label="Reason" value={reason} onChange={(e) => setReason(e.target.value)}>
            <option value="">All reasons</option>
            {MOVEMENT_REASONS.map((r) => <option key={r} value={r}>{REASON_LABELS[r]}</option>)}
          </select>
          <select className="top-select" aria-label="Location" value={locationId} onChange={(e) => setLocationId(e.target.value)}>
            <option value="">All locations</option>
            {locations.data?.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        </div>
      </header>
      <div className="orders-table-container">
        {q.isError ? (
          <div className="state"><Icon name="alert" size={28} /><h3>Could not load history</h3><p>{(q.error as ApiError).message}</p><button className="btn btn-primary" onClick={() => q.refetch()}>Try again</button></div>
        ) : q.isLoading || (rows.length === 0 && q.isFetching) ? (
          <table className="orders-table"><tbody>{Array.from({ length: 8 }, (_, i) => <tr key={i} className="skeleton-row"><td colSpan={6}><div className="skeleton" /></td></tr>)}</tbody></table>
        ) : !rows.length ? (
          <div className="state"><Icon name="clock" size={32} /><h3>No stock movements yet</h3><p>Every change to stock is recorded here, with who did it and why.</p></div>
        ) : (
          <>
            <table className="orders-table history-table">
              <thead><tr><th>When</th><th>Reason</th><th>Product</th><th>Location</th><th className="num">Change</th><th className="num">Balance</th><th>By</th></tr></thead>
              <tbody>
                {rows.map((m) => {
                  const { date, time } = dateParts(m.createdAt);
                  return (
                    <tr key={m.id}>
                      <td className="date-col"><div className="date">{date}</div><div className="time">{time}</div></td>
                      <td><span className="status ready">{REASON_LABELS[m.reason] ?? m.reason}</span>{m.reference && <div className="time">{m.reference}</div>}</td>
                      <td className="items-col"><div className="order-id">{m.productSku ?? ''}</div><div className="item-desc">{m.productName ?? 'Deleted product'}</div>{m.note && <div className="time">{m.note}</div>}</td>
                      <td>{locName(m.locationId)}</td>
                      <td className={`num delta ${m.delta > 0 ? 'up' : 'down'}`}>{m.delta > 0 ? `+${m.delta}` : m.delta}</td>
                      <td className="num">{m.balance}</td>
                      <td>{who(m.actor)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div className="table-foot">
              <span>{rows.length} movement{rows.length === 1 ? '' : 's'}{q.hasNextPage ? '+' : ''} shown</span>
              {q.hasNextPage && <button className="btn btn-outline" onClick={() => q.fetchNextPage()} disabled={q.isFetchingNextPage}>{q.isFetchingNextPage ? 'Loading…' : 'Load more'}</button>}
            </div>
          </>
        )}
      </div>
    </>
  );
}
