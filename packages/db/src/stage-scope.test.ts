import { CaseId, type CaseStage, type CaseStore, type TrialEvent } from '@affidavit/contracts';
import { describe, expect, it } from 'vitest';
import { parseStagePayload } from './queue.js';
import { stageScopedPorts } from './stage-scope.js';

const caseId = CaseId.parse('case-scope-1');

function harness(stage: CaseStage, existing: TrialEvent[] = []) {
  let seq = existing.length;
  let at: CaseStage = stage;
  const emitted: TrialEvent[] = [...existing];
  const store = {
    open: () => Promise.reject(new Error('unused')),
    stage: () => Promise.resolve(at),
    transition: (_id: CaseId, to: CaseStage) => {
      at = to;
      return Promise.resolve();
    },
    chargeBudget: () => Promise.reject(new Error('unused')),
    nextSeq: () => Promise.resolve(seq++),
    appendVerdict: () => Promise.resolve(),
    getVerdict: () => Promise.resolve(null),
  } as unknown as CaseStore;
  const env = {
    job: parseStagePayload({ tenantId: 'tenant-a', caseId, stage, attempt: 1 }),
    store,
    sink: {
      emit: (e: TrialEvent) => {
        emitted.push(e);
        return Promise.resolve();
      },
    },
    events: () => Promise.resolve(emitted.filter((e) => e.stage === stage)),
  };
  return { ports: stageScopedPorts(env), emitted, at: () => at };
}

const ev = (stage: CaseStage, type: 'stage-entered' | 'stage-exited', payload: object, seq = 0) =>
  ({
    schemaVersion: 1,
    caseId,
    seq,
    stage,
    at: new Date(0).toISOString(),
    actor: 'stenographer',
    type,
    payload,
  }) as TrialEvent;

describe('stageScopedPorts', () => {
  it('drops a repeated stage-entered for the job stage and leaves no gap in seq', async () => {
    const { ports, emitted } = harness('defense', [
      ev('defense', 'stage-entered', { from: 'arraign' }),
    ]);
    await ports.sink.emit(ev('defense', 'stage-entered', {}, await ports.store.nextSeq(caseId)));
    expect(emitted).toHaveLength(1);
    await ports.sink.emit(ev('defense', 'stage-exited', { to: 'prosecution' }));
    expect(emitted.map((e) => e.seq)).toEqual([0, 1]);
  });

  it('keeps the first stage-entered of a visit that has none', async () => {
    const { ports, emitted } = harness('defense');
    await ports.sink.emit(ev('defense', 'stage-entered', {}));
    expect(emitted.map((e) => [e.type, e.seq])).toEqual([['stage-entered', 0]]);
  });

  it('reports the first transition so the driver can stop after one stage', async () => {
    const { ports, at } = harness('defense');
    expect(ports.advanced()).toBe(false);
    await ports.store.transition(caseId, 'prosecution');
    expect(ports.advanced()).toBe(true);
    expect(at()).toBe('prosecution');
  });

  it('passes the stage-entered of the next stage through after the transition', async () => {
    const { ports, emitted } = harness('defense');
    await ports.store.transition(caseId, 'prosecution');
    await ports.sink.emit(ev('prosecution', 'stage-entered', { from: 'defense' }));
    expect(emitted).toHaveLength(1);
  });

  it('refuses an event that does not parse after numbering', async () => {
    const { ports } = harness('defense');
    const bad = {
      ...ev('defense', 'stage-exited', {}),
      payload: { to: 'nowhere' },
    } as unknown as TrialEvent;
    await expect(ports.sink.emit(bad)).rejects.toThrow();
  });
});
