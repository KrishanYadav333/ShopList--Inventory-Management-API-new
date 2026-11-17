import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { REPORTS, REPORT_TITLES, type ReportName, type ReportResult } from '@shoplist/shared';
import { api, ApiError } from '../api';
import { useShell } from '../components/Shell';
import { dateParts } from '../format';
import { useLocations } from '../queries';

const iso = (d: Date) => d.toISOString().slice(0, 10);

export function ReportsPage() {
  const { org } = useShell();
  const [name, setName] = useState<ReportName>('sales');
  const [from, setFrom] = useState(iso(new Date(Date.now() - 29 * 86400_000)));
  const [to, setTo] = useState(iso(new Date()));
  const [location, setLocation] = useState('');
  const [days, setDays] = useState(60);
  const locations = useLocations(org.id);
  const qs = new URLSearchParams({ from, to, days: String(days), ...(location ? { location } : {}) }).toString();
  const q = useQuery({ queryKey: ['org', org.id, 'report', name, qs], queryFn: () => api<ReportResult>('GET', `/orgs/${org.id}/reports/${name}?${qs}`) });
  const r = q.data;
  const money = (v: unknown) => (v == null || v === '' ? '—' : new Intl.NumberFormat(undefined, { style: 'currency', currency: org.currency }).format(Number(v) / 100));
  const cell = (kind: string, v: unknown) => (v == null || v === '' ? '—' : kind === 'money' ? money(v) : kind === 'int' ? Number(v).toLocaleString() : kind === 'date' ? dateParts(`${v}T00:00:00Z`).date : String(v));
  const max = name === 'sales' && r ? Math.max(1, ...r.rows.map((x) => Number(x.revenue) || Number(x.units) || 0)) : 1;

  return (
    <>
      <header className="top-header"><div className="breadcrumb"><span>Inventory</span><h1 className="current">Reports</h1></div></header>
      <div className="settings">
        <section className="card">
          <div className="settings-grid">
            <div className="field"><label htmlFor="r-name">Report</label>
              <select id="r-name" value={name} onChange={(e) => setName(e.target.value as ReportName)}>{REPORTS.map((n) => <option key={n} value={n}>{REPORT_TITLES[n]}</option>)}</select></div>
            {(name === 'sales' || name === 'sales-by-product' || name === 'movements' || name === 'shrinkage') && <>
              <div className="field"><label htmlFor="r-from">From</label><input id="r-from" type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} /></div>
              <div className="field"><label htmlFor="r-to">To</label><input id="r-to" type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} /></div>
            </>}
            {name === 'dead-stock' && <div className="field"><label htmlFor="r-days">No sales in the last (days)</label><input id="r-days" type="number" min={1} max={365} value={days} onChange={(e) => setDays(Number(e.target.value) || 60)} /></div>}
            {name !== 'low-stock' && name !== 'dead-stock' && (locations.data?.length ?? 0) > 1 && (
              <div className="field"><label htmlFor="r-loc">Location</label>
                <select id="r-loc" value={location} onChange={(e) => setLocation(e.target.value)}><option value="">All locations</option>{locations.data?.filter((l) => !l.archivedAt).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></div>
            )}
            <a className="btn btn-outline" href={`/api/v1/orgs/${org.id}/reports/${name}?${qs}&format=csv`} download>Download CSV</a>
          </div>
        </section>
        <section className="card" aria-live="polite">
          <h2>{r?.title ?? REPORT_TITLES[name]}</h2>
          {r && <p className="hint">{r.from} to {r.to}{r.note ? ` · ${r.note}` : ''}</p>}
          {q.isError ? <p className="field-error" role="alert">{(q.error as ApiError).message}</p> : !r ? <p className="hint">Loading…</p> : !r.rows.length ? <p className="hint">Nothing to show for this period.</p> : (
            <div className="orders-table-container">
              <table className="orders-table">
                <thead><tr>{r.columns.map((c) => <th key={c.key} className={c.kind === 'text' || c.kind === 'date' ? '' : 'num'}>{c.label}</th>)}</tr></thead>
                <tbody>
                  {r.rows.map((row, i) => (
                    <tr key={i}>
                      {r.columns.map((c, ci) => (
                        <td key={c.key} className={c.kind === 'text' || c.kind === 'date' ? '' : 'num'}>
                          {cell(c.kind, row[c.key])}
                          {name === 'sales' && ci === 0 && <div className="bar" style={{ width: `${Math.round(((Number(row.revenue) || Number(row.units) || 0) / max) * 100)}%` }} aria-hidden="true" />}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
                {r.totals && <tfoot><tr>{r.columns.map((c, i) => <th key={c.key} className={c.kind === 'text' || c.kind === 'date' ? '' : 'num'}>{i === 0 ? 'Total' : r.totals![c.key] != null ? cell(c.kind, r.totals![c.key]) : ''}</th>)}</tr></tfoot>}
              </table>
            </div>
          )}
        </section>
      </div>
    </>
  );
}
