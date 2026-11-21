import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { MemoryCaseBackend } from './memory-backend.js';
import {
  CLIENT_SECRET,
  SESSION_SECRET,
  WEBHOOK_SECRET,
  devConfig,
  fakeGithubFetch,
  githubConfig,
  makeApp,
  signIn,
} from './test-helpers.js';
import { signGithubBody } from './webhook.js';

const COMMIT = 'd'.repeat(40);
const PAYLOAD = { repoUrl: 'https://github.com/a/repo', commit: COMMIT };

function logSink(): { stream: Writable; text: () => string } {
  const chunks: string[] = [];
  return {
    stream: new Writable({
      write(chunk: Buffer, _enc, cb) {
        chunks.push(chunk.toString());
        cb();
      },
    }),
    text: () => chunks.join(''),
  };
}

describe('dev auth', () => {
  it('acts as the fixed dev tenant without any credential', async () => {
    const { app } = await makeApp(devConfig());
    const res = await app.inject({ method: 'POST', url: '/cases', payload: PAYLOAD });
    expect(res.statusCode).toBe(201);
    const id = res.json<{ caseId: string }>().caseId;
    const got = await app.inject({ method: 'GET', url: `/cases/${id}` });
    expect(got.json<{ caseFile: { tenantId: string } }>().caseFile.tenantId).toBe('tenant-dev');
    await app.close();
  });

  it('refuses a non-loopback Host header (DNS rebinding)', async () => {
    const { app } = await makeApp(devConfig());
    for (const host of ['evil.example', 'attacker.test:3000', '192.168.0.5']) {
      const res = await app.inject({ method: 'GET', url: '/cases/x', headers: { host } });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: 'host-not-allowed' });
    }
    const ok = await app.inject({
      method: 'GET',
      url: '/healthz',
      headers: { host: '127.0.0.1:3000' },
    });
    expect(ok.statusCode).toBe(200);
    await app.close();
  });

  it('refuses a mutating request from an origin that is not allowed', async () => {
    const { app } = await makeApp(devConfig());
    const res = await app.inject({
      method: 'POST',
      url: '/cases',
      headers: { origin: 'https://evil.example' },
      payload: PAYLOAD,
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'origin-not-allowed' });
    const allowed = await app.inject({
      method: 'POST',
      url: '/cases',
      headers: { origin: 'http://localhost:5173' },
      payload: PAYLOAD,
    });
    expect(allowed.statusCode).toBe(201);
    await app.close();
  });

  it('refuses a form or text body (no simple cross-site POST)', async () => {
    const { app } = await makeApp(devConfig());
    for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data']) {
      const res = await app.inject({
        method: 'POST',
        url: '/cases',
        headers: { 'content-type': type },
        payload: JSON.stringify(PAYLOAD),
      });
      expect(res.statusCode).toBe(415);
      expect(res.json()).toEqual({ error: 'unsupported-media-type' });
    }
    await app.close();
  });
});

describe('github auth', () => {
  it('login redirects to GitHub with the client id and a state bound to a cookie', async () => {
    const { app } = await makeApp(githubConfig());
    const res = await app.inject({ method: 'GET', url: '/auth/github/login' });
    expect(res.statusCode).toBe(302);
    const u = new URL(String(res.headers.location));
    expect(u.origin + u.pathname).toBe('https://github.com/login/oauth/authorize');
    expect(u.searchParams.get('client_id')).toBe('Iv1.testclient');
    expect(u.searchParams.get('state')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(String(res.headers.location)).not.toContain(CLIENT_SECRET);
    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toMatch(/affidavit_oauth_state=.*HttpOnly/);
    expect(cookie).toMatch(/Secure/);
    await app.close();
  });

  it('a callback with a state that does not match the cookie is refused', async () => {
    const calls: string[] = [];
    const { app } = await makeApp(githubConfig(), { fetch: fakeGithubFetch(calls) });
    const login = await app.inject({ method: 'GET', url: '/auth/github/login' });
    const stateCookie = login.cookies.find((c) => c.name === 'affidavit_oauth_state')!.value;
    const forged = await app.inject({
      method: 'GET',
      url: `/auth/github/callback?code=code-1&state=${'x'.repeat(43)}`,
      cookies: { affidavit_oauth_state: stateCookie },
    });
    expect(forged.statusCode).toBe(400);
    expect(forged.json()).toEqual({ error: 'oauth-failed' });
    const noCookie = await app.inject({
      method: 'GET',
      url: `/auth/github/callback?code=code-1&state=${'x'.repeat(43)}`,
    });
    expect(noCookie.statusCode).toBe(400);
    expect(calls).toEqual([]);
    await app.close();
  });

  it('a failed code exchange is a fixed 502 that echoes nothing', async () => {
    const { app } = await makeApp(githubConfig());
    const login = await app.inject({ method: 'GET', url: '/auth/github/login' });
    const state = new URL(String(login.headers.location)).searchParams.get('state');
    const stateCookie = login.cookies.find((c) => c.name === 'affidavit_oauth_state')!.value;
    const res = await app.inject({
      method: 'GET',
      url: `/auth/github/callback?code=badcode&state=${state}`,
      cookies: { affidavit_oauth_state: stateCookie },
    });
    expect(res.statusCode).toBe(502);
    expect(res.body).toBe('{"error":"oauth-failed"}');
    await app.close();
  });

  it('a signed-in session reads, and a mutating request needs the CSRF token', async () => {
    const { app } = await makeApp(githubConfig());
    const s = await signIn(app, 7);
    const noToken = await app.inject({
      method: 'POST',
      url: '/cases',
      cookies: s.cookies,
      payload: PAYLOAD,
    });
    expect(noToken.statusCode).toBe(403);
    expect(noToken.json()).toEqual({ error: 'csrf-failed' });
    const wrong = await app.inject({
      method: 'POST',
      url: '/cases',
      cookies: s.cookies,
      headers: { 'x-csrf-token': 'not-the-token' },
      payload: PAYLOAD,
    });
    expect(wrong.statusCode).toBe(403);
    const ok = await app.inject({
      method: 'POST',
      url: '/cases',
      cookies: s.cookies,
      headers: { 'x-csrf-token': s.csrf },
      payload: PAYLOAD,
    });
    expect(ok.statusCode).toBe(201);
    await app.close();
  });

  it('refuses a tampered, unsigned or expired session cookie', async () => {
    let now = Date.parse('2026-11-20T00:00:00Z');
    const { app } = await makeApp(githubConfig(), { now: () => now });
    const s = await signIn(app, 9);
    const session = s.cookies['__Host-affidavit_session']!;
    const [value] = session.split('.');
    const forgedValue = Buffer.from(
      JSON.stringify({ v: 1, t: 'github-1', s: '1', e: now + 1e9 }),
    ).toString('base64url');
    for (const bad of [value!, `${forgedValue}.${session.split('.')[1]}`, 'garbage']) {
      const res = await app.inject({
        method: 'GET',
        url: '/cases/case-x',
        cookies: { '__Host-affidavit_session': bad },
      });
      expect(res.statusCode).toBe(401);
    }
    const fine = await app.inject({ method: 'GET', url: '/cases/case-x', cookies: s.cookies });
    expect(fine.statusCode).toBe(404);
    now += 9 * 60 * 60 * 1000;
    const expired = await app.inject({ method: 'GET', url: '/cases/case-x', cookies: s.cookies });
    expect(expired.statusCode).toBe(401);
    await app.close();
  });

  it('logout clears the session and needs the CSRF token', async () => {
    const { app } = await makeApp(githubConfig());
    const s = await signIn(app, 11);
    const noToken = await app.inject({ method: 'POST', url: '/auth/logout', cookies: s.cookies });
    expect(noToken.statusCode).toBe(403);
    const res = await app.inject({
      method: 'POST',
      url: '/auth/logout',
      cookies: s.cookies,
      headers: { 'x-csrf-token': s.csrf },
    });
    expect(res.statusCode).toBe(204);
    expect(String(res.headers['set-cookie'])).toMatch(/__Host-affidavit_session=;/);
    await app.close();
  });

  it('dev auth has no OAuth routes', async () => {
    const { app } = await makeApp(devConfig());
    const res = await app.inject({ method: 'GET', url: '/auth/github/login' });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

describe('no secret in any response or log', () => {
  it('the OAuth flow, webhooks and errors never log or return a secret', async () => {
    const logs = logSink();
    const { app } = await makeApp(githubConfig(), {
      logger: { level: 'debug', stream: logs.stream },
      backend: new MemoryCaseBackend(),
    });
    const s = await signIn(app, 42);
    const bodies: string[] = [];
    const record = (r: { body: string; headers: Record<string, unknown> }) =>
      bodies.push(r.body, JSON.stringify(r.headers));
    record(
      await app.inject({
        method: 'POST',
        url: '/cases',
        cookies: s.cookies,
        headers: { 'x-csrf-token': s.csrf },
        payload: PAYLOAD,
      }),
    );
    const raw = JSON.stringify({ action: 'opened' });
    record(
      await app.inject({
        method: 'POST',
        url: '/webhooks/github',
        headers: {
          'content-type': 'application/json',
          'x-hub-signature-256': signGithubBody(WEBHOOK_SECRET, raw),
          'x-github-event': 'pull_request',
          'x-github-delivery': 'abc-123',
        },
        payload: raw,
      }),
    );
    record(await app.inject({ method: 'GET', url: '/auth/github/callback?code=code-1&state=zz' }));
    await app.close();
    const all = logs.text() + bodies.join('\n');
    expect(logs.text()).toContain('incoming request');
    for (const secret of [CLIENT_SECRET, SESSION_SECRET, WEBHOOK_SECRET, 'gho_42', 'code-1']) {
      expect(all).not.toContain(secret);
    }
    expect(logs.text()).not.toContain('affidavit_session');
  });
});
