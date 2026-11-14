import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { z, type ZodType } from 'zod';
import {
  PERMISSIONS,
  ROLE_RANK,
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
  pageQuery,
  paidInput,
  productInput,
  productListQuery,
  productPatch,
  transferInput,
  type ImportResult,
  type Permission,
  type Role,
} from '@shoplist/shared';
import {
  OAUTH_COOKIE,
  SESSION_COOKIE,
  createSession,
  destroySession,
  githubAuthorizeUrl,
  githubProfile,
  KEY_PREFIX,
  keyFromBearer,
  mayUse,
  pkcePair,
  signPayload,
  signinClosed,
  upsertUser,
  userFromSession,
  verifyPayload,
  type ApiKeyPrincipal,
  type AuthUser,
} from './auth';
import type { Bindings } from './env';
import { clerkConfigured, fetchClerkProfile, verifyClerkToken } from './clerk';
import { AppError, problemResponse, unwrap } from './errors';
import type { Caller, Idem } from './inventory-do';
import { decodeCursor, encodeCursor, newId, nowIso, randomToken, sha256Hex } from './util';

export { InventoryDO } from './inventory-do';

type Vars = { requestId: string; user: AuthUser; org: { id: string; role: Role }; apiKey?: ApiKeyPrincipal };
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
    h.set('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
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
    const granted: Role = key.scopes.includes('inventory:write') ? 'editor' : 'viewer';
    if (permission === 'org:manage' || permission === 'org:owner' || ROLE_RANK[granted] < ROLE_RANK[PERMISSIONS[permission]]) {
      throw new AppError(403, 'forbidden', 'This API key does not have permission to do that.');
    }
    c.set('org', { id: orgId, role: granted });
    return next();
  }
  const row = await c.env.DB.prepare(
    `SELECT m.role FROM memberships m JOIN organizations o ON o.id = m.org_id WHERE m.org_id = ? AND m.user_id = ? AND o.deleted_at IS NULL AND o.suspended_at IS NULL`,
  )
    .bind(orgId, c.get('user').id)
    .first<{ role: Role }>();
  // Not a member: 404, so organization ids cannot be probed.
  if (!row) throw new AppError(404, 'org_not_found', 'That organization does not exist.');
  const needed = PERMISSIONS[permission];
  if (ROLE_RANK[row.role] < ROLE_RANK[needed]) throw new AppError(403, 'forbidden', `Your role (${row.role}) cannot do this. Ask an admin for access.`);
  c.set('org', { id: orgId, role: row.role });
  return next();
};

// Every route must declare who may call it. The registry lets a test prove none was forgotten.
type Access = Permission | 'user' | 'super' | 'public';
export const ROUTES: { method: string; path: string; access: Access }[] = [];
const api = new Hono<{ Bindings: Bindings; Variables: Vars }>();
api.use('*', rateLimit, originCheck);

type Handler = (c: Ctx) => Response | Promise<Response>;
function route(method: 'get' | 'post' | 'patch' | 'delete', path: string, access: Access, handler: Handler): void {
  ROUTES.push({ method: method.toUpperCase(), path, access });
  const guards: MiddlewareHandler<{ Bindings: Bindings; Variables: Vars }>[] =
    access === 'public' ? [] : access === 'user' ? [requireUser] : access === 'super' ? [requireUser, requireSuper] : access === 'org:manage' || access === 'org:owner' ? [requireUser, orgAccess(access)] : [requireAuth, orgAccess(access)];
  const handlers = [...guards, handler] as MiddlewareHandler[];
  (api[method] as (path: string, ...h: MiddlewareHandler[]) => unknown).call(api, path, ...handlers);
}

// -------------------------------------------------------------------- public
route('get', '/health', 'public', (c) => c.json({ ok: true, signin: signinClosed(c.env) ? 'owner-only' : 'open' }));

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
  // Customers can sign in only when the deployment is open; the owner uses GitHub.
  if (signinClosed(c.env)) throw new AppError(403, 'signin_closed', 'This ShopList is private. Only the site owner can sign in.');
  const profile = await fetchClerkProfile(c.env, sub);
  // The owner's account is reachable only through the owner's door. A customer-door identity must never attach to it.
  const owner = await c.env.DB.prepare(`SELECT 1 AS x FROM users u JOIN oauth_accounts o ON o.user_id = u.id WHERE u.email = ? AND o.provider = 'github' LIMIT 1`).bind(profile.email.toLowerCase()).first();
  if (owner) throw new AppError(409, 'email_in_use', 'That email belongs to a different kind of account. Use the other sign-in.');
  const user = await upsertUser(c.env, profile, { provider: 'clerk', providerUserId: sub });
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

route('post', '/auth/logout', 'user', async (c) => {
  await destroySession(c.env, readSessionCookie(c));
  clearCookie(c, SESSION_COOKIE);
  return c.json({ ok: true });
});

route('get', '/me', 'user', async (c) => {
  const user = c.get('user');
  const { results } = await c.env.DB.prepare(
    `SELECT o.id, o.name, o.slug, o.currency, m.role FROM memberships m JOIN organizations o ON o.id = m.org_id WHERE m.user_id = ? AND o.deleted_at IS NULL AND o.suspended_at IS NULL ORDER BY o.name`,
  ).bind(user.id).all();
  return c.json({ user, organizations: results });
});

// ------------------------------------------------------------- organizations
route('post', '/orgs', 'user', async (c) => {
  const user = c.get('user');
  const { data } = await readJson(c, orgInput);
  const owned = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM memberships WHERE user_id = ? AND role = 'owner'`).bind(user.id).first<{ n: number }>();
  if ((owned?.n ?? 0) >= 5) throw new AppError(409, 'org_limit', 'You can own at most 5 organizations.');
  const id = newId('org');
  const slug = `${data.name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'org'}-${randomToken(3).toLowerCase().replace(/[^a-z0-9]/g, 'x')}`;
  const now = nowIso();
  await c.env.DB.batch([
    c.env.DB.prepare(`INSERT INTO organizations(id, name, slug, created_at) VALUES (?, ?, ?, ?)`).bind(id, data.name, slug, now),
    c.env.DB.prepare(`INSERT INTO memberships(org_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)`).bind(id, user.id, now),
  ]);
  return c.json({ organization: { id, name: data.name, slug, currency: 'USD', role: 'owner' } }, 201);
});

route('get', '/orgs/:orgId', 'inventory:read', async (c) => {
  const org = await c.env.DB.prepare(`SELECT id, name, slug, currency, created_at FROM organizations WHERE id = ?`).bind(c.get('org').id).first();
  return c.json({ organization: { ...org, role: c.get('org').role } });
});

route('patch', '/orgs/:orgId', 'org:manage', async (c) => {
  const { data } = await readJson(c, orgInput);
  await c.env.DB.prepare(`UPDATE organizations SET name = ? WHERE id = ?`).bind(data.name, c.get('org').id).run();
  return c.json({ ok: true });
});

route('delete', '/orgs/:orgId', 'org:owner', async (c) => {
  await c.env.DB.prepare(`UPDATE organizations SET deleted_at = ? WHERE id = ?`).bind(nowIso(), c.get('org').id).run();
  return c.json({ ok: true });
});

// ------------------------------------------------------------------- members
route('get', '/orgs/:orgId/members', 'inventory:read', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT u.id, u.name, u.email, u.avatar_url, m.role, m.created_at FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.org_id = ? ORDER BY m.created_at`,
  ).bind(c.get('org').id).all();
  return c.json({ data: results });
});

async function ownerCount(c: Ctx): Promise<number> {
  return (await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM memberships WHERE org_id = ? AND role = 'owner'`).bind(c.get('org').id).first<{ n: number }>())?.n ?? 0;
}

route('patch', '/orgs/:orgId/members/:userId', 'org:manage', async (c) => {
  const { data } = await readJson(c, memberPatch);
  const actor = c.get('org').role;
  const target = await c.env.DB.prepare(`SELECT role FROM memberships WHERE org_id = ? AND user_id = ?`).bind(c.get('org').id, c.req.param('userId')).first<{ role: Role }>();
  if (!target) throw new AppError(404, 'member_not_found', 'That person is not a member.');
  // Only an owner may grant or change the owner role.
  if ((data.role === 'owner' || target.role === 'owner') && actor !== 'owner') throw new AppError(403, 'forbidden', 'Only an owner can change owner roles.');
  if (target.role === 'owner' && data.role !== 'owner' && (await ownerCount(c)) <= 1) throw new AppError(409, 'last_owner', 'An organization needs at least one owner.');
  await c.env.DB.prepare(`UPDATE memberships SET role = ? WHERE org_id = ? AND user_id = ?`).bind(data.role, c.get('org').id, c.req.param('userId')).run();
  return c.json({ ok: true });
});

route('delete', '/orgs/:orgId/members/:userId', 'org:manage', async (c) => {
  const target = await c.env.DB.prepare(`SELECT role FROM memberships WHERE org_id = ? AND user_id = ?`).bind(c.get('org').id, c.req.param('userId')).first<{ role: Role }>();
  if (!target) throw new AppError(404, 'member_not_found', 'That person is not a member.');
  if (target.role === 'owner' && c.get('org').role !== 'owner') throw new AppError(403, 'forbidden', 'Only an owner can remove an owner.');
  if (target.role === 'owner' && (await ownerCount(c)) <= 1) throw new AppError(409, 'last_owner', 'An organization needs at least one owner.');
  await c.env.DB.prepare(`DELETE FROM memberships WHERE org_id = ? AND user_id = ?`).bind(c.get('org').id, c.req.param('userId')).run();
  return c.json({ ok: true });
});

route('post', '/orgs/:orgId/invitations', 'org:manage', async (c) => {
  const { data } = await readJson(c, inviteInput);
  const token = randomToken(32);
  await c.env.DB.prepare(`INSERT INTO invitations(token_hash, org_id, email, role, invited_by, expires_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(await sha256Hex(token), c.get('org').id, data.email, data.role, c.get('user').id, new Date(Date.now() + 7 * 86400_000).toISOString())
    .run();
  // The token is shown once; share the link with the invitee.
  return c.json({ token, link: `${c.env.APP_ORIGIN}/invite/${token}`, email: data.email, role: data.role }, 201);
});

route('post', '/invitations/:token/accept', 'user', async (c) => {
  const hash = await sha256Hex(c.req.param('token') ?? '');
  const inv = await c.env.DB.prepare(`SELECT org_id, email, role, expires_at, accepted_at FROM invitations WHERE token_hash = ?`).bind(hash).first<{ org_id: string; email: string; role: Role; expires_at: string; accepted_at: string | null }>();
  if (!inv || inv.accepted_at || Date.parse(inv.expires_at) < Date.now()) throw new AppError(404, 'invitation_invalid', 'This invitation is invalid or has expired.');
  const user = c.get('user');
  // A stolen link is useless to anyone signed in with a different email.
  if (inv.email.toLowerCase() !== user.email.toLowerCase()) throw new AppError(403, 'invitation_wrong_account', `This invitation was sent to ${inv.email}. Sign in with that account.`);
  await c.env.DB.batch([
    c.env.DB.prepare(`INSERT OR IGNORE INTO memberships(org_id, user_id, role, created_at) VALUES (?, ?, ?, ?)`).bind(inv.org_id, user.id, inv.role, nowIso()),
    c.env.DB.prepare(`UPDATE invitations SET accepted_at = ? WHERE token_hash = ?`).bind(nowIso(), hash),
  ]);
  return c.json({ organizationId: inv.org_id, role: inv.role });
});


// ------------------------------------------------------------------ API keys
route('get', '/orgs/:orgId/api-keys', 'org:manage', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT id, name, prefix, scopes, created_at AS createdAt, last_used_at AS lastUsedAt, expires_at AS expiresAt, revoked_at AS revokedAt
       FROM api_keys WHERE org_id = ? ORDER BY created_at DESC`,
  ).bind(c.get('org').id).all<{ scopes: string }>();
  return c.json({ data: results.map((r) => ({ ...r, scopes: JSON.parse(r.scopes) as string[] })) });
});

route('post', '/orgs/:orgId/api-keys', 'org:manage', async (c) => {
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

route('delete', '/orgs/:orgId/api-keys/:id', 'org:manage', async (c) => {
  const res = await c.env.DB.prepare(`UPDATE api_keys SET revoked_at = ? WHERE id = ? AND org_id = ? AND revoked_at IS NULL`).bind(nowIso(), c.req.param('id') ?? '', c.get('org').id).run();
  if (!res.meta.changes) throw new AppError(404, 'key_not_found', 'That key does not exist or is already revoked.');
  return c.json({ ok: true });
});

// ----------------------------------------------------------------- inventory
route('get', '/orgs/:orgId/dashboard', 'inventory:read', async (c) => c.json(await inventory(c).dashboard()));

route('get', '/orgs/:orgId/products', 'inventory:read', async (c) => c.json(await inventory(c).listProducts(parse(productListQuery, c.req.query()))));

route('post', '/orgs/:orgId/products', 'inventory:write', async (c) => {
  const { data, raw } = await readJson(c, productInput);
  const out = unwrap(await inventory(c).createProduct(caller(c), await idemFrom(c, raw), data));
  etag(c, out.body.product.version);
  return c.json(out.body, out.status as 201);
});

route('post', '/orgs/:orgId/products/import', 'inventory:write', async (c) => {
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

route('patch', '/orgs/:orgId/products/:id', 'inventory:write', async (c) => {
  const version = ifMatch(c);
  const { data } = await readJson(c, productPatch);
  const out = unwrap(await inventory(c).updateProduct(caller(c), undefined, c.req.param('id') ?? '', version, data));
  etag(c, out.body.product.version);
  return c.json(out.body, out.status as 200);
});

route('delete', '/orgs/:orgId/products/:id', 'inventory:write', async (c) => {
  const out = unwrap(await inventory(c).deleteProduct(caller(c), c.req.param('id') ?? '', ifMatch(c)));
  return c.json(out.body, out.status as 200);
});

route('post', '/orgs/:orgId/products/:id/restore', 'inventory:write', async (c) => {
  const out = unwrap(await inventory(c).restoreProduct(caller(c), c.req.param('id') ?? ''));
  return c.json(out.body, out.status as 200);
});

route('get', '/orgs/:orgId/locations', 'inventory:read', async (c) => c.json({ data: await inventory(c).listLocations() }));

route('post', '/orgs/:orgId/locations', 'org:manage', async (c) => {
  const { data } = await readJson(c, locationInput);
  const out = unwrap(await inventory(c).createLocation(caller(c), data));
  return c.json(out.body, out.status as 201);
});

route('delete', '/orgs/:orgId/locations/:id', 'org:manage', async (c) => {
  const out = unwrap(await inventory(c).archiveLocation(caller(c), c.req.param('id') ?? ''));
  return c.json(out.body, out.status as 200);
});

route('post', '/orgs/:orgId/stock/movements', 'inventory:write', async (c) => {
  const { data, raw } = await readJson(c, movementInput);
  const out = unwrap(await inventory(c).addMovement(caller(c), await idemFrom(c, raw), data));
  return c.json(out.body, out.status as 201);
});

route('post', '/orgs/:orgId/stock/transfers', 'inventory:write', async (c) => {
  const { data, raw } = await readJson(c, transferInput);
  const out = unwrap(await inventory(c).transfer(caller(c), await idemFrom(c, raw), data));
  return c.json(out.body, out.status as 201);
});

route('post', '/orgs/:orgId/stock/counts', 'inventory:write', async (c) => {
  const { data, raw } = await readJson(c, countInput);
  const out = unwrap(await inventory(c).count(caller(c), await idemFrom(c, raw), data));
  return c.json(out.body, out.status as 201);
});


// -------------------------------------------------------------------- orders
route('get', '/orgs/:orgId/orders', 'inventory:read', async (c) => c.json(await inventory(c).listOrders(parse(orderListQuery, c.req.query()))));

route('post', '/orgs/:orgId/orders', 'inventory:write', async (c) => {
  const { data, raw } = await readJson(c, orderInput);
  const out = unwrap(await inventory(c).createOrder(caller(c), await idemFrom(c, raw), data));
  etag(c, out.body.order.version);
  return c.json(out.body, out.status as 201);
});

route('get', '/orgs/:orgId/orders/:id', 'inventory:read', async (c) => {
  const r = unwrap(await inventory(c).getOrder(c.req.param('id') ?? ''));
  etag(c, r.order.version);
  return c.json(r);
});

route('post', '/orgs/:orgId/orders/:id/paid', 'inventory:write', async (c) => {
  const version = ifMatch(c);
  const { data } = await readJson(c, paidInput);
  const out = unwrap(await inventory(c).setOrderPaid(caller(c), c.req.param('id') ?? '', version, data.paid));
  etag(c, out.body.order.version);
  return c.json(out.body, out.status as 200);
});

route('post', '/orgs/:orgId/orders/:id/ship', 'inventory:write', async (c) => {
  const out = unwrap(await inventory(c).shipOrder(caller(c), c.req.param('id') ?? '', ifMatch(c)));
  etag(c, out.body.order.version);
  return c.json(out.body, out.status as 200);
});

route('post', '/orgs/:orgId/orders/:id/cancel', 'inventory:write', async (c) => {
  const out = unwrap(await inventory(c).cancelOrder(caller(c), c.req.param('id') ?? '', ifMatch(c)));
  etag(c, out.body.order.version);
  return c.json(out.body, out.status as 200);
});

route('get', '/orgs/:orgId/stock/movements', 'inventory:read', async (c) => c.json(await inventory(c).listMovements(parse(movementListQuery, c.req.query()))));

route('get', '/orgs/:orgId/audit', 'org:manage', async (c) => c.json(await inventory(c).listAudit(parse(pageQuery, c.req.query()))));


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
  return c.json({ ...counts, signin: signinClosed(c.env) ? 'owner-only' : 'open' });
});

route('get', '/admin/orgs', 'super', async (c) => {
  const q = parse(pageQuery, c.req.query());
  const cur = decodeCursor<{ c: string; i: string }>(q.cursor);
  const { results } = await c.env.DB.prepare(
    `SELECT o.id, o.name, o.slug, o.created_at AS createdAt, o.deleted_at AS deletedAt, o.suspended_at AS suspendedAt,
            (SELECT COUNT(*) FROM memberships m WHERE m.org_id = o.id) AS members
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

app.route('/api/v1', api);
export default app;
