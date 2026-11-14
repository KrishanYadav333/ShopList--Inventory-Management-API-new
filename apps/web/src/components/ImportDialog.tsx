import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { IMPORT_MAX_ROWS, type ImportResult } from '@shoplist/shared';
import { api, ApiError, newKey } from '../api';
import { autoMap, convertRows, FIELDS, parseCsv, type Field, type ParsedRow } from '../csv';
import { csvCell } from '../format';
import { type OrgSummary } from '../queries';
import { useToast } from '../toast';
import { Modal } from './Modal';

const MAX_BYTES = 5 * 1024 * 1024;
const MAX_ROWS = 20_000;
const TEMPLATE = 'sku,name,price,cost,quantity,barcode,reorder point,unit,tags,description\nMOUSE-001,Wireless Mouse,29.99,14.00,42,5012345678900,10,each,"office, accessories",Ergonomic wireless mouse\n';

interface Outcome { created: number; updated: number; unchanged: number; failed: { line: number; sku: string; error: string; raw: string[] }[] }

export function ImportDialog({ org, onClose }: { org: OrgSummary; onClose: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const cancelled = useRef(false);
  const [text, setText] = useState('');
  const [table, setTable] = useState<string[][] | null>(null);
  const [map, setMap] = useState<Record<Field, number> | null>(null);
  const [mode, setMode] = useState<'create' | 'upsert'>('create');
  const [error, setError] = useState('');
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  const load = (raw: string) => {
    setError('');
    const rows = parseCsv(raw);
    if (rows.length < 2) return setError('The file needs a header row and at least one product row.');
    if (rows.length - 1 > MAX_ROWS) return setError(`That file has ${rows.length - 1} rows. The limit is ${MAX_ROWS}; split it into smaller files.`);
    setTable(rows);
    setMap(autoMap(rows[0]));
  };

  async function onFile(f: File | undefined) {
    if (!f) return;
    if (f.size > MAX_BYTES) return setError('That file is larger than 5 MB.');
    load(await f.text());
  }

  const parsed: ParsedRow[] = table && map ? convertRows(table.slice(1), map) : [];
  const good = parsed.filter((p) => p.row);
  const bad = parsed.filter((p) => p.error);
  const missing = map ? FIELDS.filter((f) => f.required && map[f.key] < 0) : [];

  async function run() {
    cancelled.current = false;
    const out: Outcome = { created: 0, updated: 0, unchanged: 0, failed: bad.map((b) => ({ line: b.line, sku: b.raw[map!.sku] ?? '', error: b.error!, raw: b.raw })) };
    setProgress({ done: 0, total: good.length });
    try {
      for (let i = 0; i < good.length; i += IMPORT_MAX_ROWS) {
        if (cancelled.current) break;
        const batch = good.slice(i, i + IMPORT_MAX_ROWS);
        const key = newKey(); // reused if this batch is retried, so a retry never imports twice
        let res: { results: ImportResult[] } | null = null;
        for (let attempt = 0; attempt < 3 && !res; attempt++) {
          try {
            res = await api<{ results: ImportResult[] }>('POST', `/orgs/${org.id}/products/import`, { body: { mode, rows: batch.map((b) => b.row) }, idempotencyKey: key });
          } catch (e) {
            if (!(e instanceof ApiError) || (e.status !== 0 && e.status < 500)) throw e;
            if (attempt === 2) throw e;
            await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
          }
        }
        for (const r of res!.results) {
          if (r.status === 'created') out.created++;
          else if (r.status === 'updated') out.updated++;
          else if (r.status === 'unchanged') out.unchanged++;
          else out.failed.push({ line: batch[r.index].line, sku: r.sku, error: r.error ?? 'Rejected', raw: batch[r.index].raw });
        }
        setProgress({ done: Math.min(i + batch.length, good.length), total: good.length });
      }
    } catch (e) {
      toast({ kind: 'error', text: e instanceof ApiError ? e.message : 'The import stopped unexpectedly.' });
    }
    qc.invalidateQueries({ queryKey: ['org', org.id] });
    setProgress(null);
    setOutcome(out);
  }

  function downloadFailed() {
    const head = [...table![0], 'import error'];
    const lines = outcome!.failed.sort((a, b) => a.line - b.line).map((f) => [...f.raw, f.error].map(csvCell).join(','));
    const blob = new Blob([[head.map(csvCell).join(','), ...lines].join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'import-errors.csv';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  function downloadTemplate() {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([TEMPLATE], { type: 'text/csv;charset=utf-8' }));
    a.download = 'products-template.csv';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // ---------------------------------------------------------------- result
  if (outcome) {
    return (
      <Modal title="Import finished" onClose={onClose} wide>
        <div className="modal-body">
          <div className="tiles inner">
            {[['Created', outcome.created], ['Updated', outcome.updated], ['Unchanged', outcome.unchanged], ['Rejected', outcome.failed.length]].map(([l, n]) => <div className="tile" key={l as string}><div className="num">{n}</div><div className="lbl">{l}</div></div>)}
          </div>
          {outcome.failed.length > 0 && (
            <>
              <p>These rows were not imported. Fix them and import the file again; rows that already worked are safe to include.</p>
              <table className="diff"><thead><tr><th>Line</th><th>SKU</th><th>Problem</th></tr></thead>
                <tbody>{outcome.failed.slice(0, 50).map((f) => <tr key={f.line}><td>{f.line}</td><td>{f.sku}</td><td>{f.error}</td></tr>)}</tbody></table>
              {outcome.failed.length > 50 && <p className="hint">Showing 50 of {outcome.failed.length}. Download the full list below.</p>}
            </>
          )}
        </div>
        <div className="modal-foot">
          {outcome.failed.length > 0 && <button className="btn btn-outline" onClick={downloadFailed}>Download rejected rows</button>}
          <button className="btn btn-primary" onClick={onClose}>Done</button>
        </div>
      </Modal>
    );
  }

  // -------------------------------------------------------------- progress
  if (progress) {
    const pct = progress.total ? Math.round((progress.done / progress.total) * 100) : 100;
    return (
      <Modal title="Importing…" onClose={() => { cancelled.current = true; }}>
        <div className="modal-body">
          <div className="bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}><div style={{ width: `${pct}%` }} /></div>
          <p>{progress.done} of {progress.total} rows sent. Keep this window open.</p>
        </div>
        <div className="modal-foot"><button className="btn btn-outline" onClick={() => { cancelled.current = true; }}>Stop after this batch</button></div>
      </Modal>
    );
  }

  // ------------------------------------------------------------- map & preview
  if (table && map) {
    const headers = table[0];
    return (
      <Modal title="Import products" onClose={onClose} wide>
        <div className="modal-body">
          <p>{table.length - 1} rows found. Check that each column is matched to the right field.</p>
          <div className="form-grid">
            {FIELDS.map((f) => (
              <div className="field" key={f.key}>
                <label htmlFor={`m-${f.key}`}>{f.label}{f.required ? ' *' : ''}</label>
                <select id={`m-${f.key}`} value={map[f.key]} onChange={(e) => setMap({ ...map, [f.key]: Number(e.target.value) })}>
                  <option value={-1}>{f.required ? 'Choose a column…' : 'Not in my file'}</option>
                  {headers.map((h, i) => <option key={i} value={i}>{h || `Column ${i + 1}`}</option>)}
                </select>
              </div>
            ))}
          </div>
          <fieldset className="modes">
            <legend>If a SKU already exists</legend>
            <label className="check"><input type="radio" name="mode" checked={mode === 'create'} onChange={() => setMode('create')} /> Skip it and report it (safest)</label>
            <label className="check"><input type="radio" name="mode" checked={mode === 'upsert'} onChange={() => setMode('upsert')} /> Update it with the values from my file (quantity is set to the file's value)</label>
          </fieldset>
          {missing.length > 0 && <div className="field-error" role="alert">Choose a column for: {missing.map((m) => m.label).join(', ')}.</div>}
          <div className="summary-line"><strong>{good.length}</strong> ready to import{bad.length > 0 && <> · <strong className="short">{bad.length}</strong> with problems (these will be skipped)</>}</div>
          <table className="diff preview">
            <thead><tr><th>Line</th><th>SKU</th><th>Name</th><th className="num">Price</th><th className="num">Qty</th><th>Result</th></tr></thead>
            <tbody>
              {parsed.slice(0, 12).map((p) => (
                <tr key={p.line} className={p.error ? 'row-bad' : ''}>
                  <td>{p.line}</td><td>{(p.row?.sku as string) ?? p.raw[map.sku] ?? ''}</td><td>{(p.row?.name as string) ?? p.raw[map.name] ?? ''}</td>
                  <td className="num">{p.row ? ((p.row.priceMinor as number) / 100).toFixed(2) : ''}</td><td className="num">{(p.row?.quantity as number | undefined) ?? ''}</td>
                  <td>{p.error ?? 'OK'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {parsed.length > 12 && <p className="hint">Showing the first 12 of {parsed.length} rows.</p>}
        </div>
        <div className="modal-foot">
          <button className="btn btn-outline" onClick={() => { setTable(null); setMap(null); }}>Choose another file</button>
          <button className="btn btn-primary" disabled={!good.length || missing.length > 0} onClick={run}>Import {good.length} product{good.length === 1 ? '' : 's'}</button>
        </div>
      </Modal>
    );
  }

  // ----------------------------------------------------------------- choose
  return (
    <Modal title="Import products from CSV" onClose={onClose}>
      <div className="modal-body">
        <p>Upload a CSV exported from a spreadsheet or another system. Up to {MAX_ROWS.toLocaleString()} rows, 5 MB. Nothing is changed until you confirm.</p>
        <div className="field">
          <label htmlFor="csv-file">CSV file</label>
          <input id="csv-file" ref={fileRef} type="file" accept=".csv,text/csv" onChange={(e) => onFile(e.target.files?.[0])} />
        </div>
        <div className="field">
          <label htmlFor="csv-text">…or paste it here</label>
          <textarea id="csv-text" rows={5} value={text} onChange={(e) => setText(e.target.value)} placeholder={'sku,name,price,quantity\nMOUSE-001,Wireless Mouse,29.99,42'} />
        </div>
        {error && <div className="field-error" role="alert">{error}</div>}
        <button type="button" className="link-name" onClick={downloadTemplate}>Download a template</button>
      </div>
      <div className="modal-foot">
        <button className="btn btn-outline" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={!text.trim()} onClick={() => load(text)}>Continue</button>
      </div>
    </Modal>
  );
}
