import {
  CaseId,
  ReleaseRejectedError,
  type CaseStage,
  type CaseStore,
  type StageCost,
  type TrialEvent,
} from '@affidavit/contracts';
import { describe, expect, it } from 'vitest';
import { parseStagePayload } from './queue.js';
import { SEQ_PLACEHOLDER_BASE, stageScopedPorts } from './stage-scope.js';

const caseId = CaseId.parse('case-scope-1');

function harness(stage: CaseStage, existing: TrialEvent[] = [], withRelease = true) {
  let seq = existing.length;
  const releases: [CaseId, StageCost, number][] = [];
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
    ...(withRelease
      ? {
          releaseCharge: (id: CaseId, refund: StageCost, reservationSeq: number) => {
            releases.push([id, refund, reservationSeq]);
            return Promise.resolve(budget);
          },
        }
      : {}),
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
  return { ports: stageScopedPorts(env), emitted, releases, at: () => at };
}

const budget = {
  remainingInputTokens: 10,
  remainingOutputTokens: 10,
  remainingUsd: 1,
  exhausted: false,
};
const charge: StageCost = {
  stage: 'defense',
  attempt: 1,
  inputTokens: 100,
  outputTokens: 10,
  usd: 0.5,
  wallMs: 0,
};
const refund: StageCost = { ...charge, inputTokens: 90, outputTokens: 10, usd: 0.497 };

const costEvent = (type: 'cost-charged' | 'cost-released', seq: number, reservationSeq = 0) =>
  ({
    schemaVersion: 1,
    caseId,
    seq,
    stage: 'defense',
    at: new Date(0).toISOString(),
    actor: 'defense',
    type,
    payload:
      type === 'cost-charged'
        ? { cost: charge, remaining: budget }
        : { cost: refund, remaining: budget, reservationSeq, reason: 'model-call-failed' },
  }) as TrialEvent;

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

  it('hands out distinct placeholders and releases the stored seq of the named charge', async () => {
    // Two stage-entered events already stored, so stored seqs differ from placeholders.
    const { ports, emitted, releases } = harness('defense', [
      ev('arraign', 'stage-entered', { from: 'map' }, 0),
      ev('defense', 'stage-entered', { from: 'arraign' }, 1),
    ]);
    // A repeated stage-entered takes a placeholder and is dropped.
    await ports.sink.emit(ev('defense', 'stage-entered', {}, await ports.store.nextSeq(caseId)));
    const p1 = await ports.store.nextSeq(caseId);
    await ports.sink.emit(costEvent('cost-charged', p1));
    const p2 = await ports.store.nextSeq(caseId);
    await ports.sink.emit(costEvent('cost-charged', p2));
    expect(new Set([p1, p2]).size).toBe(2);
    expect(emitted.map((e) => [e.type, e.seq])).toEqual([
      ['stage-entered', 0],
      ['stage-entered', 1],
      ['cost-charged', 2],
      ['cost-charged', 3],
    ]);
    expect(await ports.store.releaseCharge!(caseId, refund, p2)).toEqual(budget);
    expect(releases).toEqual([[caseId, refund, 3]]);
    // The cost-released event names the stored seq too.
    await ports.sink.emit(costEvent('cost-released', await ports.store.nextSeq(caseId), p2));
    const released = emitted.at(-1)!;
    expect(released.type).toBe('cost-released');
    expect(released.seq).toBe(4);
    expect(released.type === 'cost-released' && released.payload.reservationSeq).toBe(3);
  });

  it('returns the stored seq from emit, and accepts it for a release (the real idempotency key)', async () => {
    const { ports, emitted, releases } = harness('defense', [
      ev('arraign', 'stage-entered', { from: 'map' }, 0),
    ]);
    const p = await ports.store.nextSeq(caseId);
    expect(p).toBeGreaterThanOrEqual(SEQ_PLACEHOLDER_BASE);
    const storedSeq = await ports.sink.emitStored(costEvent('cost-charged', p));
    expect(storedSeq).toBe(1);
    expect(emitted.at(-1)!.seq).toBe(1);
    // `emit` (the EventSink signature) resolves to the same stored seq at runtime.
    const p2 = await ports.store.nextSeq(caseId);
    expect(await (ports.sink.emit(costEvent('cost-charged', p2)) as Promise<unknown>)).toBe(2);
    // Released by its stored seq or by its placeholder: the inner store always sees the stored one.
    await ports.store.releaseCharge!(caseId, refund, 1);
    await ports.store.releaseCharge!(caseId, refund, p);
    await ports.store.releaseCharge!(caseId, refund, p2);
    expect(releases.map(([, , seq]) => seq)).toEqual([1, 1, 2]);
    // A stored seq that is not a cost-charged event of this job is refused.
    await expect(ports.store.releaseCharge!(caseId, refund, 0)).rejects.toBeInstanceOf(
      ReleaseRejectedError,
    );
    // A dropped event resolves to undefined.
    const { ports: again } = harness('defense', [ev('defense', 'stage-entered', {}, 0)]);
    expect(await again.sink.emitStored(ev('defense', 'stage-entered', {}))).toBeUndefined();
  });

  it('refuses a release or a cost-released that names no charge of this job', async () => {
    const { ports, emitted, releases } = harness('defense');
    const p = await ports.store.nextSeq(caseId);
    await ports.sink.emit(ev('defense', 'stage-entered', {}, p));
    // p is a stage-entered, not a charge; 99 was never handed out.
    for (const seq of [p, 99]) {
      await expect(ports.store.releaseCharge!(caseId, refund, seq)).rejects.toBeInstanceOf(
        ReleaseRejectedError,
      );
    }
    await expect(ports.sink.emit(costEvent('cost-released', 5, 99))).rejects.toThrow(
      /never charged/,
    );
    expect(releases).toEqual([]);
    expect(emitted).toHaveLength(1);
  });

  it('has no releaseCharge when the inner store has none', () => {
    const { ports } = harness('defense', [], false);
    expect('releaseCharge' in ports.store).toBe(false);
  });
});
