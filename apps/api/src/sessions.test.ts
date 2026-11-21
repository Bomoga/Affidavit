import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { githubTenantId } from './auth.js';
import { MemorySessionStore } from './session-store.js';
import { githubConfig, makeApp, signIn, type Session } from './test-helpers.js';

const HOUR = 60 * 60 * 1000;
const PROBE = '/cases/case-probe';

/** 404 means authenticated (the case simply does not exist); 401 means refused. */
async function probe(app: FastifyInstance, cookies: Record<string, string>): Promise<number> {
  return (await app.inject({ method: 'GET', url: PROBE, cookies })).statusCode;
}

function sessionCookie(app: FastifyInstance, payload: object): string {
  return app.signCookie(Buffer.from(JSON.stringify(payload)).toString('base64url'));
}

function sidOf(s: Session): string {
  const value = s.cookies['__Host-affidavit_session']!.split('.')[0]!;
  return (JSON.parse(Buffer.from(value, 'base64url').toString()) as { i: string }).i;
}

async function setup(start = Date.parse('2026-11-20T00:00:00Z')) {
  const clock = { now: start };
  const sessions = new MemorySessionStore();
  const { app } = await makeApp(githubConfig(), { now: () => clock.now, sessions });
  return { app, sessions, clock };
}

describe('server-side sessions', () => {
  it('after logout the same cookie is rejected with 401', async () => {
    const { app, sessions } = await setup();
    const s = await signIn(app, 1);
    expect(await probe(app, s.cookies)).toBe(404);
    const out = await app.inject({
      method: 'POST',
      url: '/auth/logout',
      cookies: s.cookies,
      headers: { 'x-csrf-token': s.csrf },
    });
    expect(out.statusCode).toBe(204);
    expect(sessions.size).toBe(0);
    // A copy of the cookie kept by an attacker is now worthless.
    expect(await probe(app, s.cookies)).toBe(401);
    await app.close();
  });

  it('a validly signed cookie with an unknown session id is rejected', async () => {
    const { app } = await setup();
    await signIn(app, 1);
    const forged = sessionCookie(app, {
      v: 2,
      i: randomBytes(32).toString('base64url'),
      t: githubTenantId(1),
      s: '1',
    });
    expect(await probe(app, { '__Host-affidavit_session': forged })).toBe(401);
    await app.close();
  });

  it('a tampered cookie is rejected', async () => {
    const { app } = await setup();
    const s = await signIn(app, 1);
    const [value, sig] = s.cookies['__Host-affidavit_session']!.split('.');
    const flipped = `${value}.${sig!.slice(0, -1)}${sig!.endsWith('A') ? 'B' : 'A'}`;
    expect(await probe(app, { '__Host-affidavit_session': flipped })).toBe(401);
    expect(await probe(app, { '__Host-affidavit_session': value! })).toBe(401);
    await app.close();
  });

  it('the idle timeout is enforced', async () => {
    const { app, clock } = await setup();
    const s = await signIn(app, 1);
    clock.now += 59 * 60 * 1000;
    expect(await probe(app, s.cookies)).toBe(404);
    clock.now += 61 * 60 * 1000;
    expect(await probe(app, s.cookies)).toBe(401);
    await app.close();
  });

  it('the absolute lifetime is enforced even for a session in constant use', async () => {
    const { app, clock } = await setup();
    const s = await signIn(app, 1);
    for (let t = 0; t < 15; t++) {
      clock.now += HOUR / 2;
      expect(await probe(app, s.cookies)).toBe(404);
    }
    clock.now += HOUR / 2 + 1;
    expect(await probe(app, s.cookies)).toBe(401);
    await app.close();
  });

  it('tenant B can neither use nor revoke tenant A’s session', async () => {
    const { app, sessions } = await setup();
    const a = await signIn(app, 101);
    const b = await signIn(app, 202);
    const sidA = sidOf(a);
    // A cookie signed by the server that pairs A's session id with B's tenant is refused.
    const mixed = sessionCookie(app, { v: 2, i: sidA, t: githubTenantId(202), s: '202' });
    expect(await probe(app, { '__Host-affidavit_session': mixed })).toBe(401);
    // The store refuses a revoke from the wrong tenant.
    expect(await sessions.revoke(sidA, githubTenantId(202))).toBe(false);
    // B logging out ends B's session only.
    await app.inject({
      method: 'POST',
      url: '/auth/logout',
      cookies: b.cookies,
      headers: { 'x-csrf-token': b.csrf },
    });
    expect(await probe(app, b.cookies)).toBe(401);
    expect(await probe(app, a.cookies)).toBe(404);
    await app.close();
  });

  it('the session cookie is HttpOnly, Secure and SameSite=Lax and carries no secret', async () => {
    const { app } = await setup();
    const login = await app.inject({ method: 'GET', url: '/auth/github/login' });
    const state = new URL(String(login.headers.location)).searchParams.get('state');
    const stateCookie = login.cookies.find((c) => c.name === 'affidavit_oauth_state')!.value;
    const cb = await app.inject({
      method: 'GET',
      url: `/auth/github/callback?code=code-5&state=${state}`,
      cookies: { affidavit_oauth_state: stateCookie },
    });
    const c = cb.cookies.find((x) => x.name === '__Host-affidavit_session')!;
    expect(c.httpOnly).toBe(true);
    expect(c.secure).toBe(true);
    expect(c.sameSite).toBe('Lax');
    expect(c.maxAge).toBe(8 * 60 * 60);
    expect(c.value).not.toContain('gho_');
    await app.close();
  });
});
