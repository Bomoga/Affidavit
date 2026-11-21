import { describe, expect, it } from 'vitest';
import { MemoryCaseBackend } from './memory-backend.js';
import { devConfig, githubConfig, makeApp } from './test-helpers.js';

const COMMIT = 'e'.repeat(40);

describe('security headers', () => {
  it('sends a strict CSP and the standard hardening headers on every response', async () => {
    const { app } = await makeApp(devConfig());
    for (const url of ['/healthz', '/cases/case-missing', '/nope']) {
      const res = await app.inject({ method: 'GET', url });
      const csp = String(res.headers['content-security-policy']);
      expect(csp).toContain("default-src 'none'");
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).toContain("base-uri 'none'");
      expect(csp).toContain("form-action 'none'");
      expect(csp).not.toContain('unsafe');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['strict-transport-security']).toMatch(/max-age=31536000/);
      expect(res.headers['referrer-policy']).toBe('no-referrer');
      expect(res.headers['cross-origin-resource-policy']).toBe('same-origin');
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['x-powered-by']).toBeUndefined();
    }
    await app.close();
  });

  it('the SSE response carries the same headers', async () => {
    const backend = new MemoryCaseBackend();
    backend.seedFixtures('tenant-dev');
    const { app } = await makeApp(devConfig(), { backend });
    const res = await app.inject({ method: 'GET', url: '/cases/case-escalated-001/events' });
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    await app.close();
  });
});

describe('CORS', () => {
  it('allows only configured origins, without credentials in dev mode', async () => {
    const { app } = await makeApp(devConfig());
    const ok = await app.inject({
      method: 'OPTIONS',
      url: '/cases/case-x/events',
      headers: {
        origin: 'http://localhost:5173',
        'access-control-request-method': 'GET',
        'access-control-request-headers': 'last-event-id',
      },
    });
    expect(ok.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(String(ok.headers['access-control-allow-headers'])).toContain('last-event-id');
    expect(ok.headers['access-control-allow-credentials']).toBeUndefined();
    const bad = await app.inject({
      method: 'OPTIONS',
      url: '/cases',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' },
    });
    expect(bad.headers['access-control-allow-origin']).toBeUndefined();
    await app.close();
  });

  it('allows credentials in github mode', async () => {
    const { app } = await makeApp(githubConfig());
    const res = await app.inject({
      method: 'GET',
      url: '/healthz',
      headers: { origin: 'http://localhost:5173' },
    });
    expect(res.headers['access-control-allow-credentials']).toBe('true');
    await app.close();
  });
});

describe('input validation and error bodies', () => {
  it.each([
    '/cases/bad%20id',
    '/cases/..%2F..%2Fetc',
    `/cases/${'a'.repeat(129)}`,
    '/cases/%3Cscript%3E/events',
    '/cases/a.b/verdict',
  ])('rejects the unsafe case id in %s before any lookup, echoing nothing', async (url) => {
    let looked = false;
    const backend = new MemoryCaseBackend();
    const forTenant = backend.forTenant.bind(backend);
    backend.forTenant = (t) => {
      looked = true;
      return forTenant(t);
    };
    const { app } = await makeApp(devConfig(), { backend });
    const res = await app.inject({ method: 'GET', url });
    expect(res.statusCode).toBe(400);
    expect(res.body).toBe('{"error":"invalid-id"}');
    expect(looked).toBe(false);
    await app.close();
  });

  it.each(['/bundles/ABC', `/bundles/${'g'.repeat(64)}`, `/bundles/${'a'.repeat(63)}`])(
    'rejects the bad bundle digest in %s',
    async (url) => {
      const { app } = await makeApp(devConfig());
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'invalid-id' });
      await app.close();
    },
  );

  it('caps the JSON body size', async () => {
    const { app } = await makeApp(devConfig());
    const res = await app.inject({
      method: 'POST',
      url: '/cases',
      payload: { repoUrl: `https://github.com/${'a'.repeat(20_000)}`, commit: COMMIT },
    });
    expect(res.statusCode).toBe(413);
    expect(res.json()).toEqual({ error: 'payload-too-large' });
    await app.close();
  });

  it('malformed JSON is a fixed 400 that does not echo the input', async () => {
    const { app } = await makeApp(devConfig());
    const res = await app.inject({
      method: 'POST',
      url: '/cases',
      headers: { 'content-type': 'application/json' },
      payload: '{"repoUrl": "<img src=x onerror=alert(1)>"',
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).toBe('{"error":"bad-request"}');
    await app.close();
  });

  it('an unknown route is the same not-found body', async () => {
    const { app } = await makeApp(devConfig());
    const res = await app.inject({ method: 'GET', url: '/admin/<script>' });
    expect(res.statusCode).toBe(404);
    expect(res.body).toBe('{"error":"not-found"}');
    await app.close();
  });

  it('a backend failure is a fixed 500 with no detail', async () => {
    const backend = new MemoryCaseBackend();
    backend.forTenant = () => ({
      create: () => Promise.reject(new Error('boom postgres://u:pw@h/db')),
      get: () => Promise.reject(new Error('boom postgres://u:pw@h/db')),
      stage: () => Promise.reject(new Error('boom')),
      events: () => Promise.reject(new Error('boom')),
    });
    const { app } = await makeApp(devConfig(), { backend });
    const res = await app.inject({ method: 'GET', url: '/cases/case-x' });
    expect(res.statusCode).toBe(500);
    expect(res.body).toBe('{"error":"internal"}');
    await app.close();
  });
});

describe('rate limits', () => {
  it('limits case creation per client', async () => {
    const { app } = await makeApp(devConfig());
    const codes: number[] = [];
    for (let i = 0; i < 22; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/cases',
        payload: { repoUrl: 'https://github.com/a/b', commit: COMMIT },
      });
      codes.push(res.statusCode);
      if (res.statusCode === 429) expect(res.json()).toEqual({ error: 'rate-limited' });
    }
    expect(codes.filter((c) => c === 201)).toHaveLength(20);
    expect(codes.at(-1)).toBe(429);
    await app.close();
  });

  it('applies the global limit to reads', async () => {
    const { app } = await makeApp(devConfig({ rateLimitMax: 5 }));
    const codes: number[] = [];
    for (let i = 0; i < 7; i++) {
      codes.push((await app.inject({ method: 'GET', url: '/cases/case-x' })).statusCode);
    }
    expect(codes.slice(0, 5)).toEqual([404, 404, 404, 404, 404]);
    expect(codes.at(-1)).toBe(429);
    await app.close();
  });
});
