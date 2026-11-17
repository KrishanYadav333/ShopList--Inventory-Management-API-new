import type { Bindings } from './env';
import { newId, nowIso, sha256Hex } from './util';

export const AUTH_EVENT_KINDS = ['signin_ok', 'signin_refused', 'signout', 'session_revoked', 'passkey_added', 'passkey_removed', 'user_disabled', 'rate_limited', 'not_me'] as const;
export type AuthEventKind = (typeof AUTH_EVENT_KINDS)[number];
export const AUTH_EVENT_KEEP_DAYS = 90;

export const browserFamily = (ua: string | null | undefined): string => {
  const s = ua ?? '';
  if (/Edg\//.test(s)) return 'Edge';
  if (/Firefox\//.test(s)) return 'Firefox';
  if (/Chrome\/|CriOS\//.test(s)) return 'Chrome';
  if (/Safari\//.test(s)) return 'Safari';
  return s ? 'Other' : 'Unknown';
};

/** One-way, salted, truncated. Lets us count repeats for one address without storing the address. */
export async function hashOf(env: Pick<Bindings, 'COOKIE_SIGNING_KEY'>, value: string): Promise<string> {
  return (await sha256Hex(`${env.COOKIE_SIGNING_KEY ?? ''}|${value.trim().toLowerCase()}`)).slice(0, 24);
}

interface Detail { userId?: string; email?: string; door?: string; reason?: string; id?: string }

/** Never throws and never blocks sign-in: history is useful, not worth a failed login. */
export async function recordAuthEvent(env: Bindings, req: Request, kind: AuthEventKind, d: Detail = {}): Promise<void> {
  try {
    await env.DB.prepare(`INSERT OR IGNORE INTO auth_events(id, at, kind, user_id, email_hash, door, country, browser, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(
        d.id ?? newId('aev'),
        nowIso(),
        kind,
        d.userId ?? null,
        // Known users are recorded by id; the address is hashed only for people we do not know.
        d.userId || !d.email ? null : await hashOf(env, d.email),
        d.door ?? null,
        (req.headers.get('cf-ipcountry') ?? '').slice(0, 2) || null,
        browserFamily(req.headers.get('user-agent')),
        d.reason ?? null,
      )
      .run();
  } catch (e) {
    console.error(JSON.stringify({ level: 'error', message: 'auth event not recorded', error: (e as Error).message }));
  }
}

/** At most one rate-limit row per client per minute, so a flood cannot burn the write quota. */
export async function recordRateLimited(env: Bindings, req: Request): Promise<void> {
  const ip = req.headers.get('cf-connecting-ip') ?? 'unknown';
  const minute = Math.floor(Date.now() / 60_000);
  await recordAuthEvent(env, req, 'rate_limited', { id: `rl_${await hashOf(env, ip)}_${minute}`, reason: 'too_many_requests' });
}

export async function pruneAuthEvents(env: Pick<Bindings, 'DB'>): Promise<number> {
  const cutoff = new Date(Date.now() - AUTH_EVENT_KEEP_DAYS * 86400_000).toISOString();
  const r = await env.DB.prepare(`DELETE FROM auth_events WHERE at < ?`).bind(cutoff).run();
  return r.meta.changes ?? 0;
}
