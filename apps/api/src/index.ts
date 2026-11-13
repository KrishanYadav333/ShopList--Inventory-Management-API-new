import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { z, type ZodType } from 'zod';
import {
  PERMISSIONS,
  ROLE_RANK,
  countInput,
  inviteInput,
  locationInput,
  memberPatch,
  movementInput,
  movementListQuery,
  orgInput,
  pageQuery,
  productInput,
  productListQuery,
  productPatch,
  transferInput,
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
  pkcePair,
  signPayload,
  upsertUser,
  userFromSession,
  verifyPayload,
  type AuthUser,
} from './auth';
import type { Bindings } from './env';
import { AppError, problemResponse, unwrap } from './errors';
import type { Caller, Idem } from './inventory-do';
import { newId, nowIso, randomToken, sha256Hex } from './util';

export { InventoryDO } from './inventory-do';

type Vars = { requestId: string; user: AuthUser; org: { id: string; role: Role } };
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

// ---------------------------------------------------------- access control
const requireUser: MiddlewareHandler<{ Bindings: Bindings; Variables: Vars }> = async (c, next) => {
  const user = await userFromSession(c.env, getCookie(c, SESSION_COOKIE, 'host'));
  if (!user) throw new AppError(401, 'unauthenticated', 'Sign in to continue.');
  c.set('user', user);
  return next();
};

/** The org id in the URL is checked against the caller's memberships before any Durable Object is touched. */
const orgAccess = (permission: Permission): MiddlewareHandler<{ Bindings: Bindings; Variables: Vars }> => async (c, next) => {
  const orgId = c.req.param('orgId') ?? '';
  const row = await c.env.DB.prepare(
    `SELECT m.role FROM memberships m JOIN organizations o ON o.id = m.org_id WHERE m.org_id = ? AND m.user_id = ? AND o.deleted_at IS NULL`,
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
type Access = Permission | 'user' | 'public';
export const ROUTES: { method: string; path: string; access: Access }[] = [];
const api = new Hono<{ Bindings: Bindings; Variables: Vars }>();
api.use('*', rateLimit, originCheck);

type Handler = (c: Ctx) => Response | Promise<Response>;
function route(method: 'get' | 'post' | 'patch' | 'delete', path: string, access: Access, handler: Handler): void {
  ROUTES.push({ method: method.toUpperCase(), path, access });
  const guards: MiddlewareHandler<{ Bindings: Bindings; Variables: Vars }>[] = access === 'public' ? [] : access === 'user' ? [requireUser] : [requireUser, orgAccess(access)];
  const handlers = [...guards, handler] as MiddlewareHandler[];
  (api[method] as (path: string, ...h: MiddlewareHandler[]) => unknown).call(api, path, ...handlers);
}

// -------------------------------------------------------------------- public
route('get', '/health', 'public', (c) => c.json({ ok: true }));

// ---------------------------------------------------------------------- auth
route('get', '/auth/oauth/github', 'public', async (c) => {
  const state = randomToken(24);
  const { verifier, challenge } = await pkcePair();
  const url = githubAuthorizeUrl(c.env, state, challenge);
  setCookie(c, OAUTH_COOKIE, await signPayload(c.env, { state, verifier, exp: Date.now() + 10 * 60_000 }), {
    prefix: 'host', httpOnly: true, secure: true, sameSite: 'Lax', path: '/', maxAge: 600,
  });
  return c.redirect(url, 302);
});

route('get', '/auth/oauth/github/callback', 'public', async (c) => {
  const saved = await verifyPayload<{ state: string; verifier: string; exp: number }>(c.env, getCookie(c, OAUTH_COOKIE, 'host'));
  deleteCookie(c, OAUTH_COOKIE, { prefix: 'host', path: '/', secure: true });
  const code = c.req.query('code');
  if (!saved || saved.exp < Date.now() || !code || saved.state !== c.req.query('state')) {
    throw new AppError(400, 'oauth_failed', 'The sign-in attempt expired or was not valid. Please try again.');
  }
  const profile = await githubProfile(c.env, code, saved.verifier);
  const user = await upsertUser(c.env, profile, { provider: 'github', providerUserId: profile.id });
  const token = await createSession(c.env, user.id, c.req.raw);
  setCookie(c, SESSION_COOKIE, token, { prefix: 'host', httpOnly: true, secure: true, sameSite: 'Lax', path: '/', maxAge: 30 * 86400 });
  return c.redirect(c.env.APP_ORIGIN, 302);
});

/** Local development and tests only. Refuses to run unless DEV_AUTH is exactly "true". */
route('post', '/auth/dev/login', 'public', async (c) => {
  if (c.env.DEV_AUTH !== 'true') throw new AppError(404, 'not_found', 'There is nothing at this address.');
  const { data } = await readJson(c, z.object({ email: z.string().email().max(254), name: z.string().max(100).optional() }).strict());
  const user = await upsertUser(c.env, { email: data.email, name: data.name ?? data.email.split('@')[0] });
  const token = await createSession(c.env, user.id, c.req.raw);
  setCookie(c, SESSION_COOKIE, token, { prefix: 'host', httpOnly: true, secure: true, sameSite: 'Lax', path: '/', maxAge: 30 * 86400 });
  return c.json({ user });
});

route('post', '/auth/logout', 'user', async (c) => {
  await destroySession(c.env, getCookie(c, SESSION_COOKIE, 'host'));
  deleteCookie(c, SESSION_COOKIE, { prefix: 'host', path: '/', secure: true });
  return c.json({ ok: true });
});

route('get', '/me', 'user', async (c) => {
  const user = c.get('user');
  const { results } = await c.env.DB.prepare(
    `SELECT o.id, o.name, o.slug, o.currency, m.role FROM memberships m JOIN organizations o ON o.id = m.org_id WHERE m.user_id = ? AND o.deleted_at IS NULL ORDER BY o.name`,
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

// ----------------------------------------------------------------- inventory
route('get', '/orgs/:orgId/dashboard', 'inventory:read', async (c) => c.json(await inventory(c).dashboard()));

route('get', '/orgs/:orgId/products', 'inventory:read', async (c) => c.json(await inventory(c).listProducts(parse(productListQuery, c.req.query()))));

route('post', '/orgs/:orgId/products', 'inventory:write', async (c) => {
  const { data, raw } = await readJson(c, productInput);
  const out = unwrap(await inventory(c).createProduct(caller(c), await idemFrom(c, raw), data));
  etag(c, out.body.product.version);
  return c.json(out.body, out.status as 201);
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

route('get', '/orgs/:orgId/stock/movements', 'inventory:read', async (c) => c.json(await inventory(c).listMovements(parse(movementListQuery, c.req.query()))));

route('get', '/orgs/:orgId/audit', 'org:manage', async (c) => c.json(await inventory(c).listAudit(parse(pageQuery, c.req.query()))));

app.route('/api/v1', api);
export default app;
