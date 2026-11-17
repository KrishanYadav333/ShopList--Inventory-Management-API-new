import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { IMPORT_MAX_ROWS, parseBackup, type ImportResult, type ParsedBackup } from '@shoplist/shared';
import { api, ApiError, newKey } from '../api';
import { useToast } from '../toast';

interface Preview { backup: ParsedBackup; create: number; update: number; newLocations: number }
interface Done { created: number; updated: number; unchanged: number; failed: { sku: string; error: string }[]; locations: number }

/** Loads a backup file back into the business. Merge only: nothing is deleted, matching codes are updated, quantities are recorded as import movements. */
export function RestoreCard({ orgId, orgName }: { orgId: string; orgName: string }) {
  const toast = useToast();
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [fromOther, setFromOther] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<{ done: number; total: number } | null>(null);
  const [done, setDone] = useState<Done | null>(null);

  async function choose(file: File | undefined) {
    setPreview(null); setDone(null); setError(''); setFromOther(null);
    if (!file) return;
    if (file.size > 25 * 1024 * 1024) { setError('That file is too big to be a ShopList backup.'); return; }
    let raw: unknown;
    try { raw = JSON.parse(await file.text()); } catch { setError('That file could not be read. Is it a ShopList backup (.json)?'); return; }
    const r = parseBackup(raw);
    if (!r.ok) { setError(r.error); return; }
    try {
      const have = new Set<string>();
      let cursor: string | undefined;
      do {
        const page = await api<{ data: { sku: string }[]; nextCursor?: string | null }>('GET', `/orgs/${orgId}/products?limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
        page.data.forEach((p) => have.add(p.sku));
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      const locs = await api<{ data: { code: string }[] }>('GET', `/orgs/${orgId}/locations`);
      const haveLoc = new Set(locs.data.map((l) => l.code.toUpperCase()));
      setPreview({ backup: r.backup, update: r.backup.rows.filter((x) => have.has(x.sku)).length, create: r.backup.rows.filter((x) => !have.has(x.sku)).length, newLocations: r.backup.locations.filter((l) => !haveLoc.has(l.code)).length });
      if (r.backup.fromOrgId && r.backup.fromOrgId !== orgId) setFromOther(r.backup.fromName ?? 'another business');
    } catch (e) { setError(e instanceof ApiError ? e.message : 'Could not check your current products.'); }
  }

  async function restore() {
    if (!preview) return;
    const out: Done = { created: 0, updated: 0, unchanged: 0, failed: [], locations: 0 };
    const rows = preview.backup.rows;
    setBusy({ done: 0, total: rows.length });
    try {
      for (const l of preview.backup.locations) {
        try { await api('POST', `/orgs/${orgId}/locations`, { body: l }); out.locations++; } catch (e) { if (!(e instanceof ApiError) || e.status !== 409) throw e; }
      }
      for (let i = 0; i < rows.length; i += IMPORT_MAX_ROWS) {
        const batch = rows.slice(i, i + IMPORT_MAX_ROWS);
        const key = newKey();
        let res: { results: ImportResult[] } | null = null;
        for (let attempt = 0; attempt < 3 && !res; attempt++) {
          try { res = await api<{ results: ImportResult[] }>('POST', `/orgs/${orgId}/products/import`, { body: { mode: 'upsert', rows: batch }, idempotencyKey: key }); }
          catch (e) { if (!(e instanceof ApiError) || (e.status !== 0 && e.status < 500) || attempt === 2) throw e; await new Promise((r) => setTimeout(r, 800 * (attempt + 1))); }
        }
        for (const r of res!.results) {
          if (r.status === 'created') out.created++; else if (r.status === 'updated') out.updated++; else if (r.status === 'unchanged') out.unchanged++; else out.failed.push({ sku: r.sku, error: r.error ?? 'Rejected' });
        }
        setBusy({ done: Math.min(i + batch.length, rows.length), total: rows.length });
      }
      setDone(out); setPreview(null);
      qc.invalidateQueries({ queryKey: ['org', orgId] });
      toast({ kind: 'success', text: `Restored: ${out.created} added, ${out.updated} updated` });
    } catch (e) {
      setDone(out);
      toast({ kind: 'error', text: `${e instanceof ApiError ? e.message : 'The restore stopped.'} Nothing already done is lost; run it again to finish.` });
    } finally { setBusy(null); if (input.current) input.current.value = ''; }
  }

  return (
    <div className="restore" aria-labelledby="h-restore">
      <h3 id="h-restore">Restore from a backup file</h3>
      <p className="hint">Adds missing products and locations, and updates products with the same code. Nothing is deleted. Stock is set at your default location and recorded in the history. Running it twice is safe.</p>
      <div className="field"><label htmlFor="rs-file">Backup file (.json)</label><input id="rs-file" ref={input} type="file" accept="application/json,.json" disabled={!!busy} onChange={(e) => choose(e.target.files?.[0])} /></div>
      {error && <p role="alert" className="field-error">{error}</p>}
      {preview && (
        <div role="status">
          {fromOther && <p className="banner banner-warn">This backup is from “{fromOther}”, not {orgName}. You can still restore it: it is your data.</p>}
          <p><strong>{preview.backup.rows.length.toLocaleString()} products</strong>: {preview.create.toLocaleString()} will be added, {preview.update.toLocaleString()} already exist and will be updated. {preview.newLocations} new location{preview.newLocations === 1 ? '' : 's'}.{preview.backup.skipped.length ? ` ${preview.backup.skipped.length} in the file cannot be used and will be skipped.` : ''}</p>
          {preview.backup.skipped.length > 0 && <details><summary>Show skipped</summary><ul>{preview.backup.skipped.slice(0, 50).map((s, i) => <li key={i}>{s.sku}: {s.reason}</li>)}</ul></details>}
          <button className="btn btn-primary" onClick={restore} disabled={!!busy || !preview.backup.rows.length}>Restore now</button>
        </div>
      )}
      {busy && <p role="status"><progress max={busy.total} value={busy.done} aria-label="Restore progress" /> {busy.done.toLocaleString()} of {busy.total.toLocaleString()}</p>}
      {done && (
        <div role="status">
          <p><strong>Done.</strong> {done.created} added, {done.updated} updated, {done.unchanged} unchanged{done.locations ? `, ${done.locations} location${done.locations === 1 ? '' : 's'} added` : ''}.{done.failed.length ? ` ${done.failed.length} could not be restored:` : ''}</p>
          {done.failed.length > 0 && <ul>{done.failed.slice(0, 50).map((f, i) => <li key={i}>{f.sku}: {f.error}</li>)}</ul>}
        </div>
      )}
    </div>
  );
}
