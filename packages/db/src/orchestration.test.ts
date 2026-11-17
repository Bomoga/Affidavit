import type { CaseStore, EventSink } from '@affidavit/contracts';
import { describe, expect, it } from 'vitest';
import { GuardedCaseStore, GuardedEventSink, LeaseLostError } from './orchestration.js';

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
});
