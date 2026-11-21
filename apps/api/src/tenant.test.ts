import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { githubTenantId } from './auth.js';
import { buildFakeCaseFile, fixtureEvents } from './intake.js';
import { MemoryCaseBackend } from './memory-backend.js';
import { githubConfig, makeApp, signIn, type Session } from './test-helpers.js';

const COMMIT = 'c'.repeat(40);

/**
 * Cross-tenant access at the HTTP layer. Tenant A and tenant B are two GitHub users signed in
 * through the real OAuth routes (against a fake GitHub). B must not be able to tell A's case from
 * a case that does not exist.
 */
describe('tenant isolation over HTTP (memory backend)', () => {
  let app: FastifyInstance;
  let a: Session;
  let b: Session;
  let caseA: string;
  const seededA = 'case-seeded-a';

  beforeAll(async () => {
    const backend = new MemoryCaseBackend();
    backend.seed(
      buildFakeCaseFile('fixture', githubTenantId(101), seededA),
      fixtureEvents('nodegoat-sqli-001', seededA),
    );
    ({ app } = await makeApp(githubConfig(), { backend }));
    a = await signIn(app, 101);
    b = await signIn(app, 202);
    const res = await app.inject({
      method: 'POST',
      url: '/cases',
      cookies: a.cookies,
      headers: { 'x-csrf-token': a.csrf },
      payload: { repoUrl: 'https://github.com/a/repo', commit: COMMIT },
    });
    expect(res.statusCode).toBe(201);
    caseA = res.json<{ caseId: string }>().caseId;
  });
  afterAll(async () => {
    await app.close();
  });

  const paths = (id: string) => [`/cases/${id}`, `/cases/${id}/events`, `/cases/${id}/verdict`];

  it('tenant A reads its own case, events and verdict', async () => {
    for (const url of paths(seededA)) {
      const res = await app.inject({ method: 'GET', url, cookies: a.cookies });
      expect(res.statusCode, url).toBe(200);
    }
  });

  it('tenant B gets the same 404 body for A’s case as for a missing case', async () => {
    for (const id of [seededA, caseA]) {
      for (const [i, url] of paths(id).entries()) {
        const forbidden = await app.inject({ method: 'GET', url, cookies: b.cookies });
        const missing = await app.inject({
          method: 'GET',
          url: paths('case-does-not-exist')[i] ?? '',
          cookies: b.cookies,
        });
        expect(forbidden.statusCode, url).toBe(404);
        expect(missing.statusCode).toBe(404);
        expect(forbidden.body).toBe(missing.body);
        expect(forbidden.body).toBe('{"error":"not-found"}');
        expect(forbidden.headers['content-type']).toBe(missing.headers['content-type']);
      }
    }
  });

  it('tenant B cannot resume A’s stream with Last-Event-ID or ?after', async () => {
    const res1 = await app.inject({
      method: 'GET',
      url: `/cases/${seededA}/events?after=3`,
      cookies: b.cookies,
    });
    const res2 = await app.inject({
      method: 'GET',
      url: `/cases/${seededA}/events`,
      headers: { 'last-event-id': '3' },
      cookies: b.cookies,
    });
    expect(res1.statusCode).toBe(404);
    expect(res2.statusCode).toBe(404);
    expect(res1.body).toBe('{"error":"not-found"}');
  });

  it('a case B creates is B’s, and A cannot see it', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/cases',
      cookies: b.cookies,
      headers: { 'x-csrf-token': b.csrf },
      payload: { repoUrl: 'https://github.com/b/repo', commit: COMMIT },
    });
    const caseB = res.json<{ caseId: string }>().caseId;
    const own = await app.inject({ method: 'GET', url: `/cases/${caseB}`, cookies: b.cookies });
    expect(own.json<{ caseFile: { tenantId: string } }>().caseFile.tenantId).toBe(
      githubTenantId(202),
    );
    const other = await app.inject({ method: 'GET', url: `/cases/${caseB}`, cookies: a.cookies });
    expect(other.statusCode).toBe(404);
    expect(other.body).toBe('{"error":"not-found"}');
  });

  it('an unauthenticated request is refused before any lookup', async () => {
    for (const url of paths(seededA)) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: 'unauthenticated' });
    }
  });
});
