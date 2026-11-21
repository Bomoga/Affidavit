import type { AddressInfo } from 'node:net';
import type { TrialEvent } from '@affidavit/contracts';
import { readFixtureJson } from '@affidavit/testing';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildFakeCaseFile, fixtureEvents } from './intake.js';
import { MemoryCaseBackend } from './memory-backend.js';
import { resumeAfter } from './sse.js';
import { devConfig, makeApp, parseSse } from './test-helpers.js';

const T = 'tenant-dev';
const ID = 'case-nodegoat-sqli-001';
/** The fixture exactly as recorded in fixtures/trials (Lane 3 owns it). */
const FIXTURE = (readFixtureJson('trials/nodegoat-sqli-001.events.json') as TrialEvent[]).map((e) =>
  JSON.stringify(e),
);

let apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.map((a) => a.close()));
  apps = [];
});

async function seeded(events: readonly TrialEvent[] = fixtureEvents('nodegoat-sqli-001', ID)) {
  const backend = new MemoryCaseBackend();
  backend.seed(buildFakeCaseFile('fixture', T, ID), events);
  const { app } = await makeApp(devConfig(), { backend });
  apps.push(app);
  return { app, backend };
}

const asJson = (events: readonly TrialEvent[]) => events.map((e) => JSON.stringify(e));

describe('GET /cases/:id/events replays the fixture stream', () => {
  it('sends the whole fixture in seq order, byte-identical events, then closes', async () => {
    const { app } = await seeded();
    const res = await app.inject({ method: 'GET', url: `/cases/${ID}/events` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const { ids, events } = parseSse(res.body);
    expect(asJson(events)).toEqual(FIXTURE);
    expect(ids).toEqual(events.map((e) => String(e.seq)));
    expect(res.body.startsWith(': affidavit trial events\nretry: 2000\n\n')).toBe(true);
  });

  it('resumes after a simulated disconnect with Last-Event-ID', async () => {
    const { app } = await seeded();
    const full = parseSse((await app.inject({ method: 'GET', url: `/cases/${ID}/events` })).body);
    // The client got the first 7 messages, then the connection dropped.
    const received = full.events.slice(0, 7);
    const lastId = full.ids[6] ?? '';
    const res = await app.inject({
      method: 'GET',
      url: `/cases/${ID}/events`,
      headers: { 'last-event-id': lastId },
    });
    const rest = parseSse(res.body).events;
    expect(rest[0]?.seq).toBe(7);
    expect(asJson([...received, ...rest])).toEqual(FIXTURE);
  });

  it('resumes with ?after=<seq>', async () => {
    const { app } = await seeded();
    const res = await app.inject({ method: 'GET', url: `/cases/${ID}/events?after=12` });
    const rest = parseSse(res.body).events;
    expect(rest.map((e) => e.seq)).toEqual(FIXTURE.slice(13).map((_, i) => 13 + i));
  });

  it('with both, the larger position wins', async () => {
    const { app } = await seeded();
    const res = await app.inject({
      method: 'GET',
      url: `/cases/${ID}/events?after=3`,
      headers: { 'last-event-id': '15' },
    });
    expect(parseSse(res.body).events[0]?.seq).toBe(16);
    expect(resumeAfter(undefined, undefined)).toBe(-1);
    expect(resumeAfter(4, undefined)).toBe(4);
    expect(resumeAfter(undefined, 9)).toBe(9);
  });

  it('a resume position at the end sends no events and closes', async () => {
    const { app } = await seeded();
    const res = await app.inject({
      method: 'GET',
      url: `/cases/${ID}/events`,
      headers: { 'last-event-id': String(FIXTURE.length - 1) },
    });
    expect(res.statusCode).toBe(200);
    expect(parseSse(res.body).events).toEqual([]);
  });

  it.each(['-1', 'abc', '01', '1.5', '99999999999', ' ', '1;2'])(
    'rejects the malformed resume position %j without echoing it',
    async (v) => {
      const { app } = await seeded();
      for (const req of [
        { headers: { 'last-event-id': v } },
        { url: `/cases/${ID}/events?after=${encodeURIComponent(v)}` },
      ]) {
        const res = await app.inject({ method: 'GET', url: `/cases/${ID}/events`, ...req });
        expect(res.statusCode).toBe(400);
        expect(res.json()).toEqual({ error: 'invalid-resume-position' });
      }
    },
  );

  it('replays the escalated fixture to the end', async () => {
    const id = 'case-escalated-001';
    const backend = new MemoryCaseBackend();
    backend.seed(buildFakeCaseFile('fixture', T, id), fixtureEvents('escalated-001', id));
    const { app } = await makeApp(devConfig(), { backend });
    apps.push(app);
    const res = await app.inject({ method: 'GET', url: `/cases/${id}/events` });
    const events = parseSse(res.body).events;
    expect(events.map((e) => e.type).at(-1)).toBe('escalated');
    expect(events).toHaveLength(7);
  });

  it('holds back an event past a hole, then skips the hole after holeWaitMs', async () => {
    const all = fixtureEvents('nodegoat-sqli-001', ID);
    const { app } = await seeded(all.filter((e) => e.seq !== 4));
    const res = await app.inject({ method: 'GET', url: `/cases/${ID}/events` });
    const seqs = parseSse(res.body).events.map((e) => e.seq);
    expect(seqs).toEqual(all.map((e) => e.seq).filter((s) => s !== 4));
  });
});

describe('a live stream over a real socket', () => {
  async function readUntil(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    count: number,
  ): Promise<string> {
    const dec = new TextDecoder();
    let text = '';
    while (parseSse(text).events.length < count) {
      const { done, value } = await reader.read();
      if (done) break;
      text += dec.decode(value, { stream: true });
    }
    return text;
  }

  it('streams new events as they are written and resumes after a real disconnect', async () => {
    const all = fixtureEvents('nodegoat-sqli-001', ID);
    // The worker has written up to seq 9 so far; the case is mid-trial.
    const { app, backend } = await seeded(all.slice(0, 10));
    await app.listen({ host: '127.0.0.1', port: 0 });
    const { port } = app.server.address() as AddressInfo;
    const url = `http://127.0.0.1:${port}/cases/${ID}/events`;

    const first = new AbortController();
    const res1 = await fetch(url, { signal: first.signal });
    expect(res1.status).toBe(200);
    const reader1 = res1.body!.getReader();
    // Read the 10 stored events, then one written live.
    const pending = readUntil(reader1, 11);
    setTimeout(() => backend instanceof MemoryCaseBackend && backend.append(T, all[10]!), 30);
    const got1 = parseSse(await pending).events;
    expect(got1.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    first.abort();
    await reader1.cancel().catch(() => undefined);

    // While the client is away the worker finishes the trial.
    for (const e of all.slice(11)) backend.append(T, e);

    const res2 = await fetch(url, { headers: { 'Last-Event-ID': '10' } });
    const got2 = parseSse(await res2.text()).events;
    expect(asJson([...got1, ...got2])).toEqual(FIXTURE);
  });

  it('caps concurrent streams per tenant and releases a slot on disconnect', async () => {
    const all = fixtureEvents('nodegoat-sqli-001', ID);
    const backend = new MemoryCaseBackend();
    backend.seed(buildFakeCaseFile('fixture', T, ID), all.slice(0, 5));
    const config = devConfig();
    const { app } = await makeApp(
      { ...config, sse: { ...config.sse, maxStreamsPerTenant: 1 } },
      {
        backend,
      },
    );
    apps.push(app);
    await app.listen({ host: '127.0.0.1', port: 0 });
    const { port } = app.server.address() as AddressInfo;
    const url = `http://127.0.0.1:${port}/cases/${ID}/events`;
    const c1 = new AbortController();
    const r1 = await fetch(url, { signal: c1.signal });
    expect(r1.status).toBe(200);
    const r2 = await fetch(url);
    expect(r2.status).toBe(429);
    expect(await r2.json()).toEqual({ error: 'too-many-streams' });
    c1.abort();
    let status = 0;
    for (let i = 0; i < 50 && status !== 200; i++) {
      await new Promise((r) => setTimeout(r, 20));
      const c = new AbortController();
      const r = await fetch(url, { signal: c.signal });
      status = r.status;
      c.abort();
      if (status !== 200) await r.body?.cancel();
    }
    expect(status).toBe(200);
  });
});
