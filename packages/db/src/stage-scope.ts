import { TrialEvent, type CaseStage, type CaseStore, type EventSink } from '@affidavit/contracts';
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
 *   one, so a dropped event leaves no gap. `store.nextSeq` returns a placeholder (0) that the
 *   sink replaces; these two ports must be used together, and only by one driver.
 *
 * Writes still go through the job's lease-guarded ports in `env`.
 */
export interface StageScopedPorts {
  store: CaseStore;
  sink: EventSink;
  advanced(): boolean;
}

export function stageScopedPorts(
  env: Pick<StageEnv, 'job' | 'store' | 'sink' | 'events'>,
): StageScopedPorts {
  const inner = env.store;
  const stage: CaseStage = env.job.stage;
  let moved = false;
  const store: CaseStore = {
    open: (caseFile, budget) => inner.open(caseFile, budget),
    stage: (caseId) => inner.stage(caseId),
    transition: async (caseId, to) => {
      await inner.transition(caseId, to);
      moved = true;
    },
    chargeBudget: (caseId, cost) => inner.chargeBudget(caseId, cost),
    // Placeholder: the paired sink assigns the real number when it emits.
    nextSeq: () => Promise.resolve(0),
    appendVerdict: (verdict) => inner.appendVerdict(verdict),
    getVerdict: (caseId) => inner.getVerdict(caseId),
  };
  const sink: EventSink = {
    emit: async (event) => {
      if (event.type === 'stage-entered' && event.stage === stage && !moved) {
        const seen = await env.events(event.caseId);
        if (seen.some((e) => e.type === 'stage-entered' && e.stage === stage)) return;
      }
      const seq = await inner.nextSeq(event.caseId);
      await env.sink.emit(TrialEvent.parse({ ...event, seq }));
    },
  };
  return { store, sink, advanced: () => moved };
}
