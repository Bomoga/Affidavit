import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { githubTenantId } from './auth.js';
import { MemorySessionStore, SESSION_IDLE_TTL_MS, SessionCapacityError } from './session-store.js';
import { githubConfig, makeApp, signIn } from './test-helpers.js';

const T0 = Date.parse('2026-11-20T00:00:00Z');
const PROBE = '/cases/case-probe';

const store = (max: number, perSubject = 5) =>
  new MemorySessionStore({
    absoluteMs: 8 * 3600_000,
    idleMs: SESSION_IDLE_TTL_MS,
    max,
    perSubject,
  });

describe('MemorySessionStore capacity', () => {
  it('one subject creating many sessions never evicts another subject or tenant', async () => {
    const s = store(1000);
    const b = await s.create('github-2', '2', T0);
    const c = await s.create('github-3', '3', T0);
    const a: string[] = [];
    for (let i = 0; i < 50; i++) a.push(await s.create('github-1', '1', T0 + i));
    expect(await s.use(b, 'github-2', T0 + 100)).not.toBeNull();
    expect(await s.use(c, 'github-3', T0 + 100)).not.toBeNull();
    // Subject 1 keeps only its 5 newest sessions; its own oldest were evicted.
    const live = [];
    for (const sid of a) if (await s.use(sid, 'github-1', T0 + 100)) live.push(sid);
    expect(live).toEqual(a.slice(-5));
    expect(s.size).toBe(7);
  });

  it('at the global cap a new session is refused and nobody is evicted', async () => {
    const s = store(3);
    const sids = [
      await s.create('github-1', '1', T0),
      await s.create('github-2', '2', T0),
      await s.create('github-3', '3', T0),
    ];
    await expect(s.create('github-4', '4', T0 + 1)).rejects.toBeInstanceOf(SessionCapacityError);
    for (const [i, sid] of sids.entries()) {
      expect(await s.use(sid, `github-${i + 1}`, T0 + 2)).not.toBeNull();
    }
  });

  it('a subject at its own cap replaces its oldest session even when the store is full', async () => {
    const s = store(3, 2);
    const a1 = await s.create('github-1', '1', T0);
    const a2 = await s.create('github-1', '1', T0 + 1);
    const b = await s.create('github-2', '2', T0 + 2);
    const a3 = await s.create('github-1', '1', T0 + 3);
    expect(await s.use(a1, 'github-1', T0 + 4)).toBeNull();
    expect(await s.use(a2, 'github-1', T0 + 4)).not.toBeNull();
    expect(await s.use(a3, 'github-1', T0 + 4)).not.toBeNull();
    expect(await s.use(b, 'github-2', T0 + 4)).not.toBeNull();
  });

  it('expired sessions free capacity', async () => {
    const s = store(2);
    await s.create('github-1', '1', T0);
    await s.create('github-2', '2', T0);
    await expect(s.create('github-3', '3', T0 + 1)).rejects.toBeInstanceOf(SessionCapacityError);
    const later = T0 + SESSION_IDLE_TTL_MS + 1;
    const c = await s.create('github-3', '3', later);
    expect(await s.use(c, 'github-3', later)).not.toBeNull();
    expect(s.size).toBe(1);
  });

  it('sweep removes expired sessions', async () => {
    const s = store(10);
    await s.create('github-1', '1', T0);
    const keep = await s.create('github-2', '2', T0 + SESSION_IDLE_TTL_MS);
    expect(s.sweep(T0 + SESSION_IDLE_TTL_MS + 1)).toBe(1);
    expect(s.size).toBe(1);
    expect(await s.use(keep, 'github-2', T0 + SESSION_IDLE_TTL_MS + 2)).not.toBeNull();
  });
});

async function callback(app: FastifyInstance, userId: number) {
  const login = await app.inject({ method: 'GET', url: '/auth/github/login' });
  const state = new URL(String(login.headers.location)).searchParams.get('state');
  const stateCookie = login.cookies.find((c) => c.name === 'affidavit_oauth_state')!.value;
  return app.inject({
    method: 'GET',
    url: `/auth/github/callback?code=code-${userId}&state=${state}`,
    cookies: { affidavit_oauth_state: stateCookie },
  });
}

describe('session capacity over HTTP', () => {
  it('at the global cap a new login gets 503 with Retry-After and existing sessions still work', async () => {
    const clock = { now: T0 };
    const { app } = await makeApp(githubConfig(), { now: () => clock.now, sessions: store(2) });
    const a = await signIn(app, 1);
    const b = await signIn(app, 2);
    const res = await callback(app, 3);
    expect(res.statusCode).toBe(503);
    expect(res.headers['retry-after']).toBe('60');
    expect(res.json()).toEqual({ error: 'sessions-full' });
    expect(res.cookies.find((c) => c.name === 'affidavit_session')).toBeUndefined();
    for (const s of [a, b]) {
      expect((await app.inject({ method: 'GET', url: PROBE, cookies: s.cookies })).statusCode).toBe(
        404,
      );
    }
    // Once the existing sessions go idle, capacity is back.
    clock.now += SESSION_IDLE_TTL_MS + 1;
    expect((await callback(app, 3)).statusCode).toBe(204);
    await app.close();
  });

  it('repeated logins by one user do not log out another tenant', async () => {
    const { app } = await makeApp(githubConfig({ rateLimitMax: 10_000 }), { sessions: store(100) });
    const other = await signIn(app, 2);
    for (let i = 0; i < 9; i++) expect((await callback(app, 1)).statusCode).toBe(204);
    const res = await app.inject({ method: 'GET', url: PROBE, cookies: other.cookies });
    expect(res.statusCode).toBe(404);
    expect(githubTenantId(2)).toBe('github-2');
    await app.close();
  });

  it('session creation is rate limited per IP', async () => {
    const { app } = await makeApp(githubConfig({ rateLimitMax: 10_000 }), {
      sessions: store(1000),
    });
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) codes.push((await callback(app, 100 + i)).statusCode);
    expect(codes.filter((c) => c === 204)).toHaveLength(10);
    expect(codes.at(-1)).toBe(429);
    await app.close();
  });
});
