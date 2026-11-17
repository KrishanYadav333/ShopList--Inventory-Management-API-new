import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { z, type ZodType } from 'zod';
import {
  SESSION_ONLY,
  can,
  countInput,
  apiKeyInput,
  importRequest,
  importRow,
  inviteInput,
  locationInput,
  memberPatch,
  movementInput,
  movementListQuery,
  orderInput,
  orderListQuery,
  orgInput,
  orgSettingsPatch,
  reportQuery,
  REPORTS,
  type ReportResult,
  SETTINGS_DEFAULTS,
  type OrgSettings,
  pageQuery,
  paidInput,
  productInput,
  productListQuery,
  productPatch,
  transferInput,
  webhookInput,
  type ImportResult,
  type Permission,
  type Role,
} from '@shoplist/shared';
import {
  OAUTH_COOKIE,
  acceptPendingInvitations,
  SESSION_COOKIE,
  createSession,
  destroySession,
  githubAuthorizeUrl,
  githubProfile,
  KEY_PREFIX,
  keyFromBearer,
  clerkAdmission,
  mayUse,
  pkcePair,
  signPayload,
  signinClosed,
  signinMode,
  upsertUser,
  userFromSession,
  verifyPayload,
  type ApiKeyPrincipal,
  type AuthUser,
} from './auth';
import type { Bindings } from './env';
import { buildOpenApi, renderDocsPage } from './docs';
import { checkWebhookUrl, flushEvents, forgetHooks, handleQueue, sendTestEvent, type DeliveryJob } from './webhooks';
import { verifyAssertion, verifyRegistration } from './webauthn';
import { KIND_LABELS, NOTIFICATION_KINDS } from './notify';
import { clerkConfigured, fetchClerkProfile, verifyClerkToken } from './clerk';
import { AppError, problemResponse, unwrap } from './errors';
import type { Caller, Idem } from './inventory-do';
import { base64url, decodeCursor, encodeCursor, newId, nowIso, randomToken, sha256Hex } from './util';

export { InventoryDO } from './inventory-do';

type Vars = { requestId: string; user: AuthUser; org: { id: string; role: Role; locationIds: string[] | null }; apiKey?: ApiKeyPrincipal };
type Ctx = Context<{ Bindings: Bindings; Variables: Vars }>;

const MAX_BODY = 64 * 1024;
const app = new Hono<{ Bindings: Bindings; Variables: Vars }>();

// ------------------------------------------------------------ global middleware
app.use('*', async (c, next) => {
  const requestId = newId('req');
  c.set('requestId', requestId);
  await next();
  const h = c.res.headers;
  h.set('X-Request-Id', requestId);
  h.set('X-Content-Type-Options', 'nosniff');
  h.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  h.set('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
  h.set('Permissions-Policy', 'camera=(self), geolocation=()');
  if (new URL(c.req.url).pathname.startsWith('/api/')) {
    h.set('Cache-Control', 'no-store');
    if (!h.has('Content-Security-Policy')) h.set('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
  }
});

/** CSRF defence in depth: SameSite=Lax cookie plus an Origin check on every state-changing request. */
const originCheck: MiddlewareHandler<{ Bindings: Bindings; Variables: Vars }> = async (c, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) return next();
  // An API-key client sends no cookies, so there is nothing for a cross-site page to ride on.
  if (c.req.header('authorization')?.startsWith(`Bearer ${KEY_PREFIX}`) && !c.req.header('cookie')) return next();
  const origin = c.req.header('origin');
  const allowed = new Set([new URL(c.req.url).origin, new URL(c.env.APP_ORIGIN).origin]);
  if (!origin || !allowed.has(origin)) throw new AppError(403, 'bad_origin', 'This request did not come from the ShopList app.');
  return next();
};

const rateLimit: MiddlewareHandler<{ Bindings: Bindings; Variables: Vars }> = async (c, next) => {
  if (c.env.LIMITER) {
    const key = c.req.header('cf-connecting-ip') ?? 'unknown';
    const { success } = await c.env.LIMITER.limit({ key });
    if (!success) {
      const res = problemResponse(new AppError(429, 'rate_limited', 'Too many requests. Please wait a few seconds and try again.').toProblem(c.get('requestId')));
      res.headers.set('Retry-After', '10');
      return res;
    }
  }
  return next();
};

app.onError((err, c) => {
  const requestId = c.get('requestId');
  if (err instanceof AppError) return problemResponse(err.toProblem(requestId));
  console.error(JSON.stringify({ level: 'error', requestId, message: err.message, stack: err.stack }));
  return problemResponse(new AppError(500, 'internal_error', 'Something went wrong on our side. Quote this request id if you contact support.').toProblem(requestId));
});

app.notFound((c) => problemResponse(new AppError(404, 'not_found', 'There is nothing at this address.').toProblem(c.get('requestId'))));

// ----------------------------------------------------------------- helpers
async function readJson<T>(c: Ctx, schema: ZodType<T>): Promise<{ data: T; raw: string }> {
  const declared = Number(c.req.header('content-length') ?? 0);
  if (declared > MAX_BODY) throw new AppError(413, 'body_too_large', 'The request body is too large.');
  const raw = await c.req.text();
  if (raw.length > MAX_BODY) throw new AppError(413, 'body_too_large', 'The request body is too large.');
  let json: unknown;
  try {
    json = raw ? JSON.parse(raw) : {};
  } catch {
    throw new AppError(400, 'invalid_json', 'The request body is not valid JSON.');
  }
  return { data: parse(schema, json), raw };
}

function parse<T>(schema: ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value);
  if (r.success) return r.data;
  const errors = r.error.issues.map((i) => ({ field: i.path.join('.') || undefined, code: i.code, message: i.message }));
  throw new AppError(400, 'validation_failed', errors[0]?.message ?? 'Some fields are not valid.', { errors });
}

async function idemFrom(c: Ctx, raw: string): Promise<Idem> {
  const key = c.req.header('idempotency-key');
  if (!key) throw new AppError(428, 'idempotency_key_required', 'Send an Idempotency-Key header so retries are safe.');
  if (key.length > 255) throw new AppError(400, 'invalid_idempotency_key', 'Idempotency-Key must be at most 255 characters.');
  return { key, hash: await sha256Hex(`${c.req.method} ${new URL(c.req.url).pathname}\n${raw}`) };
}

function ifMatch(c: Ctx): number {
  const header = c.req.header('if-match');
  if (!header) throw new AppError(428, 'if_match_required', 'Send an If-Match header with the product version you are editing.');
  const n = Number(header.replace(/^W\//, '').replaceAll('"', ''));
  if (!Number.isInteger(n) || n < 1) throw new AppError(400, 'invalid_if_match', 'If-Match must be the version number from the ETag.');
  return n;
}

const caller = (c: Ctx): Caller => ({ actor: c.get('user').id, requestId: c.get('requestId') });
/** People who cannot approve may hit a rule that needs a second pair of eyes: their action waits in the queue (202). */
async function needsApproval(c: Ctx, kind: 'movement' | 'count' | 'cancel_order' | 'price_drop', payload: Record<string, unknown>) {
  if (can(c.get('org').role, 'approvals:decide')) return null;
  return inventory(c).checkApproval(caller(c), kind, payload);
}

/** A member limited to some locations may only write at those. Reads are never limited. */
function needLocation(c: Ctx, locationId: string | null | undefined): void {
  const allowed = c.get('org').locationIds;
  if (allowed && (!locationId || !allowed.includes(locationId))) throw new AppError(403, 'location_not_allowed', 'You are not set up to work at that location. Ask your admin.');
}

const inventory = (c: Ctx) => c.env.INVENTORY.get(c.env.INVENTORY.idFromName(c.get('org').id));
const etag = (c: Ctx, version: number) => c.header('ETag', `"${version}"`);

// Cookies: __Host- + Secure in production. Browsers will not store Secure cookies over plain
// http://localhost, so local development can opt out, but only when DEV_AUTH is also on.
const relaxed = (c: Ctx) => c.env.DEV_AUTH === 'true' && c.env.INSECURE_DEV_COOKIES === 'true';
const cookiePrefix = (c: Ctx) => (relaxed(c) ? undefined : ('host' as const));
function cookieOptions(c: Ctx, maxAge: number) {
  return relaxed(c)
    ? { httpOnly: true, sameSite: 'Lax' as const, path: '/', maxAge }
    : { prefix: 'host' as const, httpOnly: true, secure: true, sameSite: 'Lax' as const, path: '/', maxAge };
}
const setSessionCookie = (c: Ctx, token: string) => setCookie(c, SESSION_COOKIE, token, cookieOptions(c, 30 * 86400));
const readSessionCookie = (c: Ctx) => getCookie(c, SESSION_COOKIE, cookiePrefix(c));
const clearCookie = (c: Ctx, name: string) => deleteCookie(c, name, relaxed(c) ? { path: '/' } : { prefix: 'host', path: '/', secure: true });

// ---------------------------------------------------------- access control
/** Cookie sessions only. Used by every route that API keys must never reach. */
const requireUser: MiddlewareHandler<{ Bindings: Bindings; Variables: Vars }> = async (c, next) => {
  const session = readSessionCookie(c);
  if (!session && c.req.header('authorization')?.startsWith(`Bearer ${KEY_PREFIX}`)) {
    throw new AppError(403, 'key_not_allowed', 'API keys can only be used for inventory. This needs a signed-in session.');
  }
  const user = await userFromSession(c.env, session);
  if (!user) throw new AppError(401, 'unauthenticated', 'Sign in to continue.');
  // Closed deployments: every request re-checks, so a session made before the mode changed stops working.
  if (!mayUse(c.env, user)) throw new AppError(403, 'signin_closed', 'This ShopList is private. Only the site owner can sign in.');
  c.set('user', user);
  return next();
};

/** Cookie session or an organization API key (`Authorization: Bearer sl_live_...`). Inventory routes only. */
const requireAuth: MiddlewareHandler<{ Bindings: Bindings; Variables: Vars }> = async (c, next) => {
  const header = c.req.header('authorization');
  if (!header?.startsWith('Bearer ')) return requireUser(c, next);
  const key = await keyFromBearer(c.env, header.slice(7).trim());
  c.set('apiKey', key);
  c.set('user', { id: `key_${key.id}`, email: '', name: key.name, avatarUrl: null, isSuperAdmin: false });
  return next();
};

/** Platform administration. Anyone else gets 404 so the admin area is not discoverable. */
const requireSuper: MiddlewareHandler<{ Bindings: Bindings; Variables: Vars }> = async (c, next) => {
  if (!c.get('user').isSuperAdmin) throw new AppError(404, 'not_found', 'There is nothing at this address.');
  return next();
};

/** The org id in the URL is checked against the caller's memberships before any Durable Object is touched. */
const orgAccess = (permission: Permission): MiddlewareHandler<{ Bindings: Bindings; Variables: Vars }> => async (c, next) => {
  const orgId = c.req.param('orgId') ?? '';
  const key = c.get('apiKey');
  if (key) {
    // A key is bound to one organization and can only read or write inventory.
    if (key.orgId !== orgId) throw new AppError(404, 'org_not_found', 'That organization does not exist.');
    // Inventory only: never members, invitations, the activity log or organization settings.
    const area = new URL(c.req.url).pathname.split('/')[5] ?? '';
    if (!['products', 'locations', 'stock', 'orders', 'dashboard'].includes(area)) throw new AppError(403, 'forbidden', 'API keys can only be used for inventory.');
    const live = await c.env.DB.prepare(`SELECT 1 AS x FROM organizations WHERE id = ? AND deleted_at IS NULL AND suspended_at IS NULL`).bind(orgId).first();
    if (!live) throw new AppError(404, 'org_not_found', 'That organization does not exist.');
    const granted: Role = key.scopes.includes('inventory:write') ? 'manager' : 'viewer';
    if (SESSION_ONLY.includes(permission) || !can(granted, permission)) {
      throw new AppError(403, 'forbidden', 'This API key does not have permission to do that.');
    }
    c.set('org', { id: orgId, role: granted, locationIds: null });
    return next();
  }
  const row = await c.env.DB.prepare(
    `SELECT m.role, m.location_ids AS locationIds FROM memberships m JOIN organizations o ON o.id = m.org_id WHERE m.org_id = ? AND m.user_id = ? AND m.deactivated_at IS NULL AND o.deleted_at IS NULL AND o.suspended_at IS NULL`,
  )
    .bind(orgId, c.get('user').id)
    .first<{ role: Role; locationIds: string | null }>();
  // Not a member: 404, so organization ids cannot be probed.
  if (!row) throw new AppError(404, 'org_not_found', 'That organization does not exist.');
  if (!can(row.role, permission)) throw new AppError(403, 'forbidden', `Your role (${row.role}) cannot do this. Ask your admin for access.`);
  let locationIds: string[] | null = null;
  try { locationIds = row.locationIds ? (JSON.parse(row.locationIds) as string[]) : null; } catch { locationIds = []; }
  c.set('org', { id: orgId, role: row.role, locationIds });
  return next();
};

// Every route must declare who may call it. The registry lets a test prove none was forgotten.
type Access = Permission | 'user' | 'super' | 'public';
export const ROUTES: { method: string; path: string; access: Access }[] = [];
const api = new Hono<{ Bindings: Bindings; Variables: Vars }>();
api.use('*', rateLimit, originCheck);

const COST_FIELDS = new Set(['costMinor', 'inventoryValueMinor']);
const stripCost = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map(stripCost);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).filter(([k]) => !COST_FIELDS.has(k)).map(([k, x]) => [k, stripCost(x)]));
  return v;
};
async function withoutCost(res: Response): Promise<Response> {
  const text = await res.text();
  let body: unknown;
  try { body = JSON.parse(text); } catch { return new Response(text, res); }
  const out = new Response(JSON.stringify(stripCost(body)), res);
  out.headers.delete('content-length');
  return out;
}

type Handler = (c: Ctx) => Response | Promise<Response>;
function route(method: 'get' | 'post' | 'patch' | 'delete', path: string, access: Access, handler: Handler): void {
  ROUTES.push({ method: method.toUpperCase(), path, access });
  const guards: MiddlewareHandler<{ Bindings: Bindings; Variables: Vars }>[] =
    access === 'public' ? [] : access === 'user' ? [requireUser] : access === 'super' ? [requireUser, requireSuper] : SESSION_ONLY.includes(access as Permission) ? [requireUser, orgAccess(access as Permission)] : [requireAuth, orgAccess(access)];
  // After a successful write, move any recorded events to the delivery queue without delaying the response.
  const wrapped: Handler = async (c) => {
    let res = await handler(c);
    const org = c.get('org');
    // Roles without cost:read never receive cost or inventory value, in any response from any route.
    if (org && !can(org.role, 'cost:read') && res.headers.get('content-type')?.includes('json')) res = await withoutCost(res);
    // `x-no-drain` lets local tests inspect the raw outbox. It only works when DEV_AUTH is on, never in production.
    const hold = c.env.DEV_AUTH === 'true' && c.req.header('x-no-drain') === '1';
    if (method !== 'get' && res.status < 400 && org && !hold) c.executionCtx.waitUntil(flushEvents(c.env, org.id).then(() => undefined, () => undefined));
    return res;
  };
  const handlers = [...guards, wrapped] as MiddlewareHandler[];
  (api[method] as (path: string, ...h: MiddlewareHandler[]) => unknown).call(api, path, ...handlers);
}

// -------------------------------------------------------------------- public
route('get', '/openapi.json', 'public', (c) => c.json(buildOpenApi(ROUTES, new URL(c.req.url).origin)));

route('get', '/health', 'public', (c) => c.json({ ok: true, signin: ({ 'admin-only': 'owner-only', invite: 'invite-only', open: 'open' } as const)[signinMode(c.env)] }));

// ---------------------------------------------------------------------- auth
route('get', '/auth/oauth/github', 'public', async (c) => {
  const state = randomToken(24);
  const { verifier, challenge } = await pkcePair();
  const url = githubAuthorizeUrl(c.env, state, challenge);
  setCookie(c, OAUTH_COOKIE, await signPayload(c.env, { state, verifier, exp: Date.now() + 10 * 60_000 }), cookieOptions(c, 600));
  return c.redirect(url, 302);
});

route('get', '/auth/oauth/github/callback', 'public', async (c) => {
  const saved = await verifyPayload<{ state: string; verifier: string; exp: number }>(c.env, getCookie(c, OAUTH_COOKIE, cookiePrefix(c)));
  clearCookie(c, OAUTH_COOKIE);
  const code = c.req.query('code');
  if (!saved || saved.exp < Date.now() || !code || saved.state !== c.req.query('state')) {
    throw new AppError(400, 'oauth_failed', 'The sign-in attempt expired or was not valid. Please try again.');
  }
  const profile = await githubProfile(c.env, code, saved.verifier);
  const isOwner = !!c.env.SUPER_ADMIN_GITHUB_ID && profile.id === c.env.SUPER_ADMIN_GITHUB_ID;
  // GitHub is the owner's door only, in every mode. Everyone else signs in through Clerk.
  if (!isOwner) throw new AppError(403, 'signin_closed', 'GitHub sign-in is only for the site owner. Use the main sign-in instead.');
  const user = await upsertUser(c.env, profile, { provider: 'github', providerUserId: profile.id });
  const token = await createSession(c.env, user.id, c.req.raw, 'github');
  setSessionCookie(c, token);
  return c.redirect(c.env.APP_ORIGIN, 302);
});

/** Exchanges a Clerk session token for a ShopList session. Clerk proves identity; ShopList owns the session. */
route('post', '/auth/clerk/session', 'public', async (c) => {
  if (!clerkConfigured(c.env)) throw new AppError(503, 'clerk_not_configured', 'Sign-in is not configured on this server.');
  const { data } = await readJson(c, z.object({ token: z.string().min(20).max(4096) }).strict());
  const sub = await verifyClerkToken(c.env, data.token);
  if (signinClosed(c.env)) throw new AppError(403, 'signin_closed', 'This ShopList is private. Only the site owner can sign in.');
  const profile = await fetchClerkProfile(c.env, sub);
  // By invitation: no account is created for someone the owner has not invited.
  if ((await clerkAdmission(c.env, profile.email)) === 'not_invited') {
    throw new AppError(403, 'not_invited', 'This ShopList is by invitation. Ask the owner to invite this email address, then sign in again.');
  }
  // The owner's account is reachable only through the owner's door. A customer-door identity must never attach to it.
  const owner = await c.env.DB.prepare(`SELECT 1 AS x FROM users u JOIN oauth_accounts o ON o.user_id = u.id WHERE u.email = ? AND o.provider = 'github' LIMIT 1`).bind(profile.email.toLowerCase()).first();
  if (owner) throw new AppError(409, 'email_in_use', 'That email belongs to a different kind of account. Use the other sign-in.');
  const user = await upsertUser(c.env, profile, { provider: 'clerk', providerUserId: sub });
  // Clerk verified this email, so any invitation sent to it is accepted now.
  await acceptPendingInvitations(c.env, { id: user.id, email: profile.email });
  setSessionCookie(c, await createSession(c.env, user.id, c.req.raw, 'clerk'));
  return c.json({ user });
});

/** Local development and tests only. Refuses to run unless DEV_AUTH is exactly "true". */
route('post', '/auth/dev/login', 'public', async (c) => {
  if (c.env.DEV_AUTH !== 'true') throw new AppError(404, 'not_found', 'There is nothing at this address.');
  const { data } = await readJson(c, z.object({ email: z.string().email().max(254), name: z.string().max(100).optional(), superAdmin: z.boolean().optional() }).strict());
  const user = await upsertUser(c.env, { email: data.email, name: data.name ?? data.email.split('@')[0] });
  if (data.superAdmin) {
    if (!c.env.SUPER_ADMIN_GITHUB_ID) throw new AppError(400, 'no_super_admin_configured', 'Set SUPER_ADMIN_GITHUB_ID to use this.');
    // Dev only: link this account to the configured super-admin identity (there is only ever one holder).
    await c.env.DB.prepare(`INSERT OR REPLACE INTO oauth_accounts(provider, provider_user_id, user_id) VALUES ('github', ?, ?)`).bind(c.env.SUPER_ADMIN_GITHUB_ID, user.id).run();
    user.isSuperAdmin = true;
  }
  const token = await createSession(c.env, user.id, c.req.raw, 'dev');
  setSessionCookie(c, token);
  return c.json({ user });
});

// ------------------------------------------------------------------ passkeys (WebAuthn)
const CHALLENGE_MS = 2 * 60 * 1000;
const rp = (env: Bindings) => ({ id: new URL(env.APP_ORIGIN).hostname, origin: new URL(env.APP_ORIGIN).origin });
const b64 = z.string().min(1).max(8192).regex(/^[A-Za-z0-9_-]+$/);

async function issueChallenge(c: Ctx, purpose: 'register' | 'login', userId?: string) {
  const challenge = randomToken(32);
  return { challenge, token: await signPayload(c.env, { purpose, challenge, userId, exp: Date.now() + CHALLENGE_MS }) };
}
async function openChallenge(c: Ctx, token: string, purpose: 'register' | 'login'): Promise<{ challenge: string; userId?: string }> {
  const p = await verifyPayload<{ purpose: string; challenge: string; userId?: string; exp: number }>(c.env, token);
  if (!p || p.purpose !== purpose || typeof p.exp !== 'number' || p.exp < Date.now()) throw new AppError(400, 'passkey_expired', 'That passkey request expired. Try again.');
  return p;
}

route('post', '/auth/passkeys/register/options', 'user', async (c) => {
  const user = c.get('user');
  const { challenge, token } = await issueChallenge(c, 'register', user.id);
  const { results } = await c.env.DB.prepare(`SELECT id FROM passkeys WHERE user_id = ?`).bind(user.id).all<{ id: string }>();
  return c.json({
    token,
    publicKey: {
      challenge,
      rp: { id: rp(c.env).id, name: 'ShopList' },
      user: { id: base64url(new TextEncoder().encode(user.id)), name: user.email, displayName: user.name },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
      excludeCredentials: results.map((r) => ({ type: 'public-key', id: r.id })),
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
      attestation: 'none',
      timeout: 60000,
    },
  });
});

route('post', '/auth/passkeys/register', 'user', async (c) => {
  const user = c.get('user');
  const { data } = await readJson(c, z.object({ token: z.string().max(2000), clientDataJSON: b64, attestationObject: b64, transports: z.array(z.string().max(20)).max(6).optional(), name: z.string().trim().min(1).max(60).optional() }).strict());
  const ch = await openChallenge(c, data.token, 'register');
  if (ch.userId !== user.id) throw new AppError(400, 'passkey_invalid', 'The passkey response was rejected (user).');
  const { credentialId, publicKey, counter } = await verifyRegistration(data, { challenge: ch.challenge, origin: rp(c.env).origin, rpId: rp(c.env).id });
  const count = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM passkeys WHERE user_id = ?`).bind(user.id).first<{ n: number }>();
  if ((count?.n ?? 0) >= 10) throw new AppError(409, 'too_many_passkeys', 'You can register up to 10 passkeys. Remove one first.');
  try {
    await c.env.DB.prepare(`INSERT INTO passkeys(id, user_id, public_key, sign_count, transports, name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .bind(credentialId, user.id, publicKey, counter, JSON.stringify(data.transports ?? []), data.name ?? 'Passkey', nowIso())
      .run();
  } catch {
    throw new AppError(409, 'passkey_exists', 'That passkey is already registered.');
  }
  return c.json({ id: credentialId, name: data.name ?? 'Passkey' }, 201);
});

route('get', '/auth/passkeys', 'user', async (c) => {
  const { results } = await c.env.DB.prepare(`SELECT id, name, created_at, last_used_at FROM passkeys WHERE user_id = ? ORDER BY created_at`).bind(c.get('user').id).all();
  return c.json({ data: results });
});

route('delete', '/auth/passkeys/:id', 'user', async (c) => {
  const r = await c.env.DB.prepare(`DELETE FROM passkeys WHERE id = ? AND user_id = ?`).bind(c.req.param('id'), c.get('user').id).run();
  if (!r.meta.changes) throw new AppError(404, 'not_found', 'There is nothing at this address.');
  return c.json({ ok: true });
});

route('post', '/auth/passkeys/login/options', 'public', async (c) => {
  if (signinClosed(c.env)) throw new AppError(403, 'signin_closed', 'This ShopList is private. Only the site owner can sign in.');
  const { challenge, token } = await issueChallenge(c, 'login');
  return c.json({ token, publicKey: { challenge, rpId: rp(c.env).id, userVerification: 'required', timeout: 60000 } });
});

/** Passkey sign-in. The session is a normal one: it never carries super-admin power, which only the GitHub door grants. */
route('post', '/auth/passkeys/login', 'public', async (c) => {
  if (signinClosed(c.env)) throw new AppError(403, 'signin_closed', 'This ShopList is private. Only the site owner can sign in.');
  const { data } = await readJson(c, z.object({ token: z.string().max(2000), id: b64, clientDataJSON: b64, authenticatorData: b64, signature: b64 }).strict());
  const ch = await openChallenge(c, data.token, 'login');
  const row = await c.env.DB.prepare(`SELECT p.public_key, p.sign_count, p.user_id FROM passkeys p JOIN users u ON u.id = p.user_id WHERE p.id = ? AND u.disabled_at IS NULL`).bind(data.id).first<{ public_key: ArrayBuffer | number[]; sign_count: number; user_id: string }>();
  // Same answer for "unknown passkey" and "bad signature", so ids cannot be probed.
  if (!row) throw new AppError(400, 'passkey_invalid', 'The passkey response was rejected (unknown passkey).');
  const counter = await verifyAssertion(data, { publicKey: new Uint8Array(row.public_key), counter: row.sign_count }, { challenge: ch.challenge, origin: rp(c.env).origin, rpId: rp(c.env).id });
  await c.env.DB.prepare(`UPDATE passkeys SET sign_count = ?, last_used_at = ? WHERE id = ?`).bind(counter, nowIso(), data.id).run();
  setSessionCookie(c, await createSession(c.env, row.user_id, c.req.raw, 'passkey'));
  return c.json({ ok: true });
});

// ------------------------------------------------------------------ my sessions
/** The id shown to the client is a prefix of the stored hash, never anything usable as a token. */
const SID = 16;

route('get', '/auth/sessions', 'user', async (c) => {
  const current = await sha256Hex(readSessionCookie(c) ?? '');
  const { results } = await c.env.DB.prepare(`SELECT token_hash, created_at, last_seen_at, user_agent, ip_country, provider FROM sessions WHERE user_id = ? AND expires_at > ? ORDER BY last_seen_at DESC`)
    .bind(c.get('user').id, nowIso())
    .all<{ token_hash: string; created_at: string; last_seen_at: string; user_agent: string | null; ip_country: string | null; provider: string }>();
  return c.json({ data: results.map((r) => ({ id: r.token_hash.slice(0, SID), current: r.token_hash === current, createdAt: r.created_at, lastSeenAt: r.last_seen_at, userAgent: r.user_agent, country: r.ip_country, via: r.provider })) });
});

route('post', '/auth/sessions/revoke-others', 'user', async (c) => {
  const current = await sha256Hex(readSessionCookie(c) ?? '');
  const r = await c.env.DB.prepare(`DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?`).bind(c.get('user').id, current).run();
  return c.json({ revoked: r.meta.changes ?? 0 });
});

route('delete', '/auth/sessions/:id', 'user', async (c) => {
  const id = c.req.param('id') ?? '';
  if (!/^[0-9a-f]{16}$/.test(id)) throw new AppError(404, 'not_found', 'There is nothing at this address.');
  const r = await c.env.DB.prepare(`DELETE FROM sessions WHERE user_id = ? AND substr(token_hash, 1, ?) = ?`).bind(c.get('user').id, SID, id).run();
  if (!r.meta.changes) throw new AppError(404, 'not_found', 'There is nothing at this address.');
  return c.json({ ok: true });
});

// ------------------------------------------------------------------ notifications
const NOTIFICATION_KEEP_MS = 60 * 86400_000;

route('get', '/me/notifications', 'user', async (c) => {
  const q = parse(pageQuery, c.req.query());
  const uid = c.get('user').id;
  const cur = decodeCursor<{ c: string; i: string }>(q.cursor);
  // Old ones are deleted as people look, so no scheduled job is needed.
  await c.env.DB.prepare(`DELETE FROM notifications WHERE user_id = ? AND created_at < ?`).bind(uid, new Date(Date.now() - NOTIFICATION_KEEP_MS).toISOString()).run();
  const { results } = await c.env.DB.prepare(
    `SELECT n.id, n.org_id AS orgId, n.kind, n.title, n.link, n.created_at AS createdAt, n.read_at AS readAt
       FROM notifications n JOIN memberships m ON m.org_id = n.org_id AND m.user_id = n.user_id AND m.deactivated_at IS NULL
      WHERE n.user_id = ? ${cur ? 'AND (n.created_at < ? OR (n.created_at = ? AND n.id < ?))' : ''}
      ORDER BY n.created_at DESC, n.id DESC LIMIT ?`,
  ).bind(uid, ...(cur ? [cur.c, cur.c, cur.i] : []), q.limit + 1).all<{ id: string; createdAt: string }>();
  const hasMore = results.length > q.limit;
  const data = results.slice(0, q.limit);
  const last = data[data.length - 1];
  return c.json({ data, nextCursor: hasMore && last ? encodeCursor({ c: last.createdAt, i: last.id }) : null, hasMore });
});

route('get', '/me/notifications/unread-count', 'user', async (c) => {
  const r = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM notifications n JOIN memberships m ON m.org_id = n.org_id AND m.user_id = n.user_id AND m.deactivated_at IS NULL WHERE n.user_id = ? AND n.read_at IS NULL`,
  ).bind(c.get('user').id).first<{ n: number }>();
  return c.json({ count: r?.n ?? 0 });
});

route('post', '/me/notifications/read', 'user', async (c) => {
  const { data } = await readJson(c, z.object({ ids: z.array(z.string().max(60)).max(200).optional() }).strict());
  const uid = c.get('user').id;
  const now = nowIso();
  if (data.ids?.length) {
    await c.env.DB.batch(data.ids.map((id) => c.env.DB.prepare(`UPDATE notifications SET read_at = ? WHERE id = ? AND user_id = ? AND read_at IS NULL`).bind(now, id, uid)));
  } else {
    await c.env.DB.prepare(`UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL`).bind(now, uid).run();
  }
  return c.json({ ok: true });
});

route('get', '/me/notification-preferences', 'user', async (c) => {
  const orgId = c.req.query('org') ?? '';
  const uid = c.get('user').id;
  const member = await c.env.DB.prepare(`SELECT 1 AS x FROM memberships WHERE org_id = ? AND user_id = ?`).bind(orgId, uid).first();
  if (!member) throw new AppError(404, 'org_not_found', 'That organization does not exist.');
  const { results } = await c.env.DB.prepare(`SELECT kind FROM notification_prefs WHERE user_id = ? AND org_id = ? AND in_app = 0`).bind(uid, orgId).all<{ kind: string }>();
  const off = new Set(results.map((r) => r.kind));
  return c.json({ data: NOTIFICATION_KINDS.map((kind) => ({ kind, label: KIND_LABELS[kind], inApp: !off.has(kind) })) });
});

route('patch', '/me/notification-preferences', 'user', async (c) => {
  const { data } = await readJson(c, z.object({ orgId: z.string().max(60), kind: z.enum(NOTIFICATION_KINDS), inApp: z.boolean() }).strict());
  const uid = c.get('user').id;
  const member = await c.env.DB.prepare(`SELECT 1 AS x FROM memberships WHERE org_id = ? AND user_id = ?`).bind(data.orgId, uid).first();
  if (!member) throw new AppError(404, 'org_not_found', 'That organization does not exist.');
  await c.env.DB.prepare(`INSERT INTO notification_prefs(user_id, org_id, kind, in_app) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, org_id, kind) DO UPDATE SET in_app = excluded.in_app`).bind(uid, data.orgId, data.kind, data.inApp ? 1 : 0).run();
  return c.json({ ok: true });
});

route('post', '/auth/logout', 'user', async (c) => {
  await destroySession(c.env, readSessionCookie(c));
  clearCookie(c, SESSION_COOKIE);
  return c.json({ ok: true });
});

route('get', '/me', 'user', async (c) => {
  const user = c.get('user');
  const { results } = await c.env.DB.prepare(
    `SELECT o.id, o.name, o.slug, o.currency, m.role FROM memberships m JOIN organizations o ON o.id = m.org_id WHERE m.user_id = ? AND m.deactivated_at IS NULL AND o.deleted_at IS NULL AND o.suspended_at IS NULL ORDER BY o.name`,
  ).bind(user.id).all();
  return c.json({ user, organizations: results });
});

// ------------------------------------------------------------- organizations
route('post', '/orgs', 'user', async (c) => {
  const user = c.get('user');
  // Businesses are onboarded by the platform owner. Self-serve creation exists only in open mode (tests, local).
  if (signinMode(c.env) !== 'open') throw new AppError(403, 'org_creation_closed', 'New businesses are set up by the ShopList owner. Ask your admin to invite you.');
  const { data } = await readJson(c, orgInput);
  const owned = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM memberships WHERE user_id = ? AND role = 'admin'`).bind(user.id).first<{ n: number }>();
  if ((owned?.n ?? 0) >= 5) throw new AppError(409, 'org_limit', 'You can administer at most 5 organizations.');
  const id = newId('org');
  const slug = `${data.name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'org'}-${randomToken(3).toLowerCase().replace(/[^a-z0-9]/g, 'x')}`;
  const now = nowIso();
  await c.env.DB.batch([
    c.env.DB.prepare(`INSERT INTO organizations(id, name, slug, created_at) VALUES (?, ?, ?, ?)`).bind(id, data.name, slug, now),
    c.env.DB.prepare(`INSERT INTO memberships(org_id, user_id, role, created_at) VALUES (?, ?, 'admin', ?)`).bind(id, user.id, now),
  ]);
  return c.json({ organization: { id, name: data.name, slug, currency: 'USD', role: 'admin' } }, 201);
});

route('get', '/orgs/:orgId', 'inventory:read', async (c) => {
  const org = await c.env.DB.prepare(`SELECT id, name, slug, currency, created_at FROM organizations WHERE id = ?`).bind(c.get('org').id).first();
  return c.json({ organization: { ...org, role: c.get('org').role } });
});

route('patch', '/orgs/:orgId', 'settings:manage', async (c) => {
  const { data } = await readJson(c, orgInput);
  await c.env.DB.prepare(`UPDATE organizations SET name = ? WHERE id = ?`).bind(data.name, c.get('org').id).run();
  return c.json({ ok: true });
});

async function loadSettings(c: Ctx): Promise<OrgSettings> {
  const row = await c.env.DB.prepare(`SELECT settings, currency FROM organizations WHERE id = ?`).bind(c.get('org').id).first<{ settings: string; currency: string }>();
  let saved: Partial<OrgSettings> = {};
  try { saved = JSON.parse(row?.settings ?? '{}'); } catch { /* fall back to defaults */ }
  return { ...SETTINGS_DEFAULTS, ...saved, currency: row?.currency ?? 'USD' };
}

route('get', '/orgs/:orgId/settings', 'inventory:read', async (c) => c.json({ settings: await loadSettings(c) }));

route('patch', '/orgs/:orgId/settings', 'settings:manage', async (c) => {
  const { data } = await readJson(c, orgSettingsPatch);
  const current = await loadSettings(c);
  const next: OrgSettings = { ...current, ...data, email: data.email === '' ? null : (data.email ?? current.email) } as OrgSettings;
  // Prices already entered would silently change meaning, so currency is locked once the business has orders.
  if (data.currency && data.currency !== current.currency && (await inventory(c).stats()).orders > 0) {
    throw new AppError(409, 'currency_locked', 'The currency cannot change after the business has orders.');
  }
  const { currency, ...rest } = next;
  await c.env.DB.prepare(`UPDATE organizations SET settings = ?, currency = ? WHERE id = ?`).bind(JSON.stringify(rest), currency, c.get('org').id).run();
  await inventory(c).setSettings({ orderPrefix: next.orderPrefix, defaultReorderPoint: next.defaultReorderPoint, approvals: next.approvals, timezone: next.timezone });
  return c.json({ settings: next });
});

route('delete', '/orgs/:orgId', 'org:delete', async (c) => {
  await c.env.DB.prepare(`UPDATE organizations SET deleted_at = ? WHERE id = ?`).bind(nowIso(), c.get('org').id).run();
  return c.json({ ok: true });
});

// ------------------------------------------------------------------- members
route('get', '/orgs/:orgId/members', 'inventory:read', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT u.id, u.name, u.email, u.avatar_url, m.role, m.created_at, m.deactivated_at AS deactivatedAt, m.location_ids AS locationIds,
            (SELECT MAX(s.last_seen_at) FROM sessions s WHERE s.user_id = u.id) AS lastSeenAt
       FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.org_id = ? ORDER BY m.created_at`,
  ).bind(c.get('org').id).all();
  // Staff see who their colleagues are, not how to reach them or when they were last on.
  const manage = can(c.get('org').role, 'team:manage');
  const shaped: Record<string, unknown>[] = (results as Record<string, unknown>[]).map((r) => {
    const { locationIds, ...rest } = r;
    return { ...rest, locationIds: typeof locationIds === 'string' ? (JSON.parse(locationIds) as string[]) : null };
  });
  return c.json({ data: manage ? shaped : shaped.map((r) => { const { email: _e, lastSeenAt: _l, locationIds: _s, ...rest } = r; return rest; }) });
});

async function adminCount(c: Ctx): Promise<number> {
  return (await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM memberships WHERE org_id = ? AND role = 'admin' AND deactivated_at IS NULL`).bind(c.get('org').id).first<{ n: number }>())?.n ?? 0;
}

/** One admin per organization is the rule. A second one is allowed only when the caller says so explicitly. */
async function guardSecondAdmin(c: Ctx, role: Role, confirmed: boolean | undefined, exceptUserId?: string): Promise<void> {
  if (role !== 'admin' || confirmed) return;
  const n = (await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM memberships WHERE org_id = ? AND role = 'admin' AND deactivated_at IS NULL AND user_id <> ?`).bind(c.get('org').id, exceptUserId ?? '').first<{ n: number }>())?.n ?? 0;
  if (n > 0) throw new AppError(409, 'second_admin', 'This organization already has an admin. An organization normally has one. Confirm to add another.');
}

/** Checks that every id is a real, active location of this business. */
async function checkLocations(c: Ctx, ids: string[] | null | undefined): Promise<string[] | null> {
  if (!ids) return null;
  const known = new Set((await inventory(c).listLocations()).map((l) => l.id));
  if (ids.some((id) => !known.has(id))) throw new AppError(400, 'unknown_location', 'One of those locations does not exist.');
  return [...new Set(ids)];
}

route('patch', '/orgs/:orgId/members/:userId', 'team:manage', async (c) => {
  const { data } = await readJson(c, memberPatch);
  const userId = c.req.param('userId') ?? '';
  const target = await c.env.DB.prepare(`SELECT role FROM memberships WHERE org_id = ? AND user_id = ?`).bind(c.get('org').id, userId).first<{ role: Role }>();
  if (!target) throw new AppError(404, 'member_not_found', 'That person is not a member.');
  const role = data.role ?? target.role;
  if (target.role === 'admin' && role !== 'admin' && (await adminCount(c)) <= 1) throw new AppError(409, 'last_admin', 'An organization needs at least one admin. Make someone else admin first.');
  await guardSecondAdmin(c, role, data.confirmSecondAdmin, userId);
  const scope = data.locationIds !== undefined ? await checkLocations(c, data.locationIds) : undefined;
  // Admins are never limited to locations.
  const clearScope = role === 'admin';
  await c.env.DB.prepare(`UPDATE memberships SET role = ?${scope !== undefined || clearScope ? ', location_ids = ?' : ''} WHERE org_id = ? AND user_id = ?`)
    .bind(role, ...(clearScope ? [null] : scope !== undefined ? [scope ? JSON.stringify(scope) : null] : []), c.get('org').id, userId)
    .run();
  return c.json({ ok: true });
});

route('delete', '/orgs/:orgId/members/:userId', 'team:manage', async (c) => {
  const target = await c.env.DB.prepare(`SELECT role FROM memberships WHERE org_id = ? AND user_id = ?`).bind(c.get('org').id, c.req.param('userId')).first<{ role: Role }>();
  if (!target) throw new AppError(404, 'member_not_found', 'That person is not a member.');
  if (target.role === 'admin' && (await adminCount(c)) <= 1) throw new AppError(409, 'last_admin', 'An organization needs at least one admin.');
  await c.env.DB.prepare(`DELETE FROM memberships WHERE org_id = ? AND user_id = ?`).bind(c.get('org').id, c.req.param('userId')).run();
  return c.json({ ok: true });
});

route('post', '/orgs/:orgId/members/:userId/deactivate', 'team:manage', async (c) => {
  const userId = c.req.param('userId') ?? '';
  const target = await c.env.DB.prepare(`SELECT role, deactivated_at FROM memberships WHERE org_id = ? AND user_id = ?`).bind(c.get('org').id, userId).first<{ role: Role; deactivated_at: string | null }>();
  if (!target) throw new AppError(404, 'member_not_found', 'That person is not a member.');
  if (target.role === 'admin' && (await adminCount(c)) <= 1) throw new AppError(409, 'last_admin', 'An organization needs at least one active admin.');
  await c.env.DB.prepare(`UPDATE memberships SET deactivated_at = COALESCE(deactivated_at, ?) WHERE org_id = ? AND user_id = ?`).bind(nowIso(), c.get('org').id, userId).run();
  return c.json({ ok: true });
});

route('post', '/orgs/:orgId/members/:userId/reactivate', 'team:manage', async (c) => {
  const r = await c.env.DB.prepare(`UPDATE memberships SET deactivated_at = NULL WHERE org_id = ? AND user_id = ?`).bind(c.get('org').id, c.req.param('userId') ?? '').run();
  if (!r.meta.changes) throw new AppError(404, 'member_not_found', 'That person is not a member.');
  return c.json({ ok: true });
});

/** The admin hands the business to someone else: that person becomes admin, the current admin becomes manager. One step. */
route('post', '/orgs/:orgId/admin-handover', 'team:manage', async (c) => {
  const { data } = await readJson(c, z.object({ userId: z.string().max(60), confirmName: z.string().max(100) }).strict());
  const org = await c.env.DB.prepare(`SELECT name FROM organizations WHERE id = ?`).bind(c.get('org').id).first<{ name: string }>();
  if (!org || data.confirmName.trim() !== org.name) throw new AppError(400, 'confirm_name', 'Type the business name exactly to confirm.');
  if (data.userId === c.get('user').id) throw new AppError(400, 'same_person', 'Choose someone else.');
  const target = await c.env.DB.prepare(`SELECT 1 AS x FROM memberships WHERE org_id = ? AND user_id = ? AND deactivated_at IS NULL`).bind(c.get('org').id, data.userId).first();
  if (!target) throw new AppError(404, 'member_not_found', 'That person is not an active member.');
  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE memberships SET role = 'admin' WHERE org_id = ? AND user_id = ?`).bind(c.get('org').id, data.userId),
    c.env.DB.prepare(`UPDATE memberships SET role = 'manager' WHERE org_id = ? AND user_id = ?`).bind(c.get('org').id, c.get('user').id),
  ]);
  return c.json({ ok: true });
});

/** Creates an invitation, replacing any pending one for the same email in the same organization. The token is shown once. */
async function createInvitation(c: Ctx, o: { orgId: string; email: string; role: Role; invitedBy: string; locationIds?: string[] | null }) {
  const token = randomToken(32);
  const id = newId('inv');
  const now = nowIso();
  const expiresAt = new Date(Date.now() + 7 * 86400_000).toISOString();
  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE invitations SET revoked_at = ? WHERE org_id = ? AND lower(email) = ? AND accepted_at IS NULL AND revoked_at IS NULL`).bind(now, o.orgId, o.email.toLowerCase()),
    c.env.DB.prepare(`INSERT INTO invitations(id, token_hash, org_id, email, role, invited_by, created_at, expires_at, location_ids) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(id, await sha256Hex(token), o.orgId, o.email, o.role, o.invitedBy, now, expiresAt, o.locationIds && o.role !== 'admin' ? JSON.stringify(o.locationIds) : null),
  ]);
  return { id, token, link: `${c.env.APP_ORIGIN}/invite/${token}`, expiresAt };
}

route('post', '/orgs/:orgId/invitations', 'team:manage', async (c) => {
  const { data } = await readJson(c, inviteInput);
  await guardSecondAdmin(c, data.role, data.confirmSecondAdmin);
  const existing = await c.env.DB.prepare(`SELECT 1 AS x FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.org_id = ? AND lower(u.email) = ?`).bind(c.get('org').id, data.email.toLowerCase()).first();
  if (existing) throw new AppError(409, 'already_member', 'That person is already a member of this organization.');
  const locationIds = await checkLocations(c, data.locationIds);
  const inv = await createInvitation(c, { orgId: c.get('org').id, email: data.email, role: data.role, invitedBy: c.get('user').id, locationIds });
  // The token is shown once; share the link with the invitee.
  return c.json({ id: inv.id, token: inv.token, link: inv.link, expiresAt: inv.expiresAt, email: data.email, role: data.role }, 201);
});

route('get', '/orgs/:orgId/invitations', 'team:manage', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT i.id, i.email, i.role, i.created_at AS createdAt, i.expires_at AS expiresAt, u.name AS invitedBy
       FROM invitations i LEFT JOIN users u ON u.id = i.invited_by
      WHERE i.org_id = ? AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > ? ORDER BY i.created_at DESC`,
  ).bind(c.get('org').id, nowIso()).all();
  return c.json({ data: results });
});

async function pendingInvitation(c: Ctx, id: string) {
  const inv = await c.env.DB.prepare(`SELECT id, email, role, location_ids AS locationIds FROM invitations WHERE id = ? AND org_id = ? AND accepted_at IS NULL AND revoked_at IS NULL`).bind(id, c.get('org').id).first<{ id: string; email: string; role: Role; locationIds: string | null }>();
  if (!inv) throw new AppError(404, 'invitation_invalid', 'This invitation is invalid or has already been used.');
  return inv;
}

route('post', '/orgs/:orgId/invitations/:invId/resend', 'team:manage', async (c) => {
  const old = await pendingInvitation(c, c.req.param('invId') ?? '');
  const inv = await createInvitation(c, { orgId: c.get('org').id, email: old.email, role: old.role, invitedBy: c.get('user').id, locationIds: old.locationIds ? JSON.parse(old.locationIds) : null });
  return c.json({ id: inv.id, link: inv.link, expiresAt: inv.expiresAt });
});

route('delete', '/orgs/:orgId/invitations/:invId', 'team:manage', async (c) => {
  const inv = await pendingInvitation(c, c.req.param('invId') ?? '');
  await c.env.DB.prepare(`UPDATE invitations SET revoked_at = ? WHERE id = ?`).bind(nowIso(), inv.id).run();
  return c.json({ ok: true });
});

route('post', '/invitations/:token/accept', 'user', async (c) => {
  const hash = await sha256Hex(c.req.param('token') ?? '');
  const inv = await c.env.DB.prepare(`SELECT org_id, email, role, expires_at, accepted_at, revoked_at, location_ids AS locationIds FROM invitations WHERE token_hash = ?`).bind(hash).first<{ org_id: string; email: string; role: Role; expires_at: string; accepted_at: string | null; revoked_at: string | null; locationIds: string | null }>();
  if (!inv || inv.accepted_at || inv.revoked_at || Date.parse(inv.expires_at) < Date.now()) throw new AppError(404, 'invitation_invalid', 'This invitation is invalid or has expired.');
  const user = c.get('user');
  // A stolen link is useless to anyone signed in with a different email.
  if (inv.email.toLowerCase() !== user.email.toLowerCase()) throw new AppError(403, 'invitation_wrong_account', `This invitation was sent to ${inv.email}. Sign in with that account.`);
  await c.env.DB.batch([
    c.env.DB.prepare(`INSERT OR IGNORE INTO memberships(org_id, user_id, role, created_at, location_ids) VALUES (?, ?, ?, ?, ?)`).bind(inv.org_id, user.id, inv.role, nowIso(), inv.locationIds),
    c.env.DB.prepare(`UPDATE invitations SET accepted_at = ? WHERE token_hash = ?`).bind(nowIso(), hash),
  ]);
  return c.json({ organizationId: inv.org_id, role: inv.role });
});


// ------------------------------------------------------------------ API keys
route('get', '/orgs/:orgId/api-keys', 'settings:manage', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT id, name, prefix, scopes, created_at AS createdAt, last_used_at AS lastUsedAt, expires_at AS expiresAt, revoked_at AS revokedAt
       FROM api_keys WHERE org_id = ? ORDER BY created_at DESC`,
  ).bind(c.get('org').id).all<{ scopes: string }>();
  return c.json({ data: results.map((r) => ({ ...r, scopes: JSON.parse(r.scopes) as string[] })) });
});

route('post', '/orgs/:orgId/api-keys', 'settings:manage', async (c) => {
  const { data } = await readJson(c, apiKeyInput);
  const count = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM api_keys WHERE org_id = ? AND revoked_at IS NULL`).bind(c.get('org').id).first<{ n: number }>();
  if ((count?.n ?? 0) >= 20) throw new AppError(409, 'key_limit', 'An organization can have at most 20 active API keys. Revoke one first.');
  const secret = `${KEY_PREFIX}${randomToken(30)}`;
  const id = newId('key');
  const now = nowIso();
  await c.env.DB.prepare(`INSERT INTO api_keys(id, org_id, name, prefix, secret_hash, scopes, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, c.get('org').id, data.name, secret.slice(0, 12), await sha256Hex(secret), JSON.stringify([...new Set(data.scopes)]), c.get('user').id, now, data.expiresInDays ? new Date(Date.now() + data.expiresInDays * 86400_000).toISOString() : null)
    .run();
  // The full key is shown exactly once; only its hash is stored.
  return c.json({ id, name: data.name, prefix: secret.slice(0, 12), scopes: data.scopes, key: secret }, 201);
});

route('delete', '/orgs/:orgId/api-keys/:id', 'settings:manage', async (c) => {
  const res = await c.env.DB.prepare(`UPDATE api_keys SET revoked_at = ? WHERE id = ? AND org_id = ? AND revoked_at IS NULL`).bind(nowIso(), c.req.param('id') ?? '', c.get('org').id).run();
  if (!res.meta.changes) throw new AppError(404, 'key_not_found', 'That key does not exist or is already revoked.');
  return c.json({ ok: true });
});


// ------------------------------------------------------------------ webhooks
route('get', '/orgs/:orgId/webhooks', 'settings:manage', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT w.id, w.url, w.events, w.active, w.created_at AS createdAt, substr(w.secret, 1, 10) AS secretPrefix,
            (SELECT d.status FROM webhook_deliveries d WHERE d.webhook_id = w.id ORDER BY d.created_at DESC, d.id DESC LIMIT 1) AS lastStatus,
            (SELECT d.created_at FROM webhook_deliveries d WHERE d.webhook_id = w.id ORDER BY d.created_at DESC, d.id DESC LIMIT 1) AS lastDeliveryAt
       FROM webhooks w WHERE w.org_id = ? ORDER BY w.created_at DESC`,
  ).bind(c.get('org').id).all<{ events: string; active: number }>();
  return c.json({ data: results.map((r) => ({ ...r, events: JSON.parse(r.events) as string[], active: r.active === 1 })) });
});

route('post', '/orgs/:orgId/webhooks', 'settings:manage', async (c) => {
  const { data } = await readJson(c, webhookInput);
  const problem = checkWebhookUrl(data.url);
  if (problem) throw new AppError(400, 'invalid_webhook_url', problem, { errors: [{ field: 'url', code: 'invalid_url', message: problem }] });
  const orgId = c.get('org').id;
  const count = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM webhooks WHERE org_id = ?`).bind(orgId).first<{ n: number }>();
  if ((count?.n ?? 0) >= 10) throw new AppError(409, 'webhook_limit', 'An organization can have at most 10 webhooks.');
  const id = newId('whk');
  const secret = `whsec_${randomToken(24)}`;
  await c.env.DB.prepare(`INSERT INTO webhooks(id, org_id, url, events, secret, active, created_by, created_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)`)
    .bind(id, orgId, data.url, JSON.stringify([...new Set(data.events)]), secret, c.get('user').id, nowIso()).run();
  forgetHooks(orgId);
  await inventory(c).setEventsEnabled(true);
  // The signing secret is shown once.
  return c.json({ id, url: data.url, events: data.events, secret }, 201);
});

route('delete', '/orgs/:orgId/webhooks/:id', 'settings:manage', async (c) => {
  const orgId = c.get('org').id;
  const res = await c.env.DB.prepare(`DELETE FROM webhooks WHERE id = ? AND org_id = ?`).bind(c.req.param('id') ?? '', orgId).run();
  if (!res.meta.changes) throw new AppError(404, 'webhook_not_found', 'That webhook does not exist.');
  forgetHooks(orgId);
  const left = await c.env.DB.prepare(`SELECT 1 AS x FROM webhooks WHERE org_id = ? LIMIT 1`).bind(orgId).first();
  return c.json({ ok: true });
});

route('post', '/orgs/:orgId/webhooks/:id/test', 'settings:manage', async (c) => {
  const row = await c.env.DB.prepare(`SELECT id FROM webhooks WHERE id = ? AND org_id = ?`).bind(c.req.param('id') ?? '', c.get('org').id).first();
  if (!row) throw new AppError(404, 'webhook_not_found', 'That webhook does not exist.');
  await sendTestEvent(c.env, c.get('org').id, c.req.param('id') ?? '');
  return c.json({ queued: true }, 202);
});

route('get', '/orgs/:orgId/webhooks/:id/deliveries', 'settings:manage', async (c) => {
  const row = await c.env.DB.prepare(`SELECT id FROM webhooks WHERE id = ? AND org_id = ?`).bind(c.req.param('id') ?? '', c.get('org').id).first();
  if (!row) throw new AppError(404, 'webhook_not_found', 'That webhook does not exist.');
  const { results } = await c.env.DB.prepare(
    `SELECT id, event_id AS eventId, event_type AS eventType, status, http_status AS httpStatus, attempts, created_at AS createdAt FROM webhook_deliveries WHERE webhook_id = ? ORDER BY created_at DESC, id DESC LIMIT 50`,
  ).bind(c.req.param('id') ?? '').all();
  return c.json({ data: results });
});

// ----------------------------------------------------------------- inventory
route('get', '/orgs/:orgId/dashboard', 'inventory:read', async (c) => c.json(await inventory(c).dashboard()));

route('get', '/orgs/:orgId/products', 'inventory:read', async (c) => c.json(await inventory(c).listProducts(parse(productListQuery, c.req.query()))));

route('post', '/orgs/:orgId/products', 'products:write', async (c) => {
  const { data, raw } = await readJson(c, productInput);
  const out = unwrap(await inventory(c).createProduct(caller(c), await idemFrom(c, raw), data));
  etag(c, out.body.product.version);
  return c.json(out.body, out.status as 201);
});

route('post', '/orgs/:orgId/products/import', 'products:write', async (c) => {
  const { data, raw } = await readJson(c, importRequest);
  // Validate each row on its own so a bad row is reported without rejecting the batch.
  const valid: { index: number; row: ReturnType<typeof importRow.parse> }[] = [];
  const results: ImportResult[] = [];
  data.rows.forEach((candidate, index) => {
    const r = importRow.safeParse(candidate);
    if (r.success) valid.push({ index, row: r.data });
    else {
      const sku = typeof (candidate as { sku?: unknown } | null)?.sku === 'string' ? (candidate as { sku: string }).sku : '';
      results.push({ index, sku, status: 'error', error: r.error.issues.map((i) => `${i.path.join('.') || 'row'}: ${i.message}`).join('; ') });
    }
  });
  if (valid.length) {
    const out = unwrap(await inventory(c).importProducts(caller(c), await idemFrom(c, raw), data.mode, valid));
    results.push(...out.body.results);
  } else await idemFrom(c, raw); // still require the header, so clients behave the same either way
  results.sort((a, b) => a.index - b.index);
  const count = (s: ImportResult['status']) => results.filter((r) => r.status === s).length;
  return c.json({ results, summary: { created: count('created'), updated: count('updated'), unchanged: count('unchanged'), errors: count('error') } });
});

route('get', '/orgs/:orgId/products/lookup', 'inventory:read', async (c) => {
  const code = parse(z.string().trim().min(1).max(64), c.req.query('code'));
  const r = unwrap(await inventory(c).lookupProduct(code));
  etag(c, r.product.version);
  return c.json(r);
});

route('get', '/orgs/:orgId/products/:id', 'inventory:read', async (c) => {
  const r = unwrap(await inventory(c).getProduct(c.req.param('id') ?? ''));
  etag(c, r.product.version);
  return c.json(r);
});

route('patch', '/orgs/:orgId/products/:id', 'products:write', async (c) => {
  const version = ifMatch(c);
  const { data } = await readJson(c, productPatch);
  const waiting = await needsApproval(c, 'price_drop', { productId: c.req.param('id') ?? '', version, patch: data });
  if (waiting) return c.json({ approval: waiting }, 202);
  const out = unwrap(await inventory(c).updateProduct(caller(c), undefined, c.req.param('id') ?? '', version, data));
  etag(c, out.body.product.version);
  return c.json(out.body, out.status as 200);
});

route('delete', '/orgs/:orgId/products/:id', 'products:write', async (c) => {
  const out = unwrap(await inventory(c).deleteProduct(caller(c), c.req.param('id') ?? '', ifMatch(c)));
  return c.json(out.body, out.status as 200);
});

route('post', '/orgs/:orgId/products/:id/restore', 'products:write', async (c) => {
  const out = unwrap(await inventory(c).restoreProduct(caller(c), c.req.param('id') ?? ''));
  return c.json(out.body, out.status as 200);
});

route('get', '/orgs/:orgId/locations', 'inventory:read', async (c) => c.json({ data: await inventory(c).listLocations() }));

route('post', '/orgs/:orgId/locations', 'settings:manage', async (c) => {
  const { data } = await readJson(c, locationInput);
  const out = unwrap(await inventory(c).createLocation(caller(c), data));
  return c.json(out.body, out.status as 201);
});

route('delete', '/orgs/:orgId/locations/:id', 'settings:manage', async (c) => {
  const out = unwrap(await inventory(c).archiveLocation(caller(c), c.req.param('id') ?? ''));
  return c.json(out.body, out.status as 200);
});

route('post', '/orgs/:orgId/stock/movements', 'stock:write', async (c) => {
  const { data, raw } = await readJson(c, movementInput);
  needLocation(c, data.locationId);
  const waiting = await needsApproval(c, 'movement', data);
  if (waiting) return c.json({ approval: waiting }, 202);
  const out = unwrap(await inventory(c).addMovement(caller(c), await idemFrom(c, raw), data));
  return c.json(out.body, out.status as 201);
});

route('post', '/orgs/:orgId/stock/transfers', 'stock:write', async (c) => {
  const { data, raw } = await readJson(c, transferInput);
  needLocation(c, data.fromLocationId); // may send to anywhere, but only from their own location
  const out = unwrap(await inventory(c).transfer(caller(c), await idemFrom(c, raw), data));
  return c.json(out.body, out.status as 201);
});

route('post', '/orgs/:orgId/stock/counts', 'stock:write', async (c) => {
  const { data, raw } = await readJson(c, countInput);
  needLocation(c, data.locationId);
  const waiting = await needsApproval(c, 'count', data);
  if (waiting) return c.json({ approval: waiting }, 202);
  const out = unwrap(await inventory(c).count(caller(c), await idemFrom(c, raw), data));
  return c.json(out.body, out.status as 201);
});


// -------------------------------------------------------------------- orders
route('get', '/orgs/:orgId/orders', 'inventory:read', async (c) => c.json(await inventory(c).listOrders(parse(orderListQuery, c.req.query()))));

/** Scoped staff can only act on orders fulfilled from their locations. */
async function orderLocationGuard(c: Ctx): Promise<void> {
  if (!c.get('org').locationIds) return;
  const r = unwrap(await inventory(c).getOrder(c.req.param('id') ?? ''));
  needLocation(c, r.order.locationId);
}

route('post', '/orgs/:orgId/orders', 'orders:write', async (c) => {
  const { data: parsed, raw } = await readJson(c, orderInput);
  const scoped = c.get('org').locationIds;
  const data = scoped && !parsed.locationId ? { ...parsed, locationId: scoped[0] } : parsed; // scoped staff default to their own location
  needLocation(c, data.locationId);
  const out = unwrap(await inventory(c).createOrder(caller(c), await idemFrom(c, raw), data));
  etag(c, out.body.order.version);
  return c.json(out.body, out.status as 201);
});

route('get', '/orgs/:orgId/orders/:id', 'inventory:read', async (c) => {
  const r = unwrap(await inventory(c).getOrder(c.req.param('id') ?? ''));
  etag(c, r.order.version);
  return c.json(r);
});

route('post', '/orgs/:orgId/orders/:id/paid', 'orders:write', async (c) => {
  await orderLocationGuard(c);
  const version = ifMatch(c);
  const { data } = await readJson(c, paidInput);
  const out = unwrap(await inventory(c).setOrderPaid(caller(c), c.req.param('id') ?? '', version, data.paid));
  etag(c, out.body.order.version);
  return c.json(out.body, out.status as 200);
});

route('post', '/orgs/:orgId/orders/:id/ship', 'orders:write', async (c) => {
  await orderLocationGuard(c);
  const out = unwrap(await inventory(c).shipOrder(caller(c), c.req.param('id') ?? '', ifMatch(c)));
  etag(c, out.body.order.version);
  return c.json(out.body, out.status as 200);
});

route('post', '/orgs/:orgId/orders/:id/cancel', 'orders:write', async (c) => {
  await orderLocationGuard(c);
  const version = ifMatch(c);
  const waiting = await needsApproval(c, 'cancel_order', { orderId: c.req.param('id') ?? '', version });
  if (waiting) return c.json({ approval: waiting }, 202);
  const out = unwrap(await inventory(c).cancelOrder(caller(c), c.req.param('id') ?? '', version));
  etag(c, out.body.order.version);
  return c.json(out.body, out.status as 200);
});

route('get', '/orgs/:orgId/stock/movements', 'inventory:read', async (c) => c.json(await inventory(c).listMovements(parse(movementListQuery, c.req.query()))));

// ----------------------------------------------------------------- approvals
route('get', '/orgs/:orgId/approvals', 'inventory:read', async (c) => {
  const q = z.object({ state: z.enum(['pending', 'approved', 'applied', 'rejected', 'withdrawn', 'expired', 'failed']).optional(), mine: z.enum(['1']).optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }).parse(c.req.query());
  // Deciders see everything; everyone else sees only what they asked for.
  const deciders = can(c.get('org').role, 'approvals:decide');
  const data = await inventory(c).listApprovals({ state: q.state, requestedBy: !deciders || q.mine ? c.get('user').id : undefined, limit: q.limit });
  const pending = deciders ? await inventory(c).pendingApprovalCount() : null;
  return c.json({ data, pending });
});

route('post', '/orgs/:orgId/approvals/:aid/approve', 'approvals:decide', async (c) => {
  const { data } = await readJson(c, z.object({ note: z.string().trim().max(500).optional() }).strict());
  return c.json(unwrap(await inventory(c).decideApproval(caller(c), c.req.param('aid') ?? '', true, data.note ?? null)));
});

route('post', '/orgs/:orgId/approvals/:aid/reject', 'approvals:decide', async (c) => {
  const { data } = await readJson(c, z.object({ note: z.string().trim().min(1).max(500) }).strict());
  return c.json(unwrap(await inventory(c).decideApproval(caller(c), c.req.param('aid') ?? '', false, data.note)));
});

route('post', '/orgs/:orgId/approvals/:aid/withdraw', 'inventory:read', async (c) => c.json(unwrap(await inventory(c).withdrawApproval(caller(c), c.req.param('aid') ?? ''))));

// ------------------------------------------------------------------- reports
const csvCell = (v: unknown) => { const t = v == null ? '' : String(v); const safe = /^[=+\-@\t\r]/.test(t) ? `'${t}` : t; return /[",\n\r]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe; };
const toCsv = (r: ReportResult) => {
  const money = (v: unknown) => (v == null || v === '' ? '' : (Number(v) / 100).toFixed(2));
  const lines = [r.columns.map((c) => csvCell(c.label)).join(',')];
  for (const row of r.rows) lines.push(r.columns.map((c) => csvCell(c.kind === 'money' ? money(row[c.key]) : row[c.key])).join(','));
  return lines.join('\r\n') + '\r\n';
};

route('get', '/orgs/:orgId/reports/:name', 'reports:read', async (c) => {
  const name = z.enum(REPORTS).safeParse(c.req.param('name'));
  if (!name.success) throw new AppError(404, 'report_not_found', 'There is no such report.');
  const q = parse(reportQuery, c.req.query());
  if (q.from && q.to && (Date.parse(q.to) < Date.parse(q.from) || Date.parse(q.to) - Date.parse(q.from) > 366 * 86400_000)) throw new AppError(400, 'bad_range', 'Choose a range of at most 366 days, with the start before the end.');
  const result = await inventory(c).report(name.data, { from: q.from, to: q.to, location: q.location, days: q.days });
  if (q.format === 'csv') {
    return new Response(toCsv(result), { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${name.data}-${result.from}-${result.to}.csv"` } });
  }
  return c.json(result);
});

route('get', '/orgs/:orgId/audit', 'audit:read', async (c) => c.json(await inventory(c).listAudit(parse(pageQuery, c.req.query()))));


// ------------------------------------------------------- platform administration
// The super admin manages organizations and accounts. No route below touches inventory data, and
// the inventory routes require organization membership, so the super admin cannot read tenants' stock.
async function platformAudit(c: Ctx, action: string, target: string | null, detail?: unknown): Promise<void> {
  await c.env.DB.prepare(`INSERT INTO platform_audit(id, actor, action, target, detail, request_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(newId('pau'), c.get('user').id, action, target, detail === undefined ? null : JSON.stringify(detail), c.get('requestId'), nowIso())
    .run();
}

route('get', '/admin/overview', 'super', async (c) => {
  const now = nowIso();
  const counts = await c.env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM users) AS users,
            (SELECT COUNT(*) FROM users WHERE disabled_at IS NOT NULL) AS disabledUsers,
            (SELECT COUNT(*) FROM organizations WHERE deleted_at IS NULL) AS organizations,
            (SELECT COUNT(*) FROM organizations WHERE deleted_at IS NULL AND suspended_at IS NOT NULL) AS suspendedOrganizations,
            (SELECT COUNT(*) FROM sessions WHERE expires_at > ?) AS activeSessions`,
  ).bind(now).first();
  return c.json({ ...counts, signin: ({ 'admin-only': 'owner-only', invite: 'invite-only', open: 'open' } as const)[signinMode(c.env)] });
});

route('get', '/admin/orgs', 'super', async (c) => {
  const q = parse(pageQuery, c.req.query());
  const cur = decodeCursor<{ c: string; i: string }>(q.cursor);
  const { results } = await c.env.DB.prepare(
    `SELECT o.id, o.name, o.slug, o.created_at AS createdAt, o.deleted_at AS deletedAt, o.suspended_at AS suspendedAt,
            (SELECT COUNT(*) FROM memberships m WHERE m.org_id = o.id) AS members,
            CASE WHEN o.deleted_at IS NOT NULL THEN 'deleted' WHEN o.suspended_at IS NOT NULL THEN 'suspended'
                 WHEN NOT EXISTS (SELECT 1 FROM memberships m WHERE m.org_id = o.id) THEN 'pending' ELSE 'active' END AS status
       FROM organizations o
      ${cur ? 'WHERE (o.created_at < ? OR (o.created_at = ? AND o.id < ?))' : ''}
      ORDER BY o.created_at DESC, o.id DESC LIMIT ?`,
  ).bind(...(cur ? [cur.c, cur.c, cur.i] : []), q.limit + 1).all<{ id: string; createdAt: string }>();
  const hasMore = results.length > q.limit;
  const data = results.slice(0, q.limit);
  const last = data[data.length - 1];
  return c.json({ data, nextCursor: hasMore && last ? encodeCursor({ c: last.createdAt, i: last.id }) : null, hasMore });
});

route('get', '/admin/users', 'super', async (c) => {
  const q = parse(pageQuery, c.req.query());
  const cur = decodeCursor<{ c: string; i: string }>(q.cursor);
  const { results } = await c.env.DB.prepare(
    `SELECT u.id, u.email, u.name, u.created_at AS createdAt, u.disabled_at AS disabledAt,
            (SELECT COUNT(*) FROM memberships m WHERE m.user_id = u.id) AS organizations,
            (SELECT MAX(s.last_seen_at) FROM sessions s WHERE s.user_id = u.id) AS lastSeenAt
       FROM users u
      ${cur ? 'WHERE (u.created_at < ? OR (u.created_at = ? AND u.id < ?))' : ''}
      ORDER BY u.created_at DESC, u.id DESC LIMIT ?`,
  ).bind(...(cur ? [cur.c, cur.c, cur.i] : []), q.limit + 1).all<{ id: string; createdAt: string }>();
  const hasMore = results.length > q.limit;
  const data = results.slice(0, q.limit);
  const last = data[data.length - 1];
  return c.json({ data, nextCursor: hasMore && last ? encodeCursor({ c: last.createdAt, i: last.id }) : null, hasMore });
});

route('post', '/admin/users/:id/disable', 'super', async (c) => {
  const id = c.req.param('id') ?? '';
  if (id === c.get('user').id) throw new AppError(409, 'cannot_disable_self', 'You cannot disable your own account.');
  const res = await c.env.DB.prepare(`UPDATE users SET disabled_at = ? WHERE id = ? AND disabled_at IS NULL`).bind(nowIso(), id).run();
  if (!res.meta.changes) throw new AppError(404, 'user_not_found', 'That user does not exist or is already disabled.');
  await c.env.DB.prepare(`DELETE FROM sessions WHERE user_id = ?`).bind(id).run(); // signed out immediately
  await platformAudit(c, 'user.disable', id);
  return c.json({ ok: true });
});

route('post', '/admin/users/:id/enable', 'super', async (c) => {
  const id = c.req.param('id') ?? '';
  const res = await c.env.DB.prepare(`UPDATE users SET disabled_at = NULL WHERE id = ? AND disabled_at IS NOT NULL`).bind(id).run();
  if (!res.meta.changes) throw new AppError(404, 'user_not_found', 'That user does not exist or is not disabled.');
  await platformAudit(c, 'user.enable', id);
  return c.json({ ok: true });
});

const slugFor = (name: string) => `${name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'org'}-${randomToken(3).toLowerCase().replace(/[^a-z0-9]/g, 'x')}`;

/** Onboarding: creates a business with no members and invites its admin. The platform owner never becomes a member. */
route('post', '/admin/orgs', 'super', async (c) => {
  const { data } = await readJson(c, z.object({ name: z.string().trim().min(1).max(100), adminEmail: z.string().trim().toLowerCase().email().max(254), currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/).default('USD') }).strict());
  const reserved = await c.env.DB.prepare(`SELECT 1 AS x FROM users u JOIN oauth_accounts o ON o.user_id = u.id WHERE u.email = ? AND o.provider = 'github' LIMIT 1`).bind(data.adminEmail).first();
  if (reserved) throw new AppError(409, 'email_in_use', 'That email belongs to the platform owner account. Use a different email for the business admin.');
  const disabled = await c.env.DB.prepare(`SELECT 1 AS x FROM users WHERE email = ? AND disabled_at IS NOT NULL`).bind(data.adminEmail).first();
  if (disabled) throw new AppError(409, 'user_disabled', 'That account is disabled. Enable it first.');
  const id = newId('org');
  await c.env.DB.prepare(`INSERT INTO organizations(id, name, slug, currency, created_at) VALUES (?, ?, ?, ?, ?)`).bind(id, data.name, slugFor(data.name), data.currency, nowIso()).run();
  const inv = await createInvitation(c, { orgId: id, email: data.adminEmail, role: 'admin', invitedBy: c.get('user').id });
  await platformAudit(c, 'org.onboard', id, { name: data.name, adminDomain: data.adminEmail.split('@')[1] });
  return c.json({ organization: { id, name: data.name, status: 'pending' }, invitation: { id: inv.id, link: inv.link, expiresAt: inv.expiresAt } }, 201);
});

route('post', '/admin/orgs/:id/resend-invitation', 'super', async (c) => {
  const id = c.req.param('id') ?? '';
  const old = await c.env.DB.prepare(`SELECT email FROM invitations WHERE org_id = ? AND role = 'admin' AND accepted_at IS NULL ORDER BY created_at DESC LIMIT 1`).bind(id).first<{ email: string }>();
  if (!old) throw new AppError(404, 'invitation_invalid', 'There is no pending admin invitation for that business.');
  const inv = await createInvitation(c, { orgId: id, email: old.email, role: 'admin', invitedBy: c.get('user').id });
  await platformAudit(c, 'org.invitation_resent', id);
  return c.json({ id: inv.id, link: inv.link, expiresAt: inv.expiresAt });
});

/** A business page for the platform owner: health and people, never products, customers or orders. */
route('get', '/admin/orgs/:id', 'super', async (c) => {
  const id = c.req.param('id') ?? '';
  const org = await c.env.DB.prepare(
    `SELECT id, name, slug, currency, created_at AS createdAt, suspended_at AS suspendedAt, deleted_at AS deletedAt FROM organizations WHERE id = ?`,
  ).bind(id).first<{ id: string; suspendedAt: string | null; deletedAt: string | null }>();
  if (!org) throw new AppError(404, 'org_not_found', 'That organization does not exist.');
  const { results: members } = await c.env.DB.prepare(
    `SELECT u.id, u.name, u.email, m.role, m.deactivated_at AS deactivatedAt, (SELECT MAX(s.last_seen_at) FROM sessions s WHERE s.user_id = u.id) AS lastSeenAt
       FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.org_id = ? ORDER BY m.created_at`,
  ).bind(id).all();
  const { results: pending } = await c.env.DB.prepare(`SELECT id, email, role, expires_at AS expiresAt FROM invitations WHERE org_id = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?`).bind(id, nowIso()).all();
  const keys = await c.env.DB.prepare(`SELECT (SELECT COUNT(*) FROM api_keys WHERE org_id = ? AND revoked_at IS NULL) AS apiKeys, (SELECT COUNT(*) FROM webhooks WHERE org_id = ?) AS webhooks`).bind(id, id).first();
  const stub = c.env.INVENTORY.get(c.env.INVENTORY.idFromName(id));
  const stats = await stub.stats();
  const status = org.deletedAt ? 'deleted' : org.suspendedAt ? 'suspended' : members.length === 0 ? 'pending' : 'active';
  return c.json({ organization: { ...org, status }, members, pendingInvitations: pending, counts: { ...keys, ...stats } });
});

/** Recovery when the only admin has gone: the platform owner makes an existing member the admin. Changes a role only. */
route('post', '/admin/orgs/:id/transfer-admin', 'super', async (c) => {
  const id = c.req.param('id') ?? '';
  const { data } = await readJson(c, z.object({ userId: z.string().max(60) }).strict());
  const target = await c.env.DB.prepare(`SELECT 1 AS x FROM memberships WHERE org_id = ? AND user_id = ? AND deactivated_at IS NULL`).bind(id, data.userId).first();
  if (!target) throw new AppError(404, 'member_not_found', 'That person is not an active member of this business.');
  await c.env.DB.prepare(`UPDATE memberships SET role = 'admin' WHERE org_id = ? AND user_id = ?`).bind(id, data.userId).run();
  await platformAudit(c, 'org.transfer_admin', id, { userId: data.userId });
  return c.json({ ok: true });
});

route('get', '/admin/users/:id', 'super', async (c) => {
  const id = c.req.param('id') ?? '';
  const user = await c.env.DB.prepare(`SELECT id, email, name, created_at AS createdAt, disabled_at AS disabledAt FROM users WHERE id = ?`).bind(id).first();
  if (!user) throw new AppError(404, 'user_not_found', 'That user does not exist.');
  const { results: methods } = await c.env.DB.prepare(`SELECT provider FROM oauth_accounts WHERE user_id = ?`).bind(id).all<{ provider: string }>();
  const passkeys = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM passkeys WHERE user_id = ?`).bind(id).first<{ n: number }>();
  const { results: orgs } = await c.env.DB.prepare(`SELECT o.id, o.name, m.role, m.deactivated_at AS deactivatedAt FROM memberships m JOIN organizations o ON o.id = m.org_id WHERE m.user_id = ?`).bind(id).all();
  const { results: sessions } = await c.env.DB.prepare(`SELECT created_at AS createdAt, last_seen_at AS lastSeenAt, user_agent AS userAgent, ip_country AS country, provider AS via FROM sessions WHERE user_id = ? AND expires_at > ? ORDER BY last_seen_at DESC`).bind(id, nowIso()).all();
  return c.json({ user, signInMethods: [...methods.map((m) => m.provider), ...(passkeys?.n ? ['passkey'] : [])], organizations: orgs, sessions });
});

route('post', '/admin/users/:id/sign-out', 'super', async (c) => {
  const id = c.req.param('id') ?? '';
  const r = await c.env.DB.prepare(`DELETE FROM sessions WHERE user_id = ?`).bind(id).run();
  await platformAudit(c, 'user.sign_out', id, { sessions: r.meta.changes ?? 0 });
  return c.json({ revoked: r.meta.changes ?? 0 });
});

route('post', '/admin/orgs/:id/suspend', 'super', async (c) => {
  const id = c.req.param('id') ?? '';
  const res = await c.env.DB.prepare(`UPDATE organizations SET suspended_at = ? WHERE id = ? AND suspended_at IS NULL AND deleted_at IS NULL`).bind(nowIso(), id).run();
  if (!res.meta.changes) throw new AppError(404, 'org_not_found', 'That organization does not exist or is already suspended.');
  await platformAudit(c, 'org.suspend', id);
  return c.json({ ok: true });
});

route('post', '/admin/orgs/:id/restore', 'super', async (c) => {
  const id = c.req.param('id') ?? '';
  const res = await c.env.DB.prepare(`UPDATE organizations SET suspended_at = NULL WHERE id = ? AND suspended_at IS NOT NULL`).bind(id).run();
  if (!res.meta.changes) throw new AppError(404, 'org_not_found', 'That organization does not exist or is not suspended.');
  await platformAudit(c, 'org.restore', id);
  return c.json({ ok: true });
});

route('get', '/admin/audit', 'super', async (c) => {
  const q = parse(pageQuery, c.req.query());
  const cur = decodeCursor<{ c: string; i: string }>(q.cursor);
  const { results } = await c.env.DB.prepare(
    `SELECT id, actor, action, target, detail, request_id AS requestId, created_at AS createdAt FROM platform_audit
      ${cur ? 'WHERE (created_at < ? OR (created_at = ? AND id < ?))' : ''} ORDER BY created_at DESC, id DESC LIMIT ?`,
  ).bind(...(cur ? [cur.c, cur.c, cur.i] : []), q.limit + 1).all<{ id: string; createdAt: string; detail: string | null }>();
  const hasMore = results.length > q.limit;
  const data = results.slice(0, q.limit).map((r) => ({ ...r, detail: r.detail ? JSON.parse(r.detail) : null }));
  const last = data[data.length - 1];
  return c.json({ data, nextCursor: hasMore && last ? encodeCursor({ c: last.createdAt, i: last.id }) : null, hasMore });
});

// Human-readable reference, generated from the same route table. Script-free; its only style block uses a per-response nonce.
app.get('/api/docs', (c) => {
  const nonce = randomToken(16);
  c.header('Content-Security-Policy', `default-src 'none'; style-src 'nonce-${nonce}'; frame-ancestors 'none'`);
  return c.html(renderDocsPage(buildOpenApi(ROUTES, new URL(c.req.url).origin), nonce));
});

app.route('/api/v1', api);

export default {
  fetch: (req: Request, env: Bindings, ctx: ExecutionContext) => app.fetch(req, env, ctx),
  queue: (batch: MessageBatch<unknown>, env: Bindings) => handleQueue(batch as MessageBatch<DeliveryJob>, env),
} satisfies ExportedHandler<Bindings>;
