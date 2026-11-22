import {
  ReleaseRejectedError,
  TrialEvent,
  type CaseStage,
  type CaseStore,
  type EventSink,
} from '@affidavit/contracts';
import type { StageEnv } from './orchestration.js';

/**
 * Ports for a driver that runs a whole case loop (such as `@affidavit/trial`'s `Orchestrator.run`)
 * inside ONE stage job. Until a single-stage entry exists (CR-7), the worker runs the loop and
 * stops it after the case's first transition; these ports make that safe to repeat:
 *
 * - `advanced()` is true once `store.transition` has moved the case. The driver's stop condition
 *   (its kill switch) reads it, so one job moves the case at most one stage.
 * - A `stage-entered` event for the job's own stage is dropped when the current visit already has
 *   one (the previous job emitted it with the transition into this stage). Every other event is
 *   passed on.
 * - Sequence numbers are taken when an event is actually emitted, not when the driver asks for
 *   one, so a dropped event leaves no gap. `store.nextSeq` returns a placeholder (0, 1, 2, ...
 *   per ports instance) that the sink replaces; these two ports must be used together, and only
 *   by one driver.
 * - v1.2 (CR-T1): the driver names a charge by a seq of its `cost-charged` event. Placeholders
 *   start at 2^30 (`SEQ_PLACEHOLDER_BASE`), far above any stored seq, so the two cannot be
 *   confused. The sink remembers which stored seq each `cost-charged` event got, and `emit`
 *   resolves to that stored seq (undefined for a dropped event), so a driver can use either
 *   number: `store.releaseCharge` and a `cost-released` event's `reservationSeq` accept the
 *   placeholder or the stored seq of a `cost-charged` event emitted through this sink, and always
 *   pass on the stored seq (the idempotency key in the store). Any other seq is refused
 *   (ReleaseRejectedError), so a release can only name a charge made in the same job.
 *   `releaseCharge` is present only when the inner store has it.
 *
 * Writes still go through the job's lease-guarded ports in `env`.
 */
/** First placeholder seq; stored seqs stay far below it. */
export const SEQ_PLACEHOLDER_BASE = 2 ** 30;

/**
 * The scoped sink. `emitStored` resolves to the stored seq, or undefined when the event was
 * dropped. `emit` is the same call behind the `EventSink` type (whose result is `void`), and
 * resolves to the same value at runtime, for a driver that reads it without importing this type.
 */
export interface StageScopedSink extends EventSink {
  emitStored(event: TrialEvent): Promise<number | undefined>;
}

export interface StageScopedPorts {
  store: CaseStore;
  sink: StageScopedSink;
  advanced(): boolean;
}

export function stageScopedPorts(
  env: Pick<StageEnv, 'job' | 'store' | 'sink' | 'events'>,
): StageScopedPorts {
  const inner = env.store;
  const stage: CaseStage = env.job.stage;
  let moved = false;
  let placeholder = SEQ_PLACEHOLDER_BASE;
  // `${caseId}:${seq}` -> stored seq, for each cost-charged event emitted here, under both its
  // placeholder and its stored seq.
  const charges = new Map<string, number>();
  const stored = (caseId: string, seq: number) => charges.get(`${caseId}:${seq}`);
  const innerRelease = inner.releaseCharge?.bind(inner);
  const store: CaseStore = {
    open: (caseFile, budget) => inner.open(caseFile, budget),
    stage: (caseId) => inner.stage(caseId),
    transition: async (caseId, to) => {
      await inner.transition(caseId, to);
      moved = true;
    },
    chargeBudget: (caseId, cost) => inner.chargeBudget(caseId, cost),
    // Placeholder: the paired sink assigns the real number when it emits.
    nextSeq: () => Promise.resolve(placeholder++),
    appendVerdict: (verdict) => inner.appendVerdict(verdict),
    getVerdict: (caseId) => inner.getVerdict(caseId),
  };
  if (innerRelease) {
    store.releaseCharge = (caseId, refund, reservationSeq) => {
      const seq = stored(caseId, reservationSeq);
      if (seq === undefined) {
        return Promise.reject(
          new ReleaseRejectedError(
            caseId,
            reservationSeq,
            'no cost-charged event with that seq was emitted in this stage job',
          ),
        );
      }
      return innerRelease(caseId, refund, seq);
    };
  }
  const emitStored = async (event: TrialEvent): Promise<number | undefined> => {
    if (event.type === 'stage-entered' && event.stage === stage && !moved) {
      const seen = await env.events(event.caseId);
      if (seen.some((e) => e.type === 'stage-entered' && e.stage === stage)) return undefined;
    }
    let body: TrialEvent = event;
    if (event.type === 'cost-released') {
      const charged = stored(event.caseId, event.payload.reservationSeq);
      if (charged === undefined) {
        throw new Error(
          `cost-released names reservation ${event.payload.reservationSeq}, which this stage job never charged`,
        );
      }
      body = { ...event, payload: { ...event.payload, reservationSeq: charged } };
    }
    const seq = await inner.nextSeq(event.caseId);
    await env.sink.emit(TrialEvent.parse({ ...body, seq }));
    if (event.type === 'cost-charged') {
      // Under the driver's seq (a placeholder) and the stored seq, so either names it.
      charges.set(`${event.caseId}:${event.seq}`, seq);
      charges.set(`${event.caseId}:${seq}`, seq);
    }
    return seq;
  };
  const sink: StageScopedSink = {
    emitStored,
    emit: (event) => emitStored(event) as Promise<unknown> as Promise<void>,
  };
  return { store, sink, advanced: () => moved };
}
