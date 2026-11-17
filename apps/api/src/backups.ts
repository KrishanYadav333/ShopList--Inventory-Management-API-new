import type { Bindings } from './env';
import { nowIso } from './util';

export const BACKUP_KEEP_DAYS = 30;
const PART_BYTES = 1_500_000; // D1 rows are limited to 2 MB

async function gzip(text: string): Promise<Uint8Array> {
  return new Uint8Array(await new Response(new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
}
async function gunzip(bytes: Uint8Array): Promise<string> {
  return new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
}

/** Copies one business into D1 as gzip parts and records the outcome. A failure is recorded, never thrown. */
export async function backupOrg(env: Bindings, orgId: string, day = nowIso().slice(0, 10)): Promise<{ ok: boolean; bytes: number }> {
  try {
    const { json, rows } = await env.INVENTORY.get(env.INVENTORY.idFromName(orgId)).dumpAll();
    const zipped = await gzip(json);
    const parts: Uint8Array[] = [];
    for (let i = 0; i < zipped.length; i += PART_BYTES) parts.push(zipped.slice(i, i + PART_BYTES));
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM backups WHERE org_id = ? AND day = ?`).bind(orgId, day),
      ...parts.map((p, i) => env.DB.prepare(`INSERT INTO backups(org_id, day, part, data) VALUES (?, ?, ?, ?)`).bind(orgId, day, i, p.buffer.slice(p.byteOffset, p.byteOffset + p.byteLength))),
      env.DB.prepare(`INSERT INTO backup_runs(org_id, day, ok, size_bytes, parts, row_count, error, created_at) VALUES (?, ?, 1, ?, ?, ?, NULL, ?) ON CONFLICT(org_id, day) DO UPDATE SET ok = 1, size_bytes = excluded.size_bytes, parts = excluded.parts, row_count = excluded.row_count, error = NULL, created_at = excluded.created_at`).bind(orgId, day, zipped.length, parts.length, rows, nowIso()),
    ]);
    return { ok: true, bytes: zipped.length };
  } catch (e) {
    await env.DB.prepare(`INSERT INTO backup_runs(org_id, day, ok, error, created_at) VALUES (?, ?, 0, ?, ?) ON CONFLICT(org_id, day) DO UPDATE SET ok = 0, error = excluded.error, created_at = excluded.created_at`).bind(orgId, day, (e as Error).message.slice(0, 300), nowIso()).run().catch(() => undefined);
    return { ok: false, bytes: 0 };
  }
}

/** Nightly: every business that still exists, then the copies older than 30 days go. */
export async function runBackups(env: Bindings, day = nowIso().slice(0, 10)): Promise<{ ok: number; failed: number }> {
  const { results } = await env.DB.prepare(`SELECT id FROM organizations WHERE deleted_at IS NULL LIMIT 500`).all<{ id: string }>();
  let ok = 0, failed = 0;
  for (const o of results) (await backupOrg(env, o.id, day)).ok ? ok++ : failed++;
  const cutoff = new Date(Date.parse(`${day}T00:00:00Z`) - BACKUP_KEEP_DAYS * 86400_000).toISOString().slice(0, 10);
  await env.DB.batch([env.DB.prepare(`DELETE FROM backups WHERE day < ?`).bind(cutoff), env.DB.prepare(`DELETE FROM backup_runs WHERE day < ?`).bind(cutoff)]);
  return { ok, failed };
}

/** Reads a stored copy back as the JSON text the business object can load. */
export async function readBackup(env: Pick<Bindings, 'DB'>, orgId: string, day: string): Promise<string | null> {
  const { results } = await env.DB.prepare(`SELECT data FROM backups WHERE org_id = ? AND day = ? ORDER BY part`).bind(orgId, day).all<{ data: ArrayBuffer | number[] }>();
  if (!results.length) return null;
  const bufs = results.map((r) => new Uint8Array(r.data));
  const all = new Uint8Array(bufs.reduce((n, b) => n + b.length, 0));
  let off = 0;
  for (const b of bufs) { all.set(b, off); off += b.length; }
  return gunzip(all);
}
