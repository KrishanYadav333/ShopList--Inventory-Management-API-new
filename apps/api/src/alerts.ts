import type { Bindings } from './env';
import { notify } from './notify';
import { newId, nowIso } from './util';

/** What the sign-in log can raise. Severity decides how it is shown, not whether it is raised. */
export const ALERT_KINDS = {
  repeated_refusals: { severity: 'medium', label: 'Five or more refused sign-ins for one address in a day' },
  owner_door: { severity: 'high', label: 'Someone was refused at the owner sign-in' },
  admin_new_country: { severity: 'medium', label: 'A business admin signed in from a new country' },
  not_me: { severity: 'high', label: 'A person reported a sign-in that was not theirs' },
} as const;
export type AlertKind = keyof typeof ALERT_KINDS;
export const ALERT_STATES = ['open', 'investigating', 'resolved', 'dismissed'] as const;
export const ALERT_KEEP_DAYS = 180;

interface Found { kind: AlertKind; subject: string | null; count: number; detail?: Record<string, unknown> }

/** Looks at the last day of sign-in events and writes at most one alert per source per day. Returns how many are new. */
export async function detectAlerts(env: Bindings): Promise<{ created: number; updated: number }> {
  const day = nowIso().slice(0, 10);
  const since = new Date(Date.now() - 86400_000).toISOString();
  const found: Found[] = [];

  const rep = await env.DB.prepare(`SELECT email_hash AS h, COUNT(*) AS n FROM auth_events WHERE kind = 'signin_refused' AND email_hash IS NOT NULL AND at >= ? GROUP BY email_hash HAVING COUNT(*) >= 5`).bind(since).all<{ h: string; n: number }>();
  for (const r of rep.results) found.push({ kind: 'repeated_refusals', subject: r.h, count: r.n });

  const door = await env.DB.prepare(`SELECT COUNT(*) AS n, MAX(country) AS country FROM auth_events WHERE kind = 'signin_refused' AND door = 'github' AND at >= ?`).bind(since).first<{ n: number; country: string | null }>();
  if (door && door.n > 0) found.push({ kind: 'owner_door', subject: 'owner-door', count: door.n, detail: { country: door.country } });

  const away = await env.DB.prepare(
    `SELECT e.user_id AS u, e.country AS country, COUNT(*) AS n FROM auth_events e
      WHERE e.kind = 'signin_ok' AND e.at >= ? AND e.country IS NOT NULL
        AND EXISTS (SELECT 1 FROM auth_events p WHERE p.user_id = e.user_id AND p.kind = 'signin_ok' AND p.at < e.at)
        AND NOT EXISTS (SELECT 1 FROM auth_events p WHERE p.user_id = e.user_id AND p.kind = 'signin_ok' AND p.at < e.at AND p.country = e.country)
        AND EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = e.user_id AND m.role = 'admin')
      GROUP BY e.user_id, e.country`,
  ).bind(since).all<{ u: string; country: string; n: number }>();
  for (const r of away.results) found.push({ kind: 'admin_new_country', subject: `${r.u}|${r.country}`, count: r.n, detail: { country: r.country } });

  const notMe = await env.DB.prepare(`SELECT user_id AS u, COUNT(*) AS n FROM auth_events WHERE kind = 'not_me' AND user_id IS NOT NULL AND at >= ? GROUP BY user_id`).bind(since).all<{ u: string; n: number }>();
  for (const r of notMe.results) found.push({ kind: 'not_me', subject: r.u, count: r.n });

  let created = 0, updated = 0;
  const fresh: Found[] = [];
  const now = nowIso();
  for (const f of found) {
    const key = `${f.kind}:${f.subject ?? ''}:${day}`;
    const ins = await env.DB.prepare(`INSERT OR IGNORE INTO security_alerts(id, kind, severity, subject, dedupe_key, count, detail, first_at, last_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(newId('sal'), f.kind, ALERT_KINDS[f.kind].severity, f.subject, key, f.count, f.detail ? JSON.stringify(f.detail) : null, now, now, now).run();
    if (ins.meta.changes) { created++; fresh.push(f); }
    else { await env.DB.prepare(`UPDATE security_alerts SET count = ?, last_at = ? WHERE dedupe_key = ?`).bind(f.count, now, key).run(); updated++; }
  }
  if (fresh.length) {
    const owner = await env.DB.prepare(`SELECT user_id AS id FROM oauth_accounts WHERE provider = 'github' AND provider_user_id = ?`).bind(env.SUPER_ADMIN_GITHUB_ID ?? '').first<{ id: string }>();
    // One notice per run, however many alerts it found, so a bad hour is one email and not twenty.
    if (owner) await notify(env, '_platform', [owner.id], { kind: 'security.alert', title: fresh.length === 1 ? ALERT_KINDS[fresh[0]!.kind].label : `${fresh.length} new security alerts`, link: '/admin/security' });
  }
  return { created, updated };
}

export async function pruneAlerts(env: Pick<Bindings, 'DB'>): Promise<number> {
  const cutoff = new Date(Date.now() - ALERT_KEEP_DAYS * 86400_000).toISOString();
  const r = await env.DB.prepare(`DELETE FROM security_alerts WHERE state IN ('resolved', 'dismissed') AND updated_at < ?`).bind(cutoff).run();
  return r.meta.changes ?? 0;
}
