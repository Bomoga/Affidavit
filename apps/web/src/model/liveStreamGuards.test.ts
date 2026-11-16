import { TrialEvent } from '@affidavit/contracts';
import { readFixtureJson } from '@affidavit/testing';
import { describe, expect, it } from 'vitest';
import { createFakeTransport, type ConnectionScript } from './fakeTransport.js';
import {
  createTrialStream,
  DEFAULT_BACKOFF,
  type StreamSnapshot,
  type StreamTransport,
  type TrialStream,
} from './liveStream.js';
import { createSseTransport, isSafeBaseUrl, sseMessages } from './sseTransport.js';

const GATE = TrialEvent.array().parse(readFixtureJson('trials/nodegoat-sqli-001.events.json'));
const ESCALATED = TrialEvent.array().parse(readFixtureJson('trials/escalated-001.events.json'));
const ids = (s: StreamSnapshot) => s.events.map((e) => e.seq);
const ALL = GATE.map((e) => e.seq);
const done = (s: StreamSnapshot) => s.status === 'complete' || s.status === 'disconnected';

function settle(
  stream: TrialStream,
  pred: (s: StreamSnapshot) => boolean = done,
): Promise<StreamSnapshot> {
  return new Promise((resolve) => {
    const check = () => {
      if (pred(stream.getSnapshot())) {
        unsub();
        resolve(stream.getSnapshot());
      }
    };
    const unsub = stream.subscribe(check);
    check();
  });
}

function start(
  events: readonly TrialEvent[],
  scripts: (ConnectionScript | undefined)[],
  extra: { maxEvents?: number } = {},
) {
  const transport = createFakeTransport({ events, scripts });
  const stream = createTrialStream({
    caseId: events[0]?.caseId ?? '',
    transport,
    sleep: () => Promise.resolve(),
    ...extra,
  });
  stream.start();
  return { transport, stream };
}

describe('when the stream is finished', () => {
  const verdict = GATE.at(-1) as TrialEvent;
  const WITH_VERDICT = [
    ...ESCALATED,
    { ...verdict, caseId: ESCALATED[0]?.caseId, seq: ESCALATED.length } as TrialEvent,
  ];

  it('treats a clean close right after escalated as a drop, then reads the verdict', async () => {
    const { stream, transport } = start(WITH_VERDICT, [{ messages: ESCALATED }]);
    const s = await settle(stream);
    expect(s.status).toBe('complete');
    expect(s.events.at(-1)?.type).toBe('verdict-written');
    expect(transport.opens).toEqual([undefined, ESCALATED.length - 1]);
  });

  it('never reports complete while only escalated has arrived', async () => {
    const { stream } = start(ESCALATED, []);
    const s = await settle(stream);
    expect(s.status).toBe('disconnected');
    expect(s.events.at(-1)?.type).toBe('escalated');
  });

  it('completes as soon as the verdict is applied, even if the server keeps the stream open', async () => {
    let closed = false;
    const transport: StreamTransport = {
      // eslint-disable-next-line @typescript-eslint/require-await
      async open() {
        return (async function* () {
          try {
            for (const e of GATE) yield JSON.stringify(e);
            await new Promise<never>(() => undefined);
          } finally {
            closed = true;
          }
        })();
      },
    };
    const stream = createTrialStream({ caseId: GATE[0]?.caseId ?? '', transport });
    stream.start();
    const s = await settle(stream);
    expect(s.status).toBe('complete');
    expect(ids(s)).toEqual(ALL);
    await new Promise((r) => setTimeout(r, 0));
    expect(closed).toBe(true);
  });
});

describe('failure counting', () => {
  it('ends disconnected when every connection skips the same seq', async () => {
    const skipping = [GATE[0], GATE[1], GATE[3]].map((e) => JSON.stringify(e));
    const scripts = Array.from({ length: 30 }, () => ({ messages: skipping }));
    const { stream, transport } = start(GATE, scripts);
    const s = await settle(stream);
    expect(s.status).toBe('disconnected');
    expect(ids(s)).toEqual([0, 1]);
    expect(transport.opens.length).toBeLessThanOrEqual(DEFAULT_BACKOFF.maxAttempts + 1);
    expect(s.gapCount).toBeGreaterThanOrEqual(DEFAULT_BACKOFF.maxAttempts);
  });

  it('keeps going past maxAttempts total drops when each one makes progress', async () => {
    const drops = Array.from({ length: 40 }, () => ({ dropAfter: 1 }));
    const { stream, transport } = start(GATE, drops);
    const s = await settle(stream);
    expect(transport.opens.length).toBeGreaterThan(DEFAULT_BACKOFF.maxAttempts);
    expect(s.status).toBe('complete');
    expect(ids(s)).toEqual(ALL);
  });

  it('stops with a too-long state past the event cap and does not retry', async () => {
    const { stream } = start(GATE, [], { maxEvents: 5 });
    const s = await settle(stream);
    expect(s.status).toBe('disconnected');
    expect(s.tooLong).toBe(true);
    expect(s.events).toHaveLength(5);
    stream.retry();
    expect(stream.getSnapshot().status).toBe('disconnected');
  });
});

describe('SSE parser limits', () => {
  const enc = new TextEncoder();
  async function* bytes(parts: string[]) {
    for (const p of parts) yield await Promise.resolve(enc.encode(p));
  }
  async function drain(parts: string[], limits: { maxLine?: number; maxMessage?: number }) {
    const out: string[] = [];
    for await (const m of sseMessages(bytes(parts), limits)) out.push(m);
    return out;
  }

  it('throws on a line that never ends', async () => {
    await expect(drain(['data: ', 'x'.repeat(50)], { maxLine: 20 })).rejects.toThrow(/too long/);
  });

  it('throws on a terminated line over the cap', async () => {
    await expect(drain([`data: ${'x'.repeat(50)}\n\n`], { maxLine: 20 })).rejects.toThrow(
      /too long/,
    );
  });

  it('throws when the data lines of one message add up past the cap', async () => {
    const lines = Array.from({ length: 6 }, () => `data: ${'x'.repeat(8)}\n`).join('');
    await expect(drain([`${lines}\n`], { maxLine: 100, maxMessage: 30 })).rejects.toThrow(
      /too large/,
    );
  });

  it('lets messages under the caps through, and resets the size per message', async () => {
    const one = `data: ${'x'.repeat(8)}\n\n`;
    expect(await drain([one, one, one], { maxLine: 20, maxMessage: 12 })).toHaveLength(3);
  });

  it('a stream with an oversized message reconnects through the normal path', async () => {
    const transport: StreamTransport = createSseTransport({
      baseUrl: 'http://localhost:3000',
      limits: { maxLine: 50 },
      fetch: () =>
        Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              start(c) {
                c.enqueue(enc.encode(`data: ${'x'.repeat(200)}\n\n`));
                c.close();
              },
            }),
          ),
        ),
    });
    const stream = createTrialStream({
      caseId: 'c',
      transport,
      sleep: () => Promise.resolve(),
    });
    stream.start();
    const s = await settle(stream);
    expect(s.status).toBe('disconnected');
    expect(s.events).toEqual([]);
  });
});

describe('SSE transport request', () => {
  it('omits credentials', async () => {
    let init: RequestInit | undefined;
    const t = createSseTransport({
      baseUrl: 'http://localhost:3000',
      fetch: (_i, i) => {
        init = i;
        return Promise.resolve(new Response('', { status: 500 }));
      },
    });
    await t.open('c', undefined, new AbortController().signal).catch(() => undefined);
    expect(init?.credentials).toBe('omit');
  });

  it('refuses a base URL whose path would turn into another host', () => {
    for (const bad of [
      'http://localhost//evil.example.com',
      'https://api.example.com//evil.example.com',
    ]) {
      expect(isSafeBaseUrl(bad)).toBe(false);
      expect(() => createSseTransport({ baseUrl: bad })).toThrow();
    }
  });

  it('accepts localhost, 127.0.0.1 and [::1] over http, and clean prefixes', () => {
    for (const good of [
      'http://localhost:3000',
      'http://127.0.0.1:3000/',
      'http://[::1]:3000',
      'https://api.example.com/v1/',
    ])
      expect(isSafeBaseUrl(good)).toBe(true);
    expect(isSafeBaseUrl('http://example.com')).toBe(false);
  });

  it('keeps the request on the configured host, under the prefix', async () => {
    const urls: string[] = [];
    const t = createSseTransport({
      baseUrl: 'https://api.example.com/v1/',
      fetch: (input) => {
        urls.push(input instanceof URL ? input.href : 'other');
        return Promise.resolve(new Response('', { status: 500 }));
      },
    });
    await t.open('case-1', undefined, new AbortController().signal).catch(() => undefined);
    expect(urls).toEqual(['https://api.example.com/v1/cases/case-1/events']);
  });
});
