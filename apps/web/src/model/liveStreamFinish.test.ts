import { TrialEvent } from '@affidavit/contracts';
import { readFixtureJson } from '@affidavit/testing';
import { describe, expect, it } from 'vitest';
import { createFakeTransport } from './fakeTransport.js';
import {
  createTrialStream,
  isNonRetryableStatus,
  type StreamSnapshot,
  type StreamTransport,
  type TrialStream,
} from './liveStream.js';
import { createSseTransport, sseMessages } from './sseTransport.js';

const GATE = TrialEvent.array().parse(readFixtureJson('trials/nodegoat-sqli-001.events.json'));
const CASE_ID = GATE[0]?.caseId ?? '';
const done = (s: StreamSnapshot) =>
  s.status === 'complete' || s.status === 'disconnected' || s.status === 'not-found';

function settle(stream: TrialStream, pred = done): Promise<StreamSnapshot> {
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

const tick = () => new Promise((r) => setTimeout(r, 0));

/** Index of the verify stage-exited in the fixture: everything before it stays as recorded. */
const B = GATE.findIndex((e) => e.type === 'stage-exited' && e.stage === 'verify');

/** The order `packages/trial` emits: verdict-written, then stage-exited, then stage-entered. */
function trialOrder(): TrialEvent[] {
  const base = GATE.slice(0, B);
  const verdict = GATE.find((e) => e.type === 'verdict-written') as TrialEvent;
  const exited = GATE[B] as TrialEvent;
  const enteredAt = GATE.find((e) => e.type === 'stage-entered' && e.stage === 'verify');
  const entered = { ...(enteredAt as TrialEvent), stage: 'verdict', payload: { from: 'verify' } };
  return [
    ...base,
    { ...verdict, stage: 'verify', seq: B },
    { ...exited, seq: B + 1 },
    { ...entered, seq: B + 2 },
  ] as TrialEvent[];
}

/** A server that sends `events` and then keeps the connection open forever. */
function holdOpen(events: readonly TrialEvent[]): StreamTransport {
  return {
    // eslint-disable-next-line @typescript-eslint/require-await
    async open() {
      return (async function* () {
        for (const e of events) yield JSON.stringify(e);
        await new Promise<never>(() => undefined);
      })();
    },
  };
}

const stream = (transport: StreamTransport, extra = {}) =>
  createTrialStream({ caseId: CASE_ID, transport, sleep: () => Promise.resolve(), ...extra });

describe("trial's real event order", () => {
  it('has the verdict before the final stage-exited and stage-entered', () => {
    const types = trialOrder().map((e) => e.type);
    expect(types.slice(-3)).toEqual(['verdict-written', 'stage-exited', 'stage-entered']);
  });

  it('applies every event, including the two after the verdict, before reporting complete', async () => {
    const events = trialOrder();
    const s = stream(holdOpen(events));
    s.start();
    const final = await settle(s);
    expect(final.status).toBe('complete');
    expect(final.events.map((e) => e.seq)).toEqual(events.map((e) => e.seq));
  });

  it('stays live after the verdict until the terminal stage is entered', async () => {
    const s = stream(holdOpen(trialOrder().slice(0, B + 1)));
    s.start();
    await tick();
    await tick();
    expect(s.getSnapshot().status).toBe('live');
    expect(s.getSnapshot().events).toHaveLength(B + 1);
    s.stop();
  });

  it('completes when the terminal stage-entered arrives before the verdict', async () => {
    const o = trialOrder();
    const swapped = [...o.slice(0, B), o[B + 2], o[B + 1], o[B]].map((e, seq) => ({
      ...e,
      seq,
    })) as TrialEvent[];
    const s = stream(holdOpen(swapped));
    s.start();
    const final = await settle(s);
    expect(final.status).toBe('complete');
    expect(final.events).toHaveLength(B + 3);
  });

  it('completes when the connection closes cleanly after the verdict', async () => {
    const o = trialOrder().slice(0, B + 1);
    const s = stream(createFakeTransport({ events: o, scripts: [{ messages: o }] }));
    s.start();
    const final = await settle(s);
    expect(final.status).toBe('complete');
    expect(final.events).toHaveLength(B + 1);
  });
});

describe('idle closes', () => {
  it('does not give up on clean closes that bring no events, then finishes the record', async () => {
    const scripts = Array.from({ length: 12 }, () => ({ messages: [] as string[] }));
    const transport = createFakeTransport({ events: GATE, scripts });
    const s = stream(transport);
    s.start();
    const final = await settle(s);
    expect(transport.opens.length).toBeGreaterThan(8);
    expect(final.status).toBe('complete');
    expect(final.events).toHaveLength(GATE.length);
  });

  it('still gives up when the server only ever opens and closes', async () => {
    const scripts = Array.from({ length: 50 }, () => ({ messages: [] as string[] }));
    const transport = createFakeTransport({ events: GATE, scripts });
    const s = stream(transport, {
      backoff: { baseMs: 1, capMs: 1, maxAttempts: 8, maxIdleOpens: 5 },
    });
    s.start();
    const final = await settle(s);
    expect(final.status).toBe('disconnected');
    expect(transport.opens).toHaveLength(5);
  });
});

describe('refused streams', () => {
  const responding = (status: number) => {
    let calls = 0;
    const transport = createSseTransport({
      baseUrl: 'http://localhost:3000',
      fetch: () => {
        calls += 1;
        return Promise.resolve(new Response('', { status }));
      },
    });
    return { transport, calls: () => calls };
  };

  it.each([400, 401, 403, 404, 410])('does not retry a %i', async (status) => {
    const r = responding(status);
    const s = stream(r.transport);
    s.start();
    const final = await settle(s);
    expect(final.status).toBe('not-found');
    expect(r.calls()).toBe(1);
    s.retry();
    expect(s.getSnapshot().status).toBe('not-found');
  });

  it.each([408, 429, 500, 503])('retries a %i', async (status) => {
    const r = responding(status);
    const s = stream(r.transport);
    s.start();
    const final = await settle(s);
    expect(final.status).toBe('disconnected');
    expect(r.calls()).toBe(8);
  });

  it('classifies statuses', () => {
    expect([200, 301, 404, 408, 429, 500].map(isNonRetryableStatus)).toEqual([
      false,
      false,
      true,
      false,
      false,
      false,
    ]);
  });
});

describe('SSE parser line endings', () => {
  const enc = new TextEncoder();
  async function* bytes(parts: string[]) {
    for (const p of parts) yield await Promise.resolve(enc.encode(p));
  }
  async function all(parts: string[]) {
    const out: string[] = [];
    for await (const m of sseMessages(bytes(parts))) out.push(m);
    return out;
  }

  it('reads a CR at the end of one chunk and an LF at the start of the next as one line end', async () => {
    expect(await all(['data: a\r', '\ndata: b\r\n\r', '\n'])).toEqual(['a\nb']);
  });

  it('matches the same input delivered in one chunk', async () => {
    expect(await all(['data: a\r\ndata: b\r\n\r\n'])).toEqual(['a\nb']);
  });

  it('treats a lone CR at the very end of the stream as a line end', async () => {
    expect(await all(['data: x\r\r'])).toEqual(['x']);
  });
});
