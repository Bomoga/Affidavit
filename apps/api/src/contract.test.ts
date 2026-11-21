import { ApiRoutes } from '@affidavit/contracts';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MemoryCaseBackend } from './memory-backend.js';
import { devConfig, makeApp, parseSse } from './test-helpers.js';

const COMMIT = 'a'.repeat(40);

describe('every response validates against ApiRoutes', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    const backend = new MemoryCaseBackend();
    backend.seedFixtures('tenant-dev');
    ({ app } = await makeApp(devConfig(), { backend }));
  });
  afterAll(async () => {
    await app.close();
  });

  it('POST /cases returns CreateCaseResponse with status 201', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/cases',
      payload: { repoUrl: 'https://github.com/OWASP/NodeGoat', commit: COMMIT },
    });
    expect(res.statusCode).toBe(201);
    const body = ApiRoutes.createCase.response.parse(res.json());
    expect(body.stage).toBe('intake');
    expect(body.caseId).toMatch(/^case-api-[0-9a-f]{12}$/);

    const got = await app.inject({ method: 'GET', url: `/cases/${body.caseId}` });
    expect(got.statusCode).toBe(200);
    const view = ApiRoutes.getCase.response.parse(got.json());
    expect(view.caseFile?.target.repo).toBe('https://github.com/OWASP/NodeGoat');
    expect(view.caseFile?.tenantId).toBe('tenant-dev');
  });

  it('GET /cases/:id returns GetCaseResponse with the verdict when one is written', async () => {
    const res = await app.inject({ method: 'GET', url: '/cases/case-nodegoat-sqli-001' });
    expect(res.statusCode).toBe(200);
    const body = ApiRoutes.getCase.response.parse(res.json());
    expect(body.stage).toBe('verdict');
    expect(body.verdict?.outcome).toBe('proven-fixed');
  });

  it('GET /cases/:id/verdict returns GetVerdictResponse', async () => {
    const res = await app.inject({ method: 'GET', url: '/cases/case-nodegoat-sqli-001/verdict' });
    expect(res.statusCode).toBe(200);
    expect(ApiRoutes.getVerdict.response.parse(res.json()).caseId).toBe('case-nodegoat-sqli-001');
  });

  it('GET /cases/:id/verdict is a fixed 404 when the case has no verdict yet', async () => {
    const res = await app.inject({ method: 'GET', url: '/cases/case-escalated-001/verdict' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'verdict-not-written' });
  });

  it('GET /cases/:id/events streams SseTrialEvent messages with id equal to seq', async () => {
    const res = await app.inject({ method: 'GET', url: '/cases/case-nodegoat-sqli-001/events' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/event-stream/);
    const { ids, events } = parseSse(res.body);
    expect(events.length).toBeGreaterThan(0);
    for (const [i, e] of events.entries()) {
      expect(ApiRoutes.caseEvents.event.parse(e)).toEqual(e);
      expect(ids[i]).toBe(String(e.seq));
    }
  });

  it('GET /bundles/:sha256 answers 501 until Lane 2 signing exists (no GetBundleResponse yet)', async () => {
    const res = await app.inject({ method: 'GET', url: `/bundles/${'b'.repeat(64)}` });
    expect(res.statusCode).toBe(501);
    expect(res.json()).toEqual({ error: 'not-implemented' });
  });

  it('POST /cases with intake disabled answers 501', async () => {
    const { app: off } = await makeApp(devConfig({ intake: 'none' }));
    const res = await off.inject({
      method: 'POST',
      url: '/cases',
      payload: { repoUrl: 'https://github.com/OWASP/NodeGoat', commit: COMMIT },
    });
    expect(res.statusCode).toBe(501);
    expect(res.json()).toEqual({ error: 'intake-not-implemented' });
    await off.close();
  });

  it.each([
    [{ repoUrl: 'https://github.com/x/y' }],
    [{ repoUrl: 'not a url', commit: COMMIT }],
    [{ repoUrl: 'javascript:alert(1)', commit: COMMIT }],
    [{ repoUrl: 'http://github.com/x/y', commit: COMMIT }],
    [{ repoUrl: 'https://user:pw@github.com/x/y', commit: COMMIT }],
    [{ repoUrl: 'https://github.com/x/y', commit: 'ABC' }],
  ])('POST /cases rejects an invalid request with a fixed body: %j', async (payload) => {
    const res = await app.inject({ method: 'POST', url: '/cases', payload });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'bad-request' });
  });
});
