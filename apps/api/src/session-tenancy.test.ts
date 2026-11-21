import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { githubTenantId } from './auth.js';
import { MemoryCaseBackend } from './memory-backend.js';
import { MemorySessionStore, SessionCapacityError } from './session-store.js';
import { githubConfig, makeApp, signIn } from './test-helpers.js';

const T0 = Date.parse('2026-11-20T00:00:00Z');
const t = (n: number) => githubTenantId(n);

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

describe('per-tenant session pools', () => {
  it('tenant A exhausting its pool does not affect tenant B logins or sessions', async () => {
    const s = new MemorySessionStore({ perSubject: 50, perTenant: 3, max: 1000 });
    const b = await s.create(t(2), '2', T0);
    const a: string[] = [];
    for (let i = 1; i <= 20; i++) a.push(await s.create(t(1), '1', T0 + i));
    // A keeps its 3 most recently used sessions; B is untouched and can still sign in.
    expect(s.countFor(t(1))).toBe(3);
    expect(await s.use(b, t(2), T0 + 100)).not.toBeNull();
    const b2 = await s.create(t(2), '2', T0 + 101);
    expect(await s.use(b2, t(2), T0 + 102)).not.toBeNull();
    expect(await s.use(a[19]!, t(1), T0 + 103)).not.toBeNull();
    expect(await s.use(a[0]!, t(1), T0 + 103)).toBeNull();
  });

  it('the tenant pool evicts its least recently used session, not the oldest', async () => {
    const s = new MemorySessionStore({ perSubject: 50, perTenant: 2, max: 1000 });
    const first = await s.create(t(1), '1', T0);
    const second = await s.create(t(1), '1', T0 + 1);
    await s.use(first, t(1), T0 + 2); // first is now the more recently used
    await s.create(t(1), '1', T0 + 3);
    expect(await s.use(first, t(1), T0 + 4)).not.toBeNull();
    expect(await s.use(second, t(1), T0 + 4)).toBeNull();
  });

  it('at the global ceiling the largest tenant is trimmed and small tenants are unaffected', async () => {
    const s = new MemorySessionStore({ perSubject: 50, perTenant: 50, tenantQuota: 2, max: 6 });
    const small = [await s.create(t(2), '2', T0), await s.create(t(3), '3', T0)];
    for (let i = 0; i < 4; i++) await s.create(t(1), '1', T0 + 1 + i);
    expect(s.size).toBe(6);
    // A new tenant signs in at the ceiling: tenant 1 (largest, above quota) loses one session.
    const fresh = await s.create(t(4), '4', T0 + 10);
    expect(s.countFor(t(1))).toBe(3);
    for (const [i, sid] of small.entries()) {
      expect(await s.use(sid, t(i + 2), T0 + 11)).not.toBeNull();
    }
    expect(await s.use(fresh, t(4), T0 + 11)).not.toBeNull();
  });

  it('never trims a tenant within its quota; then only the new login is refused', async () => {
    const s = new MemorySessionStore({ perSubject: 50, perTenant: 50, tenantQuota: 2, max: 4 });
    const held = [
      await s.create(t(1), '1', T0),
      await s.create(t(1), '1', T0),
      await s.create(t(2), '2', T0),
      await s.create(t(2), '2', T0),
    ];
    await expect(s.create(t(3), '3', T0 + 1)).rejects.toBeInstanceOf(SessionCapacityError);
    for (const [i, sid] of held.entries()) {
      expect(await s.use(sid, t(i < 2 ? 1 : 2), T0 + 2)).not.toBeNull();
    }
  });
});

describe('provisioning gate', () => {
  it('an unprovisioned user gets 403 and creates no session', async () => {
    const sessions = new MemorySessionStore();
    const backend = new MemoryCaseBackend({ provisionedTenants: [t(1)] });
    const { app } = await makeApp(githubConfig(), { backend, sessions });
    const res = await callback(app, 999);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'tenant-not-provisioned' });
    expect(res.cookies.find((c) => c.name === '__Host-affidavit_session')).toBeUndefined();
    expect(sessions.size).toBe(0);
    // A provisioned user still signs in.
    const ok = await signIn(app, 1);
    expect(ok.cookies['__Host-affidavit_session']).toBeTruthy();
    expect(sessions.size).toBe(1);
    await app.close();
  });

  it('many unprovisioned logins cannot fill capacity for provisioned users', async () => {
    const sessions = new MemorySessionStore({ max: 2 });
    const backend = new MemoryCaseBackend({ provisionedTenants: [t(1)] });
    const { app } = await makeApp(githubConfig({ rateLimitMax: 10_000 }), { backend, sessions });
    for (let i = 0; i < 5; i++) expect((await callback(app, 500 + i)).statusCode).toBe(403);
    expect(sessions.size).toBe(0);
    expect((await callback(app, 1)).statusCode).toBe(204);
    await app.close();
  });
});
