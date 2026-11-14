import type { Bindings } from './env';
import { newId, nowIso } from './util';

export interface WebhookEvent {
  id: string;
  type: string;
  createdAt: string;
  orgId: string;
  data: Record<string, unknown>;
}
export interface DeliveryJob {
  hookId: string;
  event: WebhookEvent;
}

export const MAX_ATTEMPTS = 8;
const backoff = (attempts: number) => Math.min(3600, 15 * 2 ** (attempts - 1)); // 15s, 30s, 1m ... capped at 1h

/**
 * Webhook targets must be public HTTPS addresses. Workers cannot reach private networks anyway; this
 * also refuses credentials in the URL, IP literals, odd ports and internal-looking names up front.
 */
export function checkWebhookUrl(raw: string): string | null {
  let u: URL;
  try { u = new URL(raw); } catch { return 'That is not a valid URL.'; }
  if (u.protocol !== 'https:') return 'Webhook URLs must start with https://';
  if (u.username || u.password) return 'Remove the username and password from the URL.';
  if (u.port && u.port !== '443') return 'Only the standard HTTPS port (443) is allowed.';
  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || /\.(local|localhost|internal|lan|home|corp|test|invalid|example)$/.test(host) || !host.includes('.')) return 'That address is not publicly reachable.';
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith('[') || host.includes(':')) return 'Use a hostname, not an IP address.';
  return null;
}

export async function signBody(secret: string, timestamp: number, body: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}.${body}`));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ------------------------------------------------------------------- producing
const hookCache = new Map<string, { has: boolean; until: number }>();
export const forgetHooks = (orgId: string) => hookCache.delete(orgId);

async function orgHasHooks(env: Bindings, orgId: string): Promise<boolean> {
  const hit = hookCache.get(orgId);
  if (hit && hit.until > Date.now()) return hit.has;
  const row = await env.DB.prepare(`SELECT 1 AS x FROM webhooks WHERE org_id = ? AND active = 1 LIMIT 1`).bind(orgId).first();
  hookCache.set(orgId, { has: !!row, until: Date.now() + 30_000 });
  return !!row;
}

/** Moves pending events from the organization's outbox onto the delivery queue. Returns how many jobs were queued. */
export async function flushEvents(env: Bindings, orgId: string): Promise<number> {
  if (!env.WEBHOOKS || !(await orgHasHooks(env, orgId))) return 0;
  const stub = env.INVENTORY.get(env.INVENTORY.idFromName(orgId));
  const events = await stub.takeOutbox(50);
  if (!events.length) return 0;
  const { results } = await env.DB.prepare(`SELECT id, events FROM webhooks WHERE org_id = ? AND active = 1`).bind(orgId).all<{ id: string; events: string }>();
  const jobs: { body: DeliveryJob }[] = [];
  for (const e of events) {
    const event: WebhookEvent = { id: e.id, type: e.type, createdAt: e.createdAt, orgId, data: JSON.parse(e.data) as Record<string, unknown> };
    for (const h of results) {
      const wanted = JSON.parse(h.events) as string[];
      if (wanted.includes('*') || wanted.includes(e.type)) jobs.push({ body: { hookId: h.id, event } });
    }
  }
  for (let i = 0; i < jobs.length; i += 100) await env.WEBHOOKS.sendBatch(jobs.slice(i, i + 100));
  return jobs.length;
}

export async function sendTestEvent(env: Bindings, orgId: string, hookId: string): Promise<void> {
  const event: WebhookEvent = { id: newId('evt'), type: 'ping', createdAt: nowIso(), orgId, data: { message: 'This is a test event from ShopList.' } };
  await env.WEBHOOKS.send({ hookId, event });
}

// ------------------------------------------------------------------- consuming
async function record(env: Bindings, hookId: string, event: WebhookEvent, status: 'delivered' | 'failed', httpStatus: number | null, attempts: number) {
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO webhook_deliveries(id, webhook_id, event_id, event_type, status, http_status, attempts, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).bind(newId('dlv'), hookId, event.id, event.type, status, httpStatus, attempts, nowIso()),
    env.DB.prepare(`DELETE FROM webhook_deliveries WHERE webhook_id = ? AND id NOT IN (SELECT id FROM webhook_deliveries WHERE webhook_id = ? ORDER BY created_at DESC, id DESC LIMIT 100)`).bind(hookId, hookId),
  ]);
}

export async function handleQueue(batch: MessageBatch<DeliveryJob>, env: Bindings): Promise<void> {
  for (const msg of batch.messages) {
    const { hookId, event } = msg.body;
    const hook = await env.DB.prepare(`SELECT url, secret, active FROM webhooks WHERE id = ?`).bind(hookId).first<{ url: string; secret: string; active: number }>();
    // Deleted or paused since the event was queued: drop it.
    if (!hook || !hook.active) { msg.ack(); continue; }
    const body = JSON.stringify(event);
    const ts = Math.floor(Date.now() / 1000);
    let status: number | null = null;
    try {
      const res = await fetch(hook.url, {
        method: 'POST',
        redirect: 'manual', // a redirect could point somewhere the owner never approved
        signal: AbortSignal.timeout(5000),
        headers: {
          'content-type': 'application/json',
          'user-agent': 'ShopList-Webhooks/1',
          'shoplist-event': event.type,
          'shoplist-delivery': event.id,
          'shoplist-signature': `t=${ts},v1=${await signBody(hook.secret, ts, body)}`,
        },
        body,
      });
      status = res.status;
    } catch {
      status = null;
    }
    if (status !== null && status >= 200 && status < 300) {
      await record(env, hookId, event, 'delivered', status, msg.attempts);
      msg.ack();
    } else if (msg.attempts >= MAX_ATTEMPTS) {
      await record(env, hookId, event, 'failed', status, msg.attempts);
      msg.ack();
    } else {
      msg.retry({ delaySeconds: backoff(msg.attempts) });
    }
  }
}
