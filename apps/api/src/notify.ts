import type { Role } from '@shoplist/shared';
import type { Bindings } from './env';
import { newId, nowIso } from './util';

export const NOTIFICATION_KINDS = ['stock.low', 'stock.out', 'order.created', 'approval.requested', 'approval.decided'] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export const KIND_LABELS: Record<NotificationKind, string> = {
  'stock.low': 'A product is running low',
  'stock.out': 'A product is out of stock',
  'order.created': 'A new order arrives',
  'approval.requested': 'Something needs my approval',
  'approval.decided': 'My request was decided',
};

/** Which roles hear about which event by default. */
const AUDIENCE: Partial<Record<NotificationKind, Role[]>> = {
  'stock.low': ['admin', 'manager', 'stock'],
  'stock.out': ['admin', 'manager', 'stock'],
  'order.created': ['admin', 'manager', 'sales'],
  'approval.requested': ['admin', 'manager'],
};

export interface Note { kind: NotificationKind; title: string; link?: string }

/** Active members of an organization with one of the roles, minus anyone who switched this kind off. */
export async function recipients(env: Pick<Bindings, 'DB'>, orgId: string, roles: Role[], kind: NotificationKind): Promise<string[]> {
  if (!roles.length) return [];
  const marks = roles.map(() => '?').join(',');
  const { results } = await env.DB.prepare(
    `SELECT m.user_id AS id FROM memberships m
      WHERE m.org_id = ? AND m.deactivated_at IS NULL AND m.role IN (${marks})
        AND NOT EXISTS (SELECT 1 FROM notification_prefs p WHERE p.user_id = m.user_id AND p.org_id = m.org_id AND p.kind = ? AND p.in_app = 0)`,
  ).bind(orgId, ...roles, kind).all<{ id: string }>();
  return results.map((r) => r.id);
}

export async function notify(env: Pick<Bindings, 'DB'>, orgId: string, userIds: string[], note: Note): Promise<void> {
  const ids = [...new Set(userIds)];
  if (!ids.length) return;
  const now = nowIso();
  for (let i = 0; i < ids.length; i += 40) {
    await env.DB.batch(ids.slice(i, i + 40).map((u) => env.DB.prepare(`INSERT INTO notifications(id, user_id, org_id, kind, title, link, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).bind(newId('ntf'), u, orgId, note.kind, note.title, note.link ?? null, now)));
  }
}

/** Turns a recorded inventory event into notifications for the people it concerns. */
export async function notifyForEvent(env: Pick<Bindings, 'DB'>, orgId: string, type: string, data: Record<string, unknown>): Promise<void> {
  const kind = type as NotificationKind;
  if (kind === 'approval.decided') {
    const who = String(data.requestedBy ?? '');
    const row = await env.DB.prepare(`SELECT 1 AS x FROM memberships m WHERE m.org_id = ? AND m.user_id = ? AND m.deactivated_at IS NULL AND NOT EXISTS (SELECT 1 FROM notification_prefs p WHERE p.user_id = m.user_id AND p.org_id = m.org_id AND p.kind = ? AND p.in_app = 0)`).bind(orgId, who, kind).first();
    if (row) await notify(env, orgId, [who], { kind, title: `${data.approved ? 'Approved' : 'Not approved'}: ${data.summary}${data.note ? ` (${data.note})` : ''}`, link: `/o/${orgId}/approvals` });
    return;
  }
  const audience = AUDIENCE[kind];
  if (!audience) return;
  const base = `/o/${orgId}`;
  const note: Note | null =
    kind === 'stock.low' ? { kind, title: `Low stock: ${data.name} (${data.onHand} left)`, link: `${base}/products?q=${encodeURIComponent(String(data.sku))}` }
    : kind === 'stock.out' ? { kind, title: `Out of stock: ${data.name}`, link: `${base}/products?q=${encodeURIComponent(String(data.sku))}` }
    : kind === 'approval.requested' ? { kind, title: `Needs approval: ${data.summary}`, link: `${base}/approvals` }
    : kind === 'order.created' ? { kind, title: `New order ${data.number} from ${data.customerName}`, link: `${base}/orders` }
    : null;
  if (!note) return;
  await notify(env, orgId, await recipients(env, orgId, audience, kind), note);
}
