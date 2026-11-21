import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import type { TenantCases } from './backend.js';
import { MemoryCaseBackend } from './memory-backend.js';
import { buildFakeCaseFile, fixtureEvents } from './intake.js';
import { MemorySessionStore } from './session-store.js';
import {
  CSRF_COOKIE_NAME,
  FAST_SSE,
  SESSION_COOKIE_NAME,
  devConfig,
  fakeGithubFetch,
  githubConfig,
  makeApp,
  parseSse,
  signIn,
  type Session,
} from './test-helpers.js';

const COMMIT = 'a'.repeat(40);
const ENDED = 'event: session-ended\n';

async function openCase(app: FastifyInstance, s: Session): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/cases',
    cookies: s.cookies,
    headers: { 'x-csrf-token': s.csrf },
    payload: { repoUrl: 'https://github.com/OWASP/NodeGoat', commit: COMMIT },
  });
  expect(res.statusCode).toBe(201);
  return res.json<{ caseId: string }>().caseId;
}

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

describe('an open event stream ends with its session', () => {
  it('logout closes an open stream with a final session-ended event', async () => {
    const { app } = await makeApp(githubConfig());
    const s = await signIn(app, 1);
    const id = await openCase(app, s);
    const stream = app.inject({ method: 'GET', url: `/cases/${id}/events`, cookies: s.cookies });
    await tick();
    const out = await app.inject({
      method: 'POST',
      url: '/auth/logout',
      cookies: s.cookies,
      headers: { 'x-csrf-token': s.csrf },
    });
    expect(out.statusCode).toBe(204);
    const res = await stream;
    expect(res.statusCode).toBe(200);
    expect(res.body.endsWith(`${ENDED}data: {"error":"session-ended"}\n\n`)).toBe(true);
    // The events sent before the logout are still well formed.
    expect(parseSse(res.body).ids).toEqual(['0']);
    await app.close();
  });

  it('expiry closes an open stream', async () => {
    const clock = { now: Date.parse('2026-11-20T00:00:00Z') };
    const { app } = await makeApp(githubConfig(), { now: () => clock.now });
    const s = await signIn(app, 2);
    const id = await openCase(app, s);
    const stream = app.inject({ method: 'GET', url: `/cases/${id}/events`, cookies: s.cookies });
    await tick();
    clock.now += 61 * 60 * 1000; // past the idle timeout; the stream itself does not refresh it
    expect((await stream).body).toContain(ENDED);
    await app.close();
  });

  it('a sixth sign-in that evicts the oldest session closes that session’s stream', async () => {
    const { app } = await makeApp(githubConfig());
    const first = await signIn(app, 3);
    const id = await openCase(app, first);
    const stream = app.inject({
      method: 'GET',
      url: `/cases/${id}/events`,
      cookies: first.cookies,
    });
    await tick();
    for (let i = 0; i < 5; i++) await signIn(app, 3);
    expect((await stream).body).toContain(ENDED);
    await app.close();
  });

  it('another user’s logout does not close a stream', async () => {
    const { app } = await makeApp(githubConfig({ sse: { ...FAST_SSE, maxStreamMs: 300 } }));
    const a = await signIn(app, 4);
    const b = await signIn(app, 5);
    const id = await openCase(app, a);
    const stream = app.inject({ method: 'GET', url: `/cases/${id}/events`, cookies: a.cookies });
    await tick();
    await app.inject({
      method: 'POST',
      url: '/auth/logout',
      cookies: b.cookies,
      headers: { 'x-csrf-token': b.csrf },
    });
    // Ends at maxStreamMs instead, without a session-ended event.
    expect((await stream).body).not.toContain(ENDED);
    await app.close();
  });
});

describe('repoUrl is a GitHub repository URL only', () => {
  const accepted = [
    'https://github.com/OWASP/NodeGoat',
    'https://github.com/OWASP/NodeGoat.git',
    'https://github.com/a-b/c_d.e',
  ];
  const rejected = [
    'https://169.254.169.254/x',
    'https://localhost/a/b',
    'https://gitlab.com/a/b',
    'https://github.com.evil.example/a/b',
    'https://evil.example/github.com/a/b',
    'https://github.com:443/a/b',
    'https://user@github.com/a/b',
    'https://github.com/a/b?x=1',
    'https://github.com/a/b#frag',
    'https://github.com/a',
    'https://github.com/a/b/c',
    'https://github.com/a/b/',
    'https://github.com/a/..',
    'https://github.com/a/.',
    'https://github.com/-a/b',
    'https://github.com/a%2Fb/c',
    'https://GITHUB.COM/a/b',
    'https://gіthub.com/a/b',
    'https://xn--gthub-n4a.com/a/b',
    'https://github.com/ä/b',
    `https://github.com/${'a'.repeat(40)}/b`,
    `https://github.com/a/${'b'.repeat(101)}`,
    'http://github.com/a/b',
    'file:///etc/passwd',
    '/srv/repos/a',
    './fixtures/nodegoat',
  ];

  it.each(accepted)('accepts %s', async (repoUrl) => {
    const { app } = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/cases',
      payload: { repoUrl, commit: COMMIT },
    });
    expect(res.statusCode).toBe(201);
    await app.close();
  });

  it.each(rejected)('rejects %s', async (repoUrl) => {
    const { app } = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/cases',
      payload: { repoUrl, commit: COMMIT },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'bad-request' });
    await app.close();
  });
});

describe('event replay is paged', () => {
  it('the memory backend honours a limit', async () => {
    const backend = new MemoryCaseBackend();
    backend.seedFixtures('tenant-dev');
    const cases = backend.forTenant('tenant-dev');
    const page = await cases.events('case-nodegoat-sqli-001', -1, 3);
    expect(page!.map((e) => e.seq)).toEqual([0, 1, 2]);
    const next = await cases.events('case-nodegoat-sqli-001', 2, 3);
    expect(next!.map((e) => e.seq)).toEqual([3, 4, 5]);
  });

  it('the stream reads the log in pages and still sends every event in order', async () => {
    const inner = new MemoryCaseBackend();
    const id = 'case-paged';
    const events = fixtureEvents('nodegoat-sqli-001', id);
    inner.seed(buildFakeCaseFile('fixture', 'tenant-dev', id), events);
    const limits: (number | undefined)[] = [];
    const backend = {
      forTenant: (t: string): TenantCases => {
        const c = inner.forTenant(t);
        return {
          ...c,
          events: async (caseId, after, limit) => {
            limits.push(limit);
            const page = await c.events(caseId, after, limit);
            if (page && limit !== undefined) expect(page.length).toBeLessThanOrEqual(limit);
            return page;
          },
        };
      },
      isProvisioned: (t: string) => inner.isProvisioned(t),
      close: () => inner.close(),
    };
    const { app } = await makeApp(devConfig({ sse: { ...FAST_SSE, pageSize: 4 } }), { backend });
    const res = await app.inject({ method: 'GET', url: `/cases/${id}/events` });
    expect(parseSse(res.body).ids).toEqual(events.map((e) => String(e.seq)));
    expect(limits.length).toBeGreaterThan(events.length / 4);
    expect(limits.every((l) => l === 4)).toBe(true);
    await app.close();
  });
});

describe('PKCE (S256)', () => {
  it('sends a challenge on authorize and the matching verifier on the token exchange', async () => {
    const bodies: Record<string, unknown>[] = [];
    const { app } = await makeApp(githubConfig(), { fetch: fakeGithubFetch([], bodies) });
    const login = await app.inject({ method: 'GET', url: '/auth/github/login' });
    const u = new URL(String(login.headers.location));
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    const challenge = u.searchParams.get('code_challenge')!;
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // The verifier is not in the redirect.
    const stateCookie = login.cookies.find((c) => c.name === 'affidavit_oauth_state')!.value;
    const cb = await app.inject({
      method: 'GET',
      url: `/auth/github/callback?code=code-8&state=${u.searchParams.get('state')}`,
      cookies: { affidavit_oauth_state: stateCookie },
    });
    expect(cb.statusCode).toBe(204);
    const verifier = bodies[0]!['code_verifier'] as string;
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(String(login.headers.location)).not.toContain(verifier);
    expect(createHash('sha256').update(verifier).digest('base64url')).toBe(challenge);
    await app.close();
  });

  it('a state cookie from another login cannot be paired with this state', async () => {
    const { app } = await makeApp(githubConfig());
    const one = await app.inject({ method: 'GET', url: '/auth/github/login' });
    const two = await app.inject({ method: 'GET', url: '/auth/github/login' });
    const state = new URL(String(two.headers.location)).searchParams.get('state');
    const cookie = one.cookies.find((c) => c.name === 'affidavit_oauth_state')!.value;
    const cb = await app.inject({
      method: 'GET',
      url: `/auth/github/callback?code=code-8&state=${state}`,
      cookies: { affidavit_oauth_state: cookie },
    });
    expect(cb.statusCode).toBe(400);
    await app.close();
  });
});

describe('cookie prefixes and CSRF binding', () => {
  it('uses __Host- names for the session and CSRF cookies when Secure is on', async () => {
    expect(SESSION_COOKIE_NAME).toBe('__Host-affidavit_session');
    expect(CSRF_COOKIE_NAME).toBe('__Host-affidavit_csrf');
    const { app } = await makeApp(githubConfig());
    const s = await signIn(app, 12);
    expect(Object.keys(s.cookies).sort()).toEqual([CSRF_COOKIE_NAME, SESSION_COOKIE_NAME]);
    const csrf = await app.inject({ method: 'GET', url: '/auth/csrf', cookies: s.cookies });
    const login = await app.inject({ method: 'GET', url: '/auth/github/login' });
    expect(login.statusCode).toBe(302);
    for (const c of csrf.cookies) {
      expect(c.secure).toBe(true);
      expect(c.path).toBe('/');
      expect(c.domain).toBeUndefined();
    }
    await app.close();
  });

  it('uses plain names without Secure on an http loopback redirect', async () => {
    const config = githubConfig();
    if (config.auth.mode !== 'github') throw new Error('unreachable');
    const { app } = await makeApp({
      ...config,
      auth: { ...config.auth, redirectUrl: 'http://127.0.0.1:3000/auth/github/callback' },
    });
    const login = await app.inject({ method: 'GET', url: '/auth/github/login' });
    const state = new URL(String(login.headers.location)).searchParams.get('state');
    const stateCookie = login.cookies.find((c) => c.name === 'affidavit_oauth_state')!;
    expect(stateCookie.secure).toBeFalsy();
    const cb = await app.inject({
      method: 'GET',
      url: `/auth/github/callback?code=code-13&state=${state}`,
      cookies: { affidavit_oauth_state: stateCookie.value },
    });
    const c = cb.cookies.find((x) => x.name === 'affidavit_session')!;
    expect(c.secure).toBeFalsy();
    expect(c.httpOnly).toBe(true);
    await app.close();
  });

  it('/auth/csrf needs a session', async () => {
    const { app } = await makeApp(githubConfig());
    const res = await app.inject({ method: 'GET', url: '/auth/csrf' });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('a CSRF token is bound to its session id', async () => {
    const sessions = new MemorySessionStore();
    const { app } = await makeApp(githubConfig(), { sessions });
    const a = await signIn(app, 20);
    const b = await signIn(app, 21);
    // B's session with A's CSRF secret cookie and A's token: the token names A's session.
    const res = await app.inject({
      method: 'POST',
      url: '/cases',
      cookies: {
        [SESSION_COOKIE_NAME]: b.cookies[SESSION_COOKIE_NAME]!,
        [CSRF_COOKIE_NAME]: a.cookies[CSRF_COOKIE_NAME]!,
      },
      headers: { 'x-csrf-token': a.csrf },
      payload: { repoUrl: 'https://github.com/a/b', commit: COMMIT },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'csrf-failed' });
    // A's token still works for A.
    expect((await openCase(app, a)).length).toBeGreaterThan(0);
    // A token minted for an earlier session of the same user stops working after sign-in again.
    const a2 = await signIn(app, 20);
    const stale = await app.inject({
      method: 'POST',
      url: '/cases',
      cookies: {
        [SESSION_COOKIE_NAME]: a2.cookies[SESSION_COOKIE_NAME]!,
        [CSRF_COOKIE_NAME]: a.cookies[CSRF_COOKIE_NAME]!,
      },
      headers: { 'x-csrf-token': a.csrf },
      payload: { repoUrl: 'https://github.com/a/b', commit: COMMIT },
    });
    expect(stale.statusCode).toBe(403);
    await app.close();
  });
});
