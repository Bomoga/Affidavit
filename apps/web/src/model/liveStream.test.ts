import { TrialEvent } from '@affidavit/contracts';
import { readFixtureJson } from '@affidavit/testing';
import { describe, expect, it } from 'vitest';
import { createFakeTransport, type ConnectionScript } from './fakeTransport.js';
import {
  backoffDelay,
  createTrialStream,
  DEFAULT_BACKOFF,
  SAFE_CASE_ID,
  type InvalidEventReport,
  type StreamSnapshot,
  type TrialStream,
} from './liveStream.js';
import { createSseTransport, sseMessages } from './sseTransport.js';

const GATE = TrialEvent.array().parse(readFixtureJson('trials/nodegoat-sqli-001.events.json'));
const CASE_ID = GATE[0]?.caseId ?? '';
const ids = (s: StreamSnapshot) => s.events.map((e) => e.seq);
const ALL = GATE.map((e) => e.seq);

function settle(
  stream: TrialStream,
  done: (s: StreamSnapshot) => boolean,
): Promise<StreamSnapshot> {
  return new Promise((resolve) => {
    const check = () => {
      if (done(stream.getSnapshot())) {
        unsub();
        resolve(stream.getSnapshot());
      }
    };
    const unsub = stream.subscribe(check);
    check();
  });
}

function run(scripts: (ConnectionScript | undefined)[], extra: { honourResume?: boolean } = {}) {
  const transport = createFakeTransport({ events: GATE, scripts, ...extra });
  const invalid: InvalidEventReport[] = [];
  const stream = createTrialStream({
    caseId: CASE_ID,
    transport,
    sleep: () => Promise.resolve(),
    onInvalid: (r) => invalid.push(r),
  });
  stream.start();
  return { transport, stream, invalid };
}

const terminal = (s: StreamSnapshot) => s.status === 'complete' || s.status === 'disconnected';

describe('live trial stream', () => {
  it('replays the whole fixture and completes after the verdict', async () => {
    const { stream } = run([]);
    const s = await settle(stream, terminal);
    expect(ids(s)).toEqual(ALL);
    expect(s.status).toBe('complete');
  });

  it('resumes from the last applied seq after a mid-stream drop, with no duplicates or loss', async () => {
    const { stream, transport } = run([{ dropAfter: 7 }]);
    const s = await settle(stream, terminal);
    expect(ids(s)).toEqual(ALL);
    expect(transport.opens).toEqual([undefined, 6]);
  });

  it('shows Reconnecting while it waits to retry', async () => {
    const seen: string[] = [];
    const transport = createFakeTransport({ events: GATE, scripts: [{ dropAfter: 3 }] });
    const stream = createTrialStream({
      caseId: CASE_ID,
      transport,
      sleep: () => Promise.resolve(),
    });
    stream.subscribe(() => seen.push(stream.getSnapshot().status));
    stream.start();
    await settle(stream, terminal);
    expect(seen).toContain('live');
    expect(seen).toContain('reconnecting');
    expect(seen.at(-1)).toBe('complete');
  });

  it('ignores re-delivered duplicates and older seqs', async () => {
    const dup = [GATE[0], GATE[1], GATE[1], GATE[0], GATE[2], ...GATE.slice(3)] as TrialEvent[];
    const { stream } = run([{ messages: dup }]);
    const s = await settle(stream, terminal);
    expect(ids(s)).toEqual(ALL);
  });

  it('ignores a full replay when the transport cannot resume', async () => {
    const { stream, transport } = run([{ dropAfter: 5 }], { honourResume: false });
    const s = await settle(stream, terminal);
    expect(ids(s)).toEqual(ALL);
    expect(transport.opens).toEqual([undefined, 4]);
  });

  it('treats a seq jump as a gap, applies nothing past it, and recovers from the last good seq', async () => {
    const skipping = [GATE[0], GATE[1], GATE[2], GATE[5], GATE[6]] as TrialEvent[];
    const { stream, transport } = run([{ messages: skipping }]);
    const s = await settle(stream, terminal);
    expect(ids(s)).toEqual(ALL);
    expect(s.gapCount).toBe(1);
    expect(transport.opens).toEqual([undefined, 2]);
  });

  it('treats a stream that does not start at seq 0 as a gap', async () => {
    const { stream } = run([{ messages: GATE.slice(2) }]);
    const s = await settle(stream, terminal);
    expect(ids(s)).toEqual(ALL);
    expect(s.gapCount).toBe(1);
  });

  it('drops and reports malformed events instead of applying them', async () => {
    const good = GATE.slice(0, 3).map((e) => JSON.stringify(e));
    const msgs = [
      good[0],
      'not json {',
      JSON.stringify({ ...GATE[1], type: 'made-up' }),
      JSON.stringify({ ...GATE[1], seq: -4 }),
      JSON.stringify({ ...GATE[1], caseId: 'someone-elses-case' }),
      good[1],
      good[2],
      ...GATE.slice(3).map((e) => JSON.stringify(e)),
    ] as string[];
    const { stream, invalid } = run([{ messages: msgs }]);
    const s = await settle(stream, terminal);
    expect(ids(s)).toEqual(ALL);
    expect(s.invalidCount).toBe(4);
    expect(invalid.map((r) => r.reason)).toEqual(['not-json', 'schema', 'schema', 'wrong-case']);
  });

  it('gives up with Disconnected after the capped number of failed attempts', async () => {
    const always = Array.from({ length: 20 }, () => ({ dropAfter: 0 }));
    const { stream, transport } = run(always);
    const s = await settle(stream, terminal);
    expect(s.status).toBe('disconnected');
    expect(transport.opens.length).toBe(DEFAULT_BACKOFF.maxAttempts);
  });

  it('retry reconnects after Disconnected and keeps what was applied', async () => {
    const scripts: (ConnectionScript | undefined)[] = [
      ...Array.from({ length: DEFAULT_BACKOFF.maxAttempts }, (_, i) =>
        i === 0 ? { messages: GATE.slice(0, 3), dropAfter: 3 } : { dropAfter: 0 },
      ),
    ];
    const { stream } = run(scripts);
    const first = await settle(stream, terminal);
    expect(first.status).toBe('disconnected');
    expect(ids(first)).toEqual([0, 1, 2]);
    stream.retry();
    const s = await settle(stream, (x) => x.status === 'complete');
    expect(ids(s)).toEqual(ALL);
  });

  it('stop ends the stream without further changes', async () => {
    const { stream } = run([]);
    stream.stop();
    await Promise.resolve();
    const before = stream.getSnapshot();
    await new Promise((r) => setTimeout(r, 5));
    expect(stream.getSnapshot()).toEqual(before);
  });

  it('backs off exponentially up to a cap', () => {
    const p = { baseMs: 100, capMs: 1000, maxAttempts: 9 };
    expect([1, 2, 3, 4, 5, 9].map((n) => backoffDelay(n, p))).toEqual([
      100, 200, 400, 800, 1000, 1000,
    ]);
  });
});

describe('case id and SSE transport', () => {
  it('accepts only safe ids', () => {
    for (const ok of ['nodegoat-sqli-001', 'a_B-9', 'x'.repeat(128)])
      expect(SAFE_CASE_ID.test(ok)).toBe(true);
    for (const bad of ['', '../x', 'a/b', 'a.b', 'a%2Fb', 'a b', 'x'.repeat(129), 'a\n'])
      expect(SAFE_CASE_ID.test(bad)).toBe(false);
  });

  const enc = new TextEncoder();
  const bodyOf = (s: string) =>
    new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode(s));
        c.close();
      },
    });
  async function* bytes(parts: string[]) {
    for (const p of parts) yield await Promise.resolve(enc.encode(p));
  }
  async function all(parts: string[]) {
    const out: string[] = [];
    for await (const m of sseMessages(bytes(parts))) out.push(m);
    return out;
  }

  it('parses data fields across chunk boundaries and ignores other fields', async () => {
    expect(
      await all([': hi\n', 'id: 4\nevent: x\ndata: {"a"', ':1}\n\n', 'data: two\r\n\r\n']),
    ).toEqual(['{"a":1}', 'two']);
  });

  it('refuses an unsafe case id and builds the URL from config only', async () => {
    const calls: { url: string; headers: Headers }[] = [];
    const t = createSseTransport({
      baseUrl: 'http://localhost:3000/',
      fetch: (input, init) => {
        calls.push({
          url: input instanceof URL ? input.href : 'other',
          headers: new Headers(init?.headers),
        });
        return Promise.resolve(new Response(bodyOf('data: x\n\n')));
      },
      applyResume: ({ headers }, seq) => headers.set('Last-Event-ID', String(seq)),
    });
    const ac = new AbortController();
    await expect(t.open('../etc', undefined, ac.signal)).rejects.toThrow();
    const it1 = await t.open('case-1', 7, ac.signal);
    const got: string[] = [];
    for await (const m of it1) got.push(m);
    expect(got).toEqual(['x']);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('http://localhost:3000/cases/case-1/events');
    expect(calls[0]?.headers.get('Last-Event-ID')).toBe('7');
  });

  it('sends no resume information unless the caller supplies one', async () => {
    let seen: Headers | undefined;
    const t = createSseTransport({
      baseUrl: 'http://localhost:3000',
      fetch: (_i, init) => {
        seen = new Headers(init?.headers);
        return Promise.resolve(new Response(bodyOf('')));
      },
    });
    await t.open('c', 3, new AbortController().signal);
    expect(seen?.get('Last-Event-ID')).toBeNull();
  });

  it('answers a non-2xx response as a failed connection', async () => {
    const t = createSseTransport({
      baseUrl: 'http://localhost:3000',
      fetch: () => Promise.resolve(new Response('no', { status: 500 })),
    });
    await expect(t.open('c', undefined, new AbortController().signal)).rejects.toThrow(/500/);
  });
});
