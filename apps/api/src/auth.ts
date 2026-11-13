import type { Bindings } from './env';
import { AppError } from './errors';
import { base64url, newId, nowIso, randomToken, safeEqual, sha256Hex } from './util';

export const SESSION_COOKIE = 'sl_session'; // sent as __Host-sl_session (Hono adds the prefix)
export const OAUTH_COOKIE = 'sl_oauth';

const IDLE_MS = 12 * 60 * 60 * 1000;
const ABSOLUTE_MS = 30 * 24 * 60 * 60 * 1000;
const SLIDE_AFTER_MS = 60 * 60 * 1000;

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
  /** True only for the account linked to SUPER_ADMIN_GITHUB_ID. Computed per request, never stored. */
  isSuperAdmin: boolean;
}

/** Sign-in is closed unless the deployment explicitly opts in. */
export const signinClosed = (env: Pick<Bindings, 'SIGNIN_MODE'>) => (env.SIGNIN_MODE ?? 'admin-only') !== 'open';

/** The one rule for who may use the app. Pure so it can be tested directly. */
export const mayUse = (env: Pick<Bindings, 'SIGNIN_MODE'>, user: Pick<AuthUser, 'isSuperAdmin'>) => user.isSuperAdmin || !signinClosed(env);

// ------------------------------------------------------------------ sessions
/** Creates a session and returns the raw token. Only its SHA-256 is stored. */
export type SessionProvider = 'github' | 'clerk' | 'dev';

export async function createSession(env: Bindings, userId: string, req: Request, provider: SessionProvider): Promise<string> {
  const token = randomToken(32);
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO sessions(token_hash, user_id, created_at, expires_at, last_seen_at, user_agent, ip_country, provider) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      await sha256Hex(token),
      userId,
      new Date(now).toISOString(),
      new Date(now + ABSOLUTE_MS).toISOString(),
      new Date(now).toISOString(),
      (req.headers.get('user-agent') ?? '').slice(0, 200) || null,
      (req.headers.get('cf-ipcountry') ?? '').slice(0, 2) || null,
      provider,
    )
    .run();
  return token;
}

export async function userFromSession(env: Bindings, token: string | undefined): Promise<AuthUser | null> {
  if (!token || token.length > 100) return null;
  const hash = await sha256Hex(token);
  const row = await env.DB.prepare(
    `SELECT u.id, u.email, u.name, u.avatar_url, s.expires_at, s.last_seen_at,
            (s.provider IN ('github', 'dev') AND EXISTS (SELECT 1 FROM oauth_accounts o WHERE o.user_id = u.id AND o.provider = 'github' AND o.provider_user_id = ?)) AS is_super
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND u.disabled_at IS NULL`,
  )
    .bind(env.SUPER_ADMIN_GITHUB_ID ?? '', hash)
    .first<{ id: string; email: string; name: string; avatar_url: string | null; expires_at: string; last_seen_at: string; is_super: number }>();
  if (!row) return null;
  const now = Date.now();
  if (Date.parse(row.expires_at) <= now || Date.parse(row.last_seen_at) + IDLE_MS <= now) {
    await env.DB.prepare(`DELETE FROM sessions WHERE token_hash = ?`).bind(hash).run();
    return null;
  }
  // Slide the idle window at most once an hour, to keep D1 writes low.
  if (Date.parse(row.last_seen_at) + SLIDE_AFTER_MS <= now) {
    await env.DB.prepare(`UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?`).bind(nowIso(), hash).run();
  }
  return { id: row.id, email: row.email, name: row.name, avatarUrl: row.avatar_url, isSuperAdmin: row.is_super === 1 };
}

export async function destroySession(env: Bindings, token: string | undefined): Promise<void> {
  if (token) await env.DB.prepare(`DELETE FROM sessions WHERE token_hash = ?`).bind(await sha256Hex(token)).run();
}

// --------------------------------------------------------------------- users
export async function upsertUser(env: Bindings, profile: { email: string; name: string; avatarUrl?: string | null }, link?: { provider: string; providerUserId: string }): Promise<AuthUser> {
  const email = profile.email.trim().toLowerCase();
  type Row = { id: string; email: string; name: string; avatar_url: string | null; disabled_at: string | null };
  const done = (r: Row): AuthUser => {
    // A disabled account must not sign in again (and must not fall through to creating a duplicate).
    if (r.disabled_at) throw new AppError(403, 'account_disabled', 'This account has been disabled.');
    return { id: r.id, email: r.email, name: r.name, avatarUrl: r.avatar_url, isSuperAdmin: false };
  };
  if (link) {
    const hit = await env.DB.prepare(`SELECT u.id, u.email, u.name, u.avatar_url, u.disabled_at FROM oauth_accounts o JOIN users u ON u.id = o.user_id WHERE o.provider = ? AND o.provider_user_id = ?`)
      .bind(link.provider, link.providerUserId)
      .first<Row>();
    if (hit) return done(hit);
  }
  // Callers pass only provider-verified emails, so linking to an existing account by email is safe.
  let user = await env.DB.prepare(`SELECT id, email, name, avatar_url, disabled_at FROM users WHERE email = ?`).bind(email).first<Row>();
  if (!user) {
    const id = newId('usr');
    await env.DB.prepare(`INSERT INTO users(id, email, name, avatar_url, created_at) VALUES (?, ?, ?, ?, ?)`)
      .bind(id, email, profile.name.slice(0, 100) || email, profile.avatarUrl ?? null, nowIso())
      .run();
    user = { id, email, name: profile.name, avatar_url: profile.avatarUrl ?? null, disabled_at: null };
  }
  const result = done(user);
  if (link) {
    await env.DB.prepare(`INSERT OR IGNORE INTO oauth_accounts(provider, provider_user_id, user_id) VALUES (?, ?, ?)`).bind(link.provider, link.providerUserId, user.id).run();
  }
  return result;
}

// --------------------------------------------------------- signed OAuth state
async function hmac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return base64url(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data))));
}

export async function signPayload(env: Bindings, payload: object): Promise<string> {
  if (!env.COOKIE_SIGNING_KEY) throw new AppError(503, 'oauth_not_configured', 'Sign-in is not configured on this server.');
  const body = base64url(new TextEncoder().encode(JSON.stringify(payload)));
  return `${body}.${await hmac(env.COOKIE_SIGNING_KEY, body)}`;
}

export async function verifyPayload<T>(env: Bindings, value: string | undefined): Promise<T | null> {
  if (!value || !env.COOKIE_SIGNING_KEY) return null;
  const [body, sig] = value.split('.');
  if (!body || !sig || !safeEqual(sig, await hmac(env.COOKIE_SIGNING_KEY, body))) return null;
  try {
    const padded = body.replaceAll('-', '+').replaceAll('_', '/');
    const json = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(json, (c) => c.charCodeAt(0)))) as T;
  } catch {
    return null;
  }
}

// --------------------------------------------------------------- GitHub OAuth
export async function pkcePair(): Promise<{ verifier: string; challenge: string }> {
  const verifier = randomToken(48);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return { verifier, challenge: base64url(new Uint8Array(digest)) };
}

export function githubAuthorizeUrl(env: Bindings, state: string, challenge: string): string {
  if (!env.GITHUB_CLIENT_ID) throw new AppError(503, 'oauth_not_configured', 'GitHub sign-in is not configured on this server.');
  const url = new URL('https://github.com/login/oauth/authorize');
  url.search = new URLSearchParams({
    client_id: env.GITHUB_CLIENT_ID,
    redirect_uri: `${env.APP_ORIGIN}/api/v1/auth/oauth/github/callback`,
    scope: 'read:user user:email',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    allow_signup: 'true',
  }).toString();
  return url.toString();
}

export async function githubProfile(env: Bindings, code: string, verifier: string): Promise<{ id: string; email: string; name: string; avatarUrl: string | null }> {
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) throw new AppError(503, 'oauth_not_configured', 'GitHub sign-in is not configured on this server.');
  const headers = { accept: 'application/json', 'user-agent': 'shoplist' };
  const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
      code_verifier: verifier,
      redirect_uri: `${env.APP_ORIGIN}/api/v1/auth/oauth/github/callback`,
    }),
  });
  const token = (await tokenRes.json().catch(() => ({}))) as { access_token?: string };
  if (!tokenRes.ok || !token.access_token) throw new AppError(400, 'oauth_failed', 'GitHub did not accept the sign-in. Please try again.');
  const auth = { ...headers, authorization: `Bearer ${token.access_token}` };
  const [userRes, emailRes] = await Promise.all([fetch('https://api.github.com/user', { headers: auth }), fetch('https://api.github.com/user/emails', { headers: auth })]);
  if (!userRes.ok || !emailRes.ok) throw new AppError(400, 'oauth_failed', 'Could not read your GitHub profile. Please try again.');
  const user = (await userRes.json()) as { id: number; login: string; name: string | null; avatar_url: string | null };
  const emails = (await emailRes.json()) as { email: string; primary: boolean; verified: boolean }[];
  const primary = emails.find((e) => e.primary && e.verified);
  if (!primary) throw new AppError(400, 'email_not_verified', 'Your GitHub account needs a verified primary email address.');
  return { id: String(user.id), email: primary.email, name: user.name || user.login, avatarUrl: user.avatar_url };
}
