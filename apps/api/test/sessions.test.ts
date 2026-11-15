import { describe, expect, it } from 'vitest';
import { call, login, uid } from './helpers';

describe('my sessions', () => {
  it('lists only my sessions, marks the current one, and never exposes a usable token', async () => {
    const email = `${uid()}@example.com`;
    const a = await login(email);
    const b = await login(email);
    const other = await login(`${uid()}@example.com`);
    const list = await call(a, 'GET', '/auth/sessions');
    expect(list.status).toBe(200);
    expect(list.body.data).toHaveLength(2);
    expect(list.body.data.filter((s: { current: boolean }) => s.current)).toHaveLength(1);
    for (const s of list.body.data) expect(s.id).toMatch(/^[0-9a-f]{16}$/);
    expect(JSON.stringify(list.body)).not.toContain(a.split('=')[1]);
    expect((await call(other, 'GET', '/auth/sessions')).body.data).toHaveLength(1);
    void b;
  });

  it('revokes one session, which then stops working', async () => {
    const email = `${uid()}@example.com`;
    const a = await login(email);
    const b = await login(email);
    const target = (await call(a, 'GET', '/auth/sessions')).body.data.find((s: { current: boolean }) => !s.current);
    expect((await call(a, 'DELETE', `/auth/sessions/${target.id}`)).status).toBe(200);
    expect((await call(b, 'GET', '/me')).status).toBe(401);
    expect((await call(a, 'GET', '/me')).status).toBe(200);
    expect((await call(a, 'DELETE', `/auth/sessions/${target.id}`)).status).toBe(404);
  });

  it("cannot revoke someone else's session", async () => {
    const mine = await login(`${uid()}@example.com`);
    const theirs = await login(`${uid()}@example.com`);
    const id = (await call(theirs, 'GET', '/auth/sessions')).body.data[0].id;
    expect((await call(mine, 'DELETE', `/auth/sessions/${id}`)).status).toBe(404);
    expect((await call(theirs, 'GET', '/me')).status).toBe(200);
    expect((await call(mine, 'DELETE', '/auth/sessions/not-an-id')).status).toBe(404);
  });

  it('"sign out everywhere else" keeps only the current session', async () => {
    const email = `${uid()}@example.com`;
    const a = await login(email);
    const b = await login(email);
    const c = await login(email);
    const r = await call(a, 'POST', '/auth/sessions/revoke-others', {});
    expect(r.body.revoked).toBe(2);
    expect((await call(b, 'GET', '/me')).status).toBe(401);
    expect((await call(c, 'GET', '/me')).status).toBe(401);
    expect((await call(a, 'GET', '/me')).status).toBe(200);
  });

  it('needs a session', async () => {
    expect((await call(null, 'GET', '/auth/sessions')).status).toBe(401);
  });
});
