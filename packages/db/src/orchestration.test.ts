import type { CaseStore, EventSink } from '@affidavit/contracts';
import { describe, expect, it } from 'vitest';
import {
  GuardedCaseStore,
  GuardedEventSink,
  LeaseLostError,
  NeedsReviewError,
  reviewReasonOf,
  stageHandler,
} from './orchestration.js';
import { parseStagePayload, type StageContext } from './queue.js';
import type { AppPool } from './tenant.js';

describe('reviewReasonOf', () => {
  it('reads a valid review reason from any error, and nothing from an ordinary one', () => {
    expect(reviewReasonOf(new NeedsReviewError('model-refusal', 'refused'))).toBe('model-refusal');
    expect(reviewReasonOf(Object.assign(new Error('x'), { reviewReason: 'model-refusal' }))).toBe(
      'model-refusal',
    );
    expect(reviewReasonOf(Object.assign(new Error('x'), { reviewReason: 'dismiss' }))).toBe(
      undefined,
    );
    expect(reviewReasonOf(new Error('x'))).toBeUndefined();
    expect(reviewReasonOf('model-refusal')).toBeUndefined();
  });

  it('accepts only the reasons stage work may raise, not those recovery or intake write', () => {
    for (const r of ['f3-hold', 'attempts-exhausted', 'budget-exhausted']) {
      expect(reviewReasonOf(Object.assign(new Error('x'), { reviewReason: r })), r).toBeUndefined();
    }
  });
});

describe('stageHandler, non-retryable failures', () => {
  it('rethrows the stage work error even when flagging it for review fails, and logs that', async () => {
    const down = new Error('database unreachable');
    // A pool that cannot be reached: stageAttemptState (and so the flag) fails.
    const pool = {
      connect: () => Promise.reject(down),
      query: () => Promise.reject(down),
    } as unknown as AppPool;
    const refusal = new NeedsReviewError('model-refusal', 'the model refused');
    const logs: string[] = [];
    const handler = stageHandler(() => Promise.reject(refusal), {
      appPool: pool,
      log: (m) => logs.push(m),
    });
    const ctx = {
      workerId: 'w',
      signal: new AbortController().signal,
      inTenantTx: () => Promise.reject(new Error('not reached')),
      complete: () => Promise.reject(new Error('not reached')),
    } as unknown as StageContext;
    const job = parseStagePayload({ tenantId: 't', caseId: 'c', stage: 'defense', attempt: 1 });
    await expect(handler(job, ctx)).rejects.toBe(refusal);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/could not flag defense attempt 1 .*model-refusal/);

    // An ordinary error is rethrown untouched, with no flag attempted.
    const plain = new Error('boom');
    const quiet = stageHandler(() => Promise.reject(plain), {
      appPool: pool,
      log: (m) => logs.push(m),
    });
    await expect(quiet(job, ctx)).rejects.toBe(plain);
    expect(logs).toHaveLength(1);
  });
});

describe('lease guard', () => {
  it('refuses every port write once the signal aborted, but still reads', async () => {
    const calls: string[] = [];
    const inner = {
      open: () => Promise.resolve(calls.push('open')),
      stage: () => Promise.resolve('map'),
      transition: () => Promise.resolve(calls.push('transition')),
      chargeBudget: () => Promise.resolve(calls.push('chargeBudget')),
      nextSeq: () => Promise.resolve(calls.push('nextSeq')),
      appendVerdict: () => Promise.resolve(calls.push('appendVerdict')),
      getVerdict: () => Promise.resolve(null),
    } as unknown as CaseStore;
    const sink = { emit: () => Promise.resolve(calls.push('emit')) } as unknown as EventSink;
    const abort = new AbortController();
    const store = new GuardedCaseStore(inner, abort.signal);
    const guardedSink = new GuardedEventSink(sink, abort.signal);
    // Before the abort every write passes through.
    await store.transition('c' as never, 'map');
    expect(calls).toEqual(['transition']);
    abort.abort();
    const writes: (() => Promise<unknown>)[] = [
      () => Promise.resolve().then(() => store.open({} as never, {} as never)),
      () => Promise.resolve().then(() => store.transition('c' as never, 'map')),
      () => Promise.resolve().then(() => store.chargeBudget('c' as never, {} as never)),
      () => Promise.resolve().then(() => store.nextSeq('c' as never)),
      () => Promise.resolve().then(() => store.appendVerdict({} as never)),
      () => Promise.resolve().then(() => guardedSink.emit({} as never)),
    ];
    for (const w of writes) await expect(w()).rejects.toBeInstanceOf(LeaseLostError);
    expect(calls).toEqual(['transition']);
    expect(await store.stage('c' as never)).toBe('map');
    expect(await store.getVerdict('c' as never)).toBeNull();
  });

  it('forwards releaseCharge only when the inner store has it, and guards it like a charge', async () => {
    const calls: unknown[][] = [];
    const base = {
      stage: () => Promise.resolve('defense'),
      getVerdict: () => Promise.resolve(null),
    };
    const budget = {
      remainingInputTokens: 1,
      remainingOutputTokens: 1,
      remainingUsd: 1,
      exhausted: false,
    };
    const inner = {
      ...base,
      releaseCharge: (...args: unknown[]) => {
        calls.push(args);
        return Promise.resolve(budget);
      },
    } as unknown as CaseStore;
    const abort = new AbortController();
    const store = new GuardedCaseStore(inner, abort.signal);
    const refund = {
      stage: 'defense',
      attempt: 1,
      inputTokens: 1,
      outputTokens: 0,
      usd: 0.1,
      wallMs: 0,
    } as const;
    expect(await store.releaseCharge!('c' as never, refund, 7)).toEqual(budget);
    expect(calls).toEqual([['c', refund, 7]]);
    abort.abort();
    await expect(
      Promise.resolve().then(() => store.releaseCharge!('c' as never, refund, 7)),
    ).rejects.toBeInstanceOf(LeaseLostError);
    expect(calls).toHaveLength(1);

    const without = new GuardedCaseStore(
      base as unknown as CaseStore,
      new AbortController().signal,
    );
    expect(without.releaseCharge).toBeUndefined();
  });
});
