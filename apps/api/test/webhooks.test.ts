import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkWebhookUrl, handleQueue, signBody, type DeliveryJob } from '../src/webhooks';
import { addMember, call, defaultLocation, newOrg, product, stub, uid } from './helpers';

type Org = { cookie: string; base: string; orgId: string };
const URL_OK = 'https://hooks.acme-shop.dev/shoplist';
const create = (org: Org, over: Record<string, unknown> = {}) => call(org.cookie, 'POST', `${org.base}/webhooks`, { url: URL_OK, events: ['*'], ...over });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const waitFor = async <T>(fn: () => T | undefined | false, ms = 10_000): Promise<T> => { const t = Date.now(); while (Date.now() - t < ms) { const v = fn(); if (v) return v as T; await sleep(100); } throw new Error('timed out waiting'); };

// ---- outbound fetch stub: records requests to the webhook host, passes everything else through
let sent: { url: string; headers: Record<string, string>; body: string }[];
let respond: () => Response;
const realFetch = globalThis.fetch;
beforeEach(() => {
  sent = [];
  respond = () => new Response('ok', { status: 200 });
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
    if (url.startsWith('https://hooks.acme-shop.dev')) {
      sent.push({ url, headers: Object.fromEntries(new Headers(init?.headers).entries()), body: String(init?.body ?? '') });
      return respond();
    }
    return realFetch(input as RequestInfo, init);
  });
});
afterEach(() => vi.restoreAllMocks());

describe('managing webhooks', () => {
  it('returns the signing secret once and never lists it', async () => {
    const org = await newOrg();
    const r = await create(org, { events: ['stock.low', 'order.shipped'] });
    expect(r.status).toBe(201);
    expect(r.body.secret).toMatch(/^whsec_[A-Za-z0-9_-]{20,}$/);
    const list = await call(org.cookie, 'GET', `${org.base}/webhooks`);
    expect(JSON.stringify(list.body)).not.toContain(r.body.secret);
    expect(list.body.data[0]).toMatchObject({ id: r.body.id, url: URL_OK, events: ['stock.low', 'order.shipped'], active: true, secretPrefix: r.body.secret.slice(0, 10), lastStatus: null });
  });

  it('refuses unsafe or unusable destination URLs', async () => {
    const org = await newOrg();
    for (const url of ['http://hooks.acme-shop.dev/x', 'https://localhost/x', 'https://127.0.0.1/x', 'https://169.254.169.254/latest/meta-data', 'https://[::1]/x', 'https://user:pass@hooks.acme-shop.dev/x', 'https://hooks.acme-shop.dev:8443/x', 'https://intranet/x', 'https://db.internal/x', 'https://printer.local/x', 'ftp://hooks.acme-shop.dev/x', 'not a url']) {
      const r = await create(org, { url });
      expect(r.status, url).toBe(400);
    }
    expect(checkWebhookUrl(URL_OK)).toBeNull();
    expect((await create(org, { events: [] })).status).toBe(400);
    expect((await create(org, { events: ['order.exploded'] })).status).toBe(400);
    expect((await create(org, { extra: 1 })).status).toBe(400);
  });

  it('caps webhooks at 10 and lets an admin delete them', async () => {
    const org = await newOrg();
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) ids.push((await create(org)).body.id);
    expect((await create(org)).status).toBe(409);
    expect((await call(org.cookie, 'DELETE', `${org.base}/webhooks/${ids[0]}`)).status).toBe(200);
    expect((await call(org.cookie, 'DELETE', `${org.base}/webhooks/${ids[0]}`)).status).toBe(404);
    expect((await create(org)).status).toBe(201);
  });

  it('is limited to admins, to sessions, and to its own organization', async () => {
    const a = await newOrg();
    const b = await newOrg();
    const editor = await addMember(a, 'editor');
    const hook = (await create(a)).body;
    expect((await call(editor.cookie, 'GET', `${a.base}/webhooks`)).status).toBe(403);
    expect((await call(editor.cookie, 'POST', `${a.base}/webhooks`, { url: URL_OK, events: ['*'] })).status).toBe(403);
    expect((await call(b.cookie, 'GET', `${a.base}/webhooks`)).status).toBe(404);
    expect((await call(b.cookie, 'DELETE', `${b.base}/webhooks/${hook.id}`)).status).toBe(404); // someone else's id in my org
    expect((await call(b.cookie, 'POST', `${b.base}/webhooks/${hook.id}/test`, {})).status).toBe(404);
    expect((await call(b.cookie, 'GET', `${b.base}/webhooks/${hook.id}/deliveries`)).status).toBe(404);
    expect((await call(a.cookie, 'GET', `${a.base}/webhooks`)).body.data).toHaveLength(1);
  });
});

describe('recording events', () => {
  const events = async (org: Org) => (await stub(org.orgId).takeOutbox(100)).map((e) => ({ type: e.type, data: JSON.parse(e.data) }));

  it('records nothing until a webhook exists', async () => {
    const org = await newOrg();
    await product(org, { initialQuantity: 5 });
    expect(await events(org)).toEqual([]);
  });

  it('records product, stock and order events in order, with low and out transitions', async () => {
    const org = await newOrg();
    const loc = await defaultLocation(org);
    await stub(org.orgId).setEventsEnabled(true); // events on, but no webhook rows, so the Worker does not drain them
    const p = await product(org, { sku: 'EV-1', initialQuantity: 10, reorderPoint: 5 });
    const mv = (delta: number, reason = 'sale') => call(org.cookie, 'POST', `${org.base}/stock/movements`, { productId: p.id, locationId: loc, delta, reason });
    await mv(-3); // 7: still fine
    await mv(-3); // 4: crosses into low
    await mv(-1); // 3: already low, no second low event
    await mv(-3); // 0: crosses into out
    const o = (await call(org.cookie, 'POST', `${org.base}/orders`, { customerName: 'Ev Customer', paid: true, lines: [{ productId: p.id, quantity: 1 }] })).body.order;
    await mv(5, 'receive');
    const o2 = (await call(org.cookie, 'GET', `${org.base}/orders/${o.id}`)).body.order;
    await call(org.cookie, 'POST', `${org.base}/orders/${o.id}/ship`, {}, { 'if-match': `"${o2.version}"` });
    const types = (await events(org)).map((e) => e.type);
    expect(types).toEqual([
      'stock.changed', 'product.created', // creating with initial stock: the stock lands first
      'stock.changed', // 7
      'stock.changed', 'stock.low', // 4: crosses into low
      'stock.changed', // 3: already low, so no second low event
      'stock.changed', 'stock.out', // 0: crosses into out
      'order.created',
      'stock.changed', 'stock.low', // +5 restock: out of stock to in stock but still at the reorder point
      'stock.changed', 'order.shipped', // the sale
    ]);
  });

  it('a rolled-back change records no event', async () => {
    const org = await newOrg();
    const loc = await defaultLocation(org);
    const p = await product(org, { initialQuantity: 2 });
    await stub(org.orgId).setEventsEnabled(true);
    const r = await call(org.cookie, 'POST', `${org.base}/stock/movements`, { productId: p.id, locationId: loc, delta: -5, reason: 'sale' });
    expect(r.status).toBe(409);
    expect(await events(org)).toEqual([]);
  });

  it('turning events off clears the backlog', async () => {
    const org = await newOrg();
    await stub(org.orgId).setEventsEnabled(true);
    await product(org);
    await stub(org.orgId).setEventsEnabled(false);
    expect(await events(org)).toEqual([]);
    await product(org);
    expect(await events(org)).toEqual([]);
  });
});

describe('delivery, end to end', () => {
  it('a stock change reaches only the subscribed webhook, correctly signed, and is recorded', async () => {
    const org = await newOrg();
    const loc = await defaultLocation(org);
    const hook = (await create(org, { events: ['stock.low'] })).body;
    const p = await product(org, { sku: 'E2E-1', name: 'End to end', initialQuantity: 10, reorderPoint: 5 });
    await call(org.cookie, 'POST', `${org.base}/stock/movements`, { productId: p.id, locationId: loc, delta: -2, reason: 'sale' }); // 8, not low
    await call(org.cookie, 'POST', `${org.base}/stock/movements`, { productId: p.id, locationId: loc, delta: -4, reason: 'sale' }); // 4, low

    const req = await waitFor(() => sent[0]);
    expect(req.url).toBe(URL_OK);
    expect(req.headers['shoplist-event']).toBe('stock.low');
    expect(req.headers['shoplist-delivery']).toMatch(/^evt_/);
    const event = JSON.parse(req.body);
    expect(event).toMatchObject({ type: 'stock.low', orgId: org.orgId, data: { sku: 'E2E-1', onHand: 4, reorderPoint: 5 } });
    expect(event.id).toBe(req.headers['shoplist-delivery']);

    // The signature verifies with the secret the customer was given, and uses the timestamp in the header.
    const [t, v1] = req.headers['shoplist-signature'].split(',').map((x) => x.split('=')[1]);
    expect(v1).toBe(await signBody(hook.secret, Number(t), req.body));
    expect(Math.abs(Date.now() / 1000 - Number(t))).toBeLessThan(30);
    expect(await signBody('wrong-secret', Number(t), req.body)).not.toBe(v1);

    await sleep(300);
    expect(sent).toHaveLength(1); // product.created, stock.changed and so on were not subscribed
    const rows = (await call(org.cookie, 'GET', `${org.base}/webhooks/${hook.id}/deliveries`)).body.data;
    expect(rows[0]).toMatchObject({ status: 'delivered', httpStatus: 200, eventType: 'stock.low', attempts: 1 });
    expect((await call(org.cookie, 'GET', `${org.base}/webhooks`)).body.data[0].lastStatus).toBe('delivered');
  });

  it('the test button sends a signed ping', async () => {
    const org = await newOrg();
    const hook = (await create(org)).body;
    expect((await call(org.cookie, 'POST', `${org.base}/webhooks/${hook.id}/test`, {})).status).toBe(202);
    const req = await waitFor(() => sent.find((s) => s.headers['shoplist-event'] === 'ping'));
    expect(JSON.parse(req.body)).toMatchObject({ type: 'ping', orgId: org.orgId });
  });

  it('after the last webhook is deleted nothing more is recorded or sent', async () => {
    const org = await newOrg();
    const hook = (await create(org)).body;
    await product(org, { sku: 'BEFORE-1' });
    await waitFor(() => sent.find((s) => s.body.includes('BEFORE-1')));
    await call(org.cookie, 'DELETE', `${org.base}/webhooks/${hook.id}`);
    const before = sent.length;
    await product(org, { sku: 'AFTER-1' });
    await sleep(800);
    expect(sent).toHaveLength(before);
    expect(await stub(org.orgId).takeOutbox(100)).toEqual([]);
  });
});

describe('delivery policy', () => {
  // Drive the queue consumer directly so retry timing is deterministic.
  const job = (hookId: string): DeliveryJob => ({ hookId, event: { id: 'evt_x', type: 'stock.low', createdAt: new Date().toISOString(), orgId: 'org_x', data: { sku: 'S' } } });
  const msg = (body: DeliveryJob, attempts: number) => ({ body, attempts, ack: vi.fn(), retry: vi.fn() });
  const run = async (m: ReturnType<typeof msg>) => handleQueue({ messages: [m] } as never, env as never);
  const hookRow = async (active = 1) => {
    const org = await newOrg();
    const id = `whk_${uid()}`;
    const me = (await call(org.cookie, 'GET', '/me')).body.user.id;
    await env.DB.prepare(`INSERT INTO webhooks(id, org_id, url, events, secret, active, created_by, created_at) VALUES (?, ?, ?, '["*"]', 'whsec_policy', ?, ?, ?)`).bind(id, org.orgId, URL_OK, active, me, new Date().toISOString()).run();
    return id;
  };
  const delivered = (id: string) => env.DB.prepare(`SELECT status, http_status AS httpStatus, attempts FROM webhook_deliveries WHERE webhook_id = ?`).bind(id).all();

  it('success on any 2xx acknowledges and records once', async () => {
    const id = await hookRow();
    respond = () => new Response('accepted', { status: 202 });
    const m = msg(job(id), 1);
    await run(m);
    expect(m.ack).toHaveBeenCalledOnce();
    expect(m.retry).not.toHaveBeenCalled();
    expect((await delivered(id)).results).toEqual([{ status: 'delivered', httpStatus: 202, attempts: 1 }]);
  });

  it('server errors, timeouts and redirects are retried with growing delay and not recorded yet', async () => {
    const id = await hookRow();
    for (const [attempts, delay] of [[1, 15], [2, 30], [3, 60], [4, 120]] as const) {
      respond = () => new Response('boom', { status: 500 });
      const m = msg(job(id), attempts);
      await run(m);
      expect(m.retry).toHaveBeenCalledWith({ delaySeconds: delay });
      expect(m.ack).not.toHaveBeenCalled();
    }
    respond = () => new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/' } });
    const redirect = msg(job(id), 1);
    await run(redirect);
    expect(redirect.retry).toHaveBeenCalled(); // a redirect is a failure; it is never followed
    expect(sent.at(-1)!.url).toBe(URL_OK);
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(async () => { throw new Error('network down'); });
    const down = msg(job(id), 1);
    await run(down);
    expect(down.retry).toHaveBeenCalled();
    expect((await delivered(id)).results).toEqual([]);
  });

  it('gives up after the maximum attempts, recording the failure and the last status', async () => {
    const id = await hookRow();
    respond = () => new Response('still broken', { status: 503 });
    const m = msg(job(id), 8);
    await run(m);
    expect(m.ack).toHaveBeenCalledOnce();
    expect(m.retry).not.toHaveBeenCalled();
    expect((await delivered(id)).results).toEqual([{ status: 'failed', httpStatus: 503, attempts: 8 }]);
  });

  it('drops jobs for webhooks that were deleted or paused, without sending anything', async () => {
    const paused = await hookRow(0);
    const gone = msg(job('whk_deleted'), 1);
    const off = msg(job(paused), 1);
    await run(gone);
    await run(off);
    expect(gone.ack).toHaveBeenCalled();
    expect(off.ack).toHaveBeenCalled();
    expect(sent).toHaveLength(0);
  });

  it('keeps only the newest 100 delivery records per webhook', async () => {
    const id = await hookRow();
    for (let i = 0; i < 105; i++) await run(msg(job(id), 1));
    const n = (await env.DB.prepare(`SELECT COUNT(*) AS n FROM webhook_deliveries WHERE webhook_id = ?`).bind(id).first<{ n: number }>())!.n;
    expect(n).toBe(100);
  });
});
