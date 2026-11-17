import { z, type ZodType } from 'zod';
import {
  apiKeyInput, countInput, importRequest, inviteInput, locationInput, memberPatch, movementInput, movementListQuery, orderInput, orderListQuery,
  orgInput, pageQuery, paidInput, productInput, productListQuery, productPatch, transferInput, webhookInput,
} from '@shoplist/shared';

export interface RouteInfo { method: string; path: string; access: string }

interface Doc {
  tag: string;
  summary: string;
  body?: ZodType;
  query?: ZodType;
  ifMatch?: boolean;
  idempotent?: boolean;
  /** Who may call it, in words, when the access level alone is not enough. */
  note?: string;
}

/** One entry per route. A test fails when a route is added without documentation. */
export const DOCS: Record<string, Doc> = {
  'GET /openapi.json': { tag: 'System', summary: 'This API description (OpenAPI 3.1)' },
  'GET /health': { tag: 'System', summary: 'Health check and sign-in mode' },
  'GET /auth/oauth/github': { tag: 'Sign-in', summary: "Start the owner's GitHub sign-in (redirects to GitHub)" },
  'GET /auth/oauth/github/callback': { tag: 'Sign-in', summary: 'Finish GitHub sign-in; only the owner account is accepted' },
  'POST /auth/clerk/session': { tag: 'Sign-in', summary: 'Exchange a Clerk session token for a ShopList session (customers)' },
  'POST /auth/dev/login': { tag: 'Sign-in', summary: 'Development only. Returns 404 in production', note: 'Disabled unless the deployment sets DEV_AUTH.' },
  'POST /auth/logout': { tag: 'Account', summary: 'End the current session' },
  'GET /me/notifications': { tag: 'Account', summary: 'My notifications, newest first', query: pageQuery },
  'GET /me/notifications/unread-count': { tag: 'Account', summary: 'How many notifications I have not read' },
  'POST /me/notifications/read': { tag: 'Account', summary: 'Mark some or all notifications read' },
  'GET /me/notification-preferences': { tag: 'Account', summary: 'Which kinds of notification I get in a business (?org=)' },
  'PATCH /me/notification-preferences': { tag: 'Account', summary: 'Switch one kind of notification on or off' },
  'GET /auth/sessions': { tag: 'Account', summary: 'List your active sessions (devices signed in)' },
  'POST /auth/sessions/revoke-others': { tag: 'Account', summary: 'Sign out everywhere except this session' },
  'DELETE /auth/sessions/:id': { tag: 'Account', summary: 'Sign out one session' },
  'GET /auth/passkeys': { tag: 'Account', summary: 'List your registered passkeys' },
  'DELETE /auth/passkeys/:id': { tag: 'Account', summary: 'Remove one of your passkeys' },
  'POST /auth/passkeys/register/options': { tag: 'Account', summary: 'Start registering a passkey (WebAuthn creation options)' },
  'POST /auth/passkeys/register': { tag: 'Account', summary: 'Finish registering a passkey' },
  'POST /auth/passkeys/login/options': { tag: 'Sign-in', summary: 'Start a passkey sign-in (WebAuthn request options)' },
  'POST /auth/passkeys/login': { tag: 'Sign-in', summary: 'Finish a passkey sign-in and start a session' },
  'GET /me': { tag: 'Account', summary: 'The signed-in user and their organizations' },
  'POST /orgs': { tag: 'Organizations', summary: 'Create an organization (the caller becomes its admin)', body: orgInput },
  'GET /orgs/:orgId': { tag: 'Organizations', summary: 'Organization details' },
  'PATCH /orgs/:orgId': { tag: 'Organizations', summary: 'Rename the organization', body: orgInput },
  'DELETE /orgs/:orgId': { tag: 'Organizations', summary: 'Delete the organization (admin only)' },
  'GET /orgs/:orgId/members': { tag: 'Members', summary: 'List members' },
  'PATCH /orgs/:orgId/members/:userId': { tag: 'Members', summary: "Change a member's role", body: memberPatch },
  'DELETE /orgs/:orgId/members/:userId': { tag: 'Members', summary: 'Remove a member. The last admin cannot be removed' },
  'GET /orgs/:orgId/settings': { tag: 'Organizations', summary: "The business's settings (currency, tax, timezone, numbering)" },
  'PATCH /orgs/:orgId/settings': { tag: 'Organizations', summary: 'Change business settings (admin only)' },
  'POST /orgs/:orgId/invitations': { tag: 'Members', summary: 'Create a one-time invitation link', body: inviteInput },
  'GET /orgs/:orgId/invitations': { tag: 'Members', summary: 'List pending invitations' },
  'POST /orgs/:orgId/invitations/:invId/resend': { tag: 'Members', summary: 'Replace a pending invitation with a fresh link' },
  'DELETE /orgs/:orgId/invitations/:invId': { tag: 'Members', summary: 'Revoke a pending invitation' },
  'POST /orgs/:orgId/members/:userId/deactivate': { tag: 'Members', summary: 'Block a member from this organization, keeping their history' },
  'POST /orgs/:orgId/members/:userId/reactivate': { tag: 'Members', summary: 'Restore a deactivated member' },
  'POST /orgs/:orgId/admin-handover': { tag: 'Members', summary: 'Make another member the admin; the caller becomes a manager' },
  'POST /invitations/:token/accept': { tag: 'Members', summary: 'Accept an invitation (the signed-in email must match)' },
  'GET /orgs/:orgId/api-keys': { tag: 'API keys', summary: 'List API keys (never their secrets)' },
  'POST /orgs/:orgId/api-keys': { tag: 'API keys', summary: 'Create an API key. The key is returned once', body: apiKeyInput },
  'DELETE /orgs/:orgId/api-keys/:id': { tag: 'API keys', summary: 'Revoke an API key immediately' },
  'GET /orgs/:orgId/webhooks': { tag: 'Webhooks', summary: 'List webhooks with their last delivery status' },
  'POST /orgs/:orgId/webhooks': { tag: 'Webhooks', summary: 'Create a webhook. The signing secret is returned once', body: webhookInput },
  'DELETE /orgs/:orgId/webhooks/:id': { tag: 'Webhooks', summary: 'Delete a webhook' },
  'POST /orgs/:orgId/webhooks/:id/test': { tag: 'Webhooks', summary: 'Queue a signed test event (202)' },
  'GET /orgs/:orgId/webhooks/:id/deliveries': { tag: 'Webhooks', summary: 'The last 50 final delivery outcomes' },
  'GET /orgs/:orgId/dashboard': { tag: 'Dashboard', summary: 'Counters, order counts, products needing attention, recent movements' },
  'GET /orgs/:orgId/products': { tag: 'Products', summary: 'List products with search, filters and cursor paging', query: productListQuery },
  'POST /orgs/:orgId/products': { tag: 'Products', summary: 'Create a product, optionally with starting stock', body: productInput, idempotent: true },
  'POST /orgs/:orgId/products/import': { tag: 'Products', summary: 'Import up to 100 rows. Each row succeeds or fails on its own', body: importRequest, idempotent: true },
  'GET /orgs/:orgId/products/lookup': { tag: 'Products', summary: 'Find one product by exact barcode or SKU (?code=)' },
  'GET /orgs/:orgId/products/:id': { tag: 'Products', summary: 'A product with its stock per location. Returns an ETag' },
  'PATCH /orgs/:orgId/products/:id': { tag: 'Products', summary: 'Change fields; omitted fields are left alone', body: productPatch, ifMatch: true },
  'DELETE /orgs/:orgId/products/:id': { tag: 'Products', summary: 'Soft-delete (undo with restore). Refused while on open orders', ifMatch: true },
  'POST /orgs/:orgId/products/:id/restore': { tag: 'Products', summary: 'Undo a delete' },
  'GET /orgs/:orgId/locations': { tag: 'Locations', summary: 'List locations' },
  'POST /orgs/:orgId/locations': { tag: 'Locations', summary: 'Add a location', body: locationInput },
  'DELETE /orgs/:orgId/locations/:id': { tag: 'Locations', summary: 'Archive a location (not the default, and only when empty)' },
  'POST /orgs/:orgId/stock/movements': { tag: 'Stock', summary: 'Change stock by a delta. Never goes below zero or below reserved stock', body: movementInput, idempotent: true },
  'POST /orgs/:orgId/stock/transfers': { tag: 'Stock', summary: 'Move units between locations atomically', body: transferInput, idempotent: true },
  'POST /orgs/:orgId/stock/counts': { tag: 'Stock', summary: 'Record a stock count; the server writes the difference', body: countInput, idempotent: true },
  'GET /orgs/:orgId/stock/movements': { tag: 'Stock', summary: 'The stock ledger', query: movementListQuery },
  'GET /orgs/:orgId/orders': { tag: 'Orders', summary: 'List orders by state, number or customer', query: orderListQuery },
  'POST /orgs/:orgId/orders': { tag: 'Orders', summary: 'Create an order. Available stock is reserved at once; the rest waits', body: orderInput, idempotent: true },
  'GET /orgs/:orgId/orders/:id': { tag: 'Orders', summary: 'An order with its lines. Returns an ETag' },
  'POST /orgs/:orgId/orders/:id/paid': { tag: 'Orders', summary: 'Mark an order paid or unpaid', body: paidInput, ifMatch: true },
  'POST /orgs/:orgId/orders/:id/ship': { tag: 'Orders', summary: 'Ship a ready order: reservations become sales in the ledger', ifMatch: true },
  'POST /orgs/:orgId/orders/:id/cancel': { tag: 'Orders', summary: 'Cancel an order and release its reserved stock', ifMatch: true },
  'GET /orgs/:orgId/audit': { tag: 'Activity', summary: 'The organization activity log', query: pageQuery },
  'GET /admin/overview': { tag: 'Platform admin', summary: 'Platform counts and sign-in mode' },
  'GET /admin/orgs': { tag: 'Platform admin', summary: 'All organizations with status', query: pageQuery },
  'POST /admin/orgs': { tag: 'Platform admin', summary: 'Onboard a business: create it with no members and invite its admin' },
  'POST /admin/orgs/:id/resend-invitation': { tag: 'Platform admin', summary: "Send a fresh link to a business's pending admin" },
  'GET /admin/orgs/:id': { tag: 'Platform admin', summary: "A business's people and numbers, never its data" },
  'POST /admin/orgs/:id/transfer-admin': { tag: 'Platform admin', summary: 'Make an existing member the admin (recovery)' },
  'GET /admin/users/:id': { tag: 'Platform admin', summary: 'A user: sign-in methods, businesses, sessions' },
  'POST /admin/users/:id/sign-out': { tag: 'Platform admin', summary: 'End all of a user\'s sessions' },
  'GET /admin/users': { tag: 'Platform admin', summary: 'All accounts with status', query: pageQuery },
  'POST /admin/users/:id/disable': { tag: 'Platform admin', summary: 'Disable an account and sign it out' },
  'POST /admin/users/:id/enable': { tag: 'Platform admin', summary: 'Re-enable an account' },
  'POST /admin/orgs/:id/suspend': { tag: 'Platform admin', summary: 'Suspend an organization' },
  'POST /admin/orgs/:id/restore': { tag: 'Platform admin', summary: 'Restore a suspended organization' },
  'GET /admin/audit': { tag: 'Platform admin', summary: 'The platform activity log', query: pageQuery },
};

const ACCESS_TEXT: Record<string, string> = {
  public: 'No sign-in needed',
  user: 'Signed-in session (not API keys)',
  super: 'Super admin session only',
  'inventory:read': 'Viewer or above, or an API key with inventory:read',
  'products:write': 'Manager or admin, or an API key with inventory:write',
  'stock:write': 'Manager, stock keeper or admin, or an API key with inventory:write',
  'orders:write': 'Manager, sales or admin, or an API key with inventory:write',
  'cost:read': 'Manager or admin (cost prices)',
  'team:manage': 'Admin session (not API keys)',
  'settings:manage': 'Admin session (not API keys)',
  'audit:read': 'Admin session (not API keys)',
  'org:delete': 'Admin session only',
};

function schemaOf(s: ZodType): Record<string, unknown> {
  try { return z.toJSONSchema(s, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>; } catch { return { type: 'object' }; }
}

export function buildOpenApi(routes: RouteInfo[], origin: string) {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const r of routes) {
    const doc = DOCS[`${r.method} ${r.path}`];
    const oaPath = r.path.replace(/:([A-Za-z]+)/g, '{$1}');
    const params = [...r.path.matchAll(/:([A-Za-z]+)/g)].map((m) => ({ name: m[1], in: 'path', required: true, schema: { type: 'string' } }));
    const op: Record<string, unknown> = {
      tags: [doc?.tag ?? 'Other'],
      summary: doc?.summary ?? `${r.method} ${r.path}`,
      description: [ACCESS_TEXT[r.access] ?? r.access, doc?.note].filter(Boolean).join('. ') + '.',
      'x-access': r.access,
      parameters: [
        ...params,
        ...(doc?.ifMatch ? [{ name: 'If-Match', in: 'header', required: true, description: 'The version from the ETag header, e.g. "3". A stale version returns 412 with the current record.', schema: { type: 'string' } }] : []),
        ...(doc?.idempotent ? [{ name: 'Idempotency-Key', in: 'header', required: true, description: 'Any unique string (a UUID is ideal). Retrying with the same key repeats nothing and returns the original response.', schema: { type: 'string', maxLength: 255 } }] : []),
      ],
      responses: {
        '200': { description: 'Success' },
        '400': { description: 'Validation failed (application/problem+json with field errors)' },
        '401': { description: 'Not signed in or invalid API key' },
        '403': { description: 'Not allowed' },
        '404': { description: 'Not found, or an organization you do not belong to' },
        '409': { description: 'Conflicts with current data (duplicate SKU, not enough stock, ...)' },
        '429': { description: 'Rate limited; see Retry-After' },
      },
    };
    if (doc?.body) op.requestBody = { required: true, content: { 'application/json': { schema: schemaOf(doc.body) } } };
    if (doc?.query) {
      const js = schemaOf(doc.query) as { properties?: Record<string, unknown>; required?: string[] };
      (op.parameters as unknown[]).push(...Object.entries(js.properties ?? {}).map(([name, schema]) => ({ name, in: 'query', required: !!js.required?.includes(name), schema })));
    }
    if (r.access === 'public') op.security = [];
    else if (r.access.includes(':') && !['team:manage', 'settings:manage', 'audit:read', 'org:delete'].includes(r.access)) op.security = [{ session: [] }, { apiKey: [] }];
    else op.security = [{ session: [] }];
    (paths[oaPath] ??= {})[r.method.toLowerCase()] = op;
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'ShopList API',
      version: '1.0.0',
      description: 'Multi-tenant inventory and order management. Errors use RFC 9457 problem+json. Lists use opaque cursors (`nextCursor`). All writes that create or move things need an Idempotency-Key; edits need If-Match.',
    },
    servers: [{ url: `${origin}/api/v1` }],
    components: {
      securitySchemes: {
        session: { type: 'apiKey', in: 'cookie', name: '__Host-sl_session', description: 'Browser session. Writes also need a same-origin Origin header.' },
        apiKey: { type: 'http', scheme: 'bearer', description: 'An organization API key (sl_live_...). Inventory routes only.' },
      },
    },
    paths,
  };
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** A static, script-free reference page generated from the same document. */
export function renderDocsPage(spec: ReturnType<typeof buildOpenApi>, nonce: string): string {
  const groups = new Map<string, { method: string; path: string; op: Record<string, any> }[]>();
  for (const [path, methods] of Object.entries(spec.paths)) {
    for (const [method, op] of Object.entries(methods) as [string, Record<string, any>][]) {
      const tag = op.tags[0] as string;
      (groups.get(tag) ?? groups.set(tag, []).get(tag)!).push({ method: method.toUpperCase(), path, op });
    }
  }
  const body = [...groups.entries()].map(([tag, ops]) => `
    <section id="${esc(tag.toLowerCase().replace(/\W+/g, '-'))}"><h2>${esc(tag)}</h2>
    ${ops.map(({ method, path, op }) => `
      <article><h3><span class="m ${method}">${method}</span> <code>${esc(path)}</code></h3>
        <p>${esc(op.summary)}</p><p class="who">${esc(op.description)}</p>
        ${op.parameters.filter((p: any) => p.in !== 'path').length ? `<ul>${op.parameters.filter((p: any) => p.in !== 'path').map((p: any) => `<li><code>${esc(p.name)}</code> <em>${p.in}${p.required ? ', required' : ''}</em>${p.description ? ' — ' + esc(p.description) : ''}</li>`).join('')}</ul>` : ''}
        ${op.requestBody ? `<details><summary>Request body (JSON Schema)</summary><pre>${esc(JSON.stringify(op.requestBody.content['application/json'].schema, null, 2))}</pre></details>` : ''}
      </article>`).join('')}</section>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ShopList API</title>
<style nonce="${nonce}">
body{font:15px/1.5 system-ui,sans-serif;margin:0;color:#1d2433;background:#f5f7fa}header{background:#2878b5;color:#fff;padding:24px}main{max-width:900px;margin:0 auto;padding:16px}
h1{margin:0}h2{margin:32px 0 8px;border-bottom:1px solid #dee2e6;padding-bottom:4px}article{background:#fff;border:1px solid #dee2e6;border-radius:8px;padding:12px 16px;margin:10px 0}
h3{margin:0 0 4px;font-size:15px}code{background:#eef2f5;padding:1px 5px;border-radius:4px}.m{display:inline-block;min-width:58px;text-align:center;padding:1px 6px;border-radius:4px;color:#fff;font-size:12px;font-weight:700}
.GET{background:#1f5f8f}.POST{background:#1e8449}.PATCH{background:#9a4b00}.DELETE{background:#b83227}.who{color:#5a6570;font-size:13px;margin:2px 0}pre{overflow:auto;background:#f5f7fa;padding:10px;border-radius:6px;font-size:12px}
nav a{color:#fff;margin-right:12px}a{color:#1f5f8f}</style></head><body>
<header><h1>ShopList API</h1><p>${esc(spec.info.description)}</p><nav>${[...groups.keys()].map((t) => `<a href="#${esc(t.toLowerCase().replace(/\W+/g, '-'))}">${esc(t)}</a>`).join('')}<a href="/api/v1/openapi.json">openapi.json</a></nav></header>
<main><p>Authenticate with a browser session, or send <code>Authorization: Bearer sl_live_…</code> using an API key (inventory routes only). Base URL: <code>${esc(spec.servers[0].url)}</code></p>${body}</main></body></html>`;
}
