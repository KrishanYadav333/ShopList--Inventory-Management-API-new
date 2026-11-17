import { applyD1Migrations, env } from 'cloudflare:test';

await applyD1Migrations(env.DB, (env as unknown as { TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1] }).TEST_MIGRATIONS);

// Brevo is never called for real in tests. Every send is recorded here so tests can look at it.
export interface SentMail { to: string; subject: string; text: string; html: string; headers?: Record<string, string> }
const g = globalThis as unknown as { __mail?: SentMail[]; __mailFail?: boolean };
g.__mail = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
  if (url.startsWith('https://api.brevo.com/')) {
    const b = JSON.parse(String(init?.body ?? '{}'));
    if (g.__mailFail) return new Response('{"message":"nope"}', { status: 401 });
    g.__mail!.push({ to: b.to?.[0]?.email, subject: b.subject, text: b.textContent, html: b.htmlContent, headers: b.headers });
    return Response.json({ messageId: 'test' }, { status: 201 });
  }
  return realFetch(input as RequestInfo, init);
}) as typeof fetch;
