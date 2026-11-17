import type { Bindings } from './env';
import { signPayload } from './auth';
import { nowIso } from './util';

export type MailEnv = Pick<Bindings, 'DB' | 'APP_ORIGIN' | 'COOKIE_SIGNING_KEY'> & Partial<Pick<Bindings, 'BREVO_API_KEY' | 'EMAIL_FROM'>>;

/** Which notification kinds are emailed unless the person switches them off. Everything else is in-app only until they opt in. */
export const EMAIL_DEFAULT_ON = new Set(['approval.requested', 'approval.decided', 'security.not_me', 'support.granted', 'usage.alert']);
export const DIGEST_KIND = 'digest';

export const ORG_DAILY_CAP = 50;
export const PLATFORM_DAILY_CAP = 250; // Brevo's free plan sends 300 a day; keep a margin

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);

export interface Mail { to: { email: string; name?: string }; subject: string; lines: string[]; link?: { url: string; label: string }; footer?: string; unsubscribe?: string }

export function render(m: Mail): { text: string; html: string } {
  const text = [...m.lines, ...(m.link ? ['', `${m.link.label}: ${m.link.url}`] : []), '', '--', ...(m.footer ? [m.footer] : []), ...(m.unsubscribe ? [`Stop these emails: ${m.unsubscribe}`] : [])].join('\n');
  const html = `<!doctype html><html lang="en"><body style="font-family:Arial,Helvetica,sans-serif;color:#222;line-height:1.5;max-width:560px">${m.lines.map((l) => `<p>${esc(l)}</p>`).join('')}${m.link ? `<p><a href="${esc(m.link.url)}" style="background:#2c3e50;color:#fff;padding:10px 16px;border-radius:4px;text-decoration:none;display:inline-block">${esc(m.link.label)}</a></p><p style="font-size:12px;color:#555">If the button does not work, copy this address: ${esc(m.link.url)}</p>` : ''}<hr style="border:0;border-top:1px solid #ddd"><p style="font-size:12px;color:#555">${m.footer ? esc(m.footer) : ''}${m.unsubscribe ? ` <a href="${esc(m.unsubscribe)}">Stop these emails</a>` : ''}</p></body></html>`;
  return { text, html };
}

/** Takes one unit from the business's day and from the platform's day. Returns false when either is used up. */
async function reserve(env: MailEnv, scope: string): Promise<boolean> {
  const day = nowIso().slice(0, 10);
  const take = async (s: string, cap: number) =>
    !!(await env.DB.prepare(`INSERT INTO email_counts(day, scope, n) VALUES (?, ?, 1) ON CONFLICT(day, scope) DO UPDATE SET n = n + 1 WHERE n < ? RETURNING n`).bind(day, s, cap).first());
  if (!(await take(scope, ORG_DAILY_CAP))) return false;
  return take('_all', PLATFORM_DAILY_CAP);
}

/** Sends one email through Brevo. Never throws: email is a convenience, never a reason for a request to fail. */
export async function sendMail(env: MailEnv, scope: string, m: Mail): Promise<boolean> {
  if (!env.BREVO_API_KEY || !env.EMAIL_FROM) return false;
  try {
    if (!(await reserve(env, scope))) return false;
    const { text, html } = render(m);
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': env.BREVO_API_KEY, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        sender: { name: 'ShopList', email: env.EMAIL_FROM },
        to: [m.to],
        subject: m.subject.slice(0, 200),
        textContent: text,
        htmlContent: html,
        ...(m.unsubscribe ? { headers: { 'List-Unsubscribe': `<${m.unsubscribe}>` } } : {}),
      }),
    });
    if (!res.ok) console.error(JSON.stringify({ level: 'error', message: 'email refused', status: res.status }));
    return res.ok;
  } catch (e) {
    console.error(JSON.stringify({ level: 'error', message: 'email failed', error: (e as Error).message }));
    return false;
  }
}

export const unsubscribeUrl = async (env: MailEnv, userId: string, orgId: string, kind: string) =>
  `${env.APP_ORIGIN}/api/v1/email/unsubscribe?t=${encodeURIComponent(await signPayload(env as Bindings, { u: userId, o: orgId, k: kind }))}`;

/** Does this person want this kind by email? A saved choice wins; otherwise the kind's default. */
export async function wantsEmail(env: Pick<MailEnv, 'DB'>, userIds: string[], orgId: string, kind: string): Promise<Set<string>> {
  if (!userIds.length) return new Set();
  const marks = userIds.map(() => '?').join(',');
  const { results } = await env.DB.prepare(`SELECT user_id, email FROM email_prefs WHERE org_id = ? AND kind = ? AND user_id IN (${marks})`).bind(orgId, kind, ...userIds).all<{ user_id: string; email: number }>();
  const saved = new Map(results.map((r) => [r.user_id, r.email === 1]));
  const dflt = EMAIL_DEFAULT_ON.has(kind);
  return new Set(userIds.filter((u) => saved.get(u) ?? dflt));
}
