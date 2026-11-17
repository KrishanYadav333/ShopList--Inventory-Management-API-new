import type { Role } from '@shoplist/shared';
import type { Bindings } from './env';
import { sendMail, unsubscribeUrl, wantsEmail, type MailEnv } from './email';
import { newId, nowIso } from './util';

export const NOTIFICATION_KINDS = ['stock.low', 'stock.out', 'order.created', 'approval.requested', 'approval.decided', 'count.assigned', 'security.not_me', 'support.granted'] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export const KIND_LABELS: Record<NotificationKind, string> = {
  'stock.low': 'A product is running low',
  'stock.out': 'A product is out of stock',
  'order.created': 'A new order arrives',
  'approval.requested': 'Something needs my approval',
  'approval.decided': 'My request was decided',
  'count.assigned': 'A stock count is assigned to me',
  'security.not_me': 'A team member reports a sign-in that was not theirs',
  'support.granted': 'A business opened a support window for me',
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

export async function notify(env: MailEnv, orgId: string, userIds: string[], note: Note): Promise<void> {
  const ids = [...new Set(userIds)];
  if (!ids.length) return;
  const now = nowIso();
  for (let i = 0; i < ids.length; i += 40) {
    await env.DB.batch(ids.slice(i, i + 40).map((u) => env.DB.prepare(`INSERT INTO notifications(id, user_id, org_id, kind, title, link, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).bind(newId('ntf'), u, orgId, note.kind, note.title, note.link ?? null, now)));
  }
  await emailNote(env, orgId, ids, note);
}

/** The same notice by email, for people who want this kind that way. Failures never reach the caller. */
async function emailNote(env: MailEnv, orgId: string, ids: string[], note: Note): Promise<void> {
  if (!env.BREVO_API_KEY) return;
  try {
    const want = await wantsEmail(env, ids, orgId, note.kind);
    if (!want.size) return;
    const marks = [...want].map(() => '?').join(',');
    const { results: users } = await env.DB.prepare(`SELECT id, email, name FROM users WHERE disabled_at IS NULL AND id IN (${marks})`).bind(...want).all<{ id: string; email: string; name: string }>();
    const biz = orgId === '_platform' ? 'ShopList' : ((await env.DB.prepare(`SELECT name FROM organizations WHERE id = ?`).bind(orgId).first<{ name: string }>())?.name ?? 'ShopList');
    for (const u of users) {
      await sendMail(env, orgId, {
        to: { email: u.email, name: u.name },
        subject: `${biz}: ${note.title}`.slice(0, 150),
        lines: [note.title],
        link: note.link ? { url: `${env.APP_ORIGIN}${note.link}`, label: 'Open in ShopList' } : undefined,
        footer: `You get this because of your role in ${biz}.`,
        unsubscribe: await unsubscribeUrl(env, u.id, orgId, note.kind),
      });
    }
  } catch (e) {
    console.error(JSON.stringify({ level: 'error', message: 'email notice failed', error: (e as Error).message }));
  }
}

/** Turns a recorded inventory event into notifications for the people it concerns. */
export async function notifyForEvent(env: MailEnv, orgId: string, type: string, data: Record<string, unknown>): Promise<void> {
  const kind = type as NotificationKind;
  if (kind === 'count.assigned') {
    const who = String(data.assignedTo ?? '');
    const row = await env.DB.prepare(`SELECT 1 AS x FROM memberships m WHERE m.org_id = ? AND m.user_id = ? AND m.deactivated_at IS NULL AND NOT EXISTS (SELECT 1 FROM notification_prefs p WHERE p.user_id = m.user_id AND p.org_id = m.org_id AND p.kind = ? AND p.in_app = 0)`).bind(orgId, who, kind).first();
    if (row) await notify(env, orgId, [who], { kind, title: `Count assigned to you: ${data.title ?? 'stock count'}${data.dueAt ? ` (due ${data.dueAt})` : ''}`, link: `/o/${orgId}/counts` });
    return;
  }
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
