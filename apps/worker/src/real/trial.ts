/**
 * REAL Lane 3 stage work (AFFIDAVIT_TRIAL_IMPL=real): defense, prosecution, remedy and verify run
 * through @affidavit/trial's `Orchestrator` and handlers on the real ModelPort. Wiring only.
 *
 * The orchestrator loops a case to the end, and there is no single-stage entry yet (CR-7). One
 * Orchestrator is built per process (it keeps the per-case cost ledger and prompt versions in
 * memory), and each stage job runs `Orchestrator.run` with the job's own lease-guarded ports,
 * routed through AsyncLocalStorage, and `stageScopedPorts` from @affidavit/db: the kill switch it
 * sees also reads "the case has moved", so one job moves the case one stage, and the repeated
 * `stage-entered` at the start of each run is not stored twice.
 *
 * A halt that did not move the case (the kill switch, or `model-unconfigured`: no API key or a
 * key the provider refused) fails the job with TrialHaltedError. Nothing is charged for a missing
 * key: the port refuses before the orchestrator charges. Recovery retries up to
 * AFFIDAVIT_MAX_STAGE_ATTEMPTS (each retry is a zero-amount cost row) and then flags the stage for
 * review. The case is never dismissed or escalated by a halt.
 *
 * Known limits, from @affidavit/trial: the hand-off between stages (`InMemoryWorkspace`) and the
 * cost ledger live in this process only, so a case whose worker restarts mid-trial fails at the
 * next stage (no admitted witness) and is flagged for review. There is no jury handler (L3-11),
 * so the jury must be disabled.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type {
  CaseFileSource,
  CaseStage,
  CaseStore,
  EventSink,
  JudgePort,
  ModelPort,
} from '@affidavit/contracts';
import { stageScopedPorts, type StageCore } from '@affidavit/db';
import { renderPrompt } from '@affidavit/prompts';
import {
  InMemoryWorkspace,
  Orchestrator,
  createDefenseHandler,
  createProsecutionHandler,
  createRemedyHandler,
  createVerifyHandler,
  modelFor,
  type HaltReason,
  type ModelTable,
} from '@affidavit/trial';
import type { TrialSettings } from '../config.js';

/** The orchestrator stopped before the stage moved the case. */
const TERMINAL: readonly CaseStage[] = ['verdict', 'dismissed', 'escalated'];

export class TrialHaltedError extends Error {
  constructor(
    readonly stage: CaseStage,
    readonly reason: HaltReason,
  ) {
    super(
      reason === 'model-unconfigured'
        ? `stage ${stage} halted: the model is not configured (ANTHROPIC_API_KEY missing or refused); nothing was charged for the refused call`
        : `stage ${stage} halted: the kill switch is on`,
    );
    this.name = 'TrialHaltedError';
  }
}

interface Scope {
  store: CaseStore;
  sink: EventSink;
  caseFiles: CaseFileSource;
  advanced(): boolean;
}

export interface TrialWiring {
  model: ModelPort;
  judge: JudgePort;
  modelTable: ModelTable;
  settings: TrialSettings;
  maxStageAttempts: number;
  /** The global kill switch (config and file). */
  killSwitch: () => boolean | Promise<boolean>;
  /** Called once this job's transition lands the case in a terminal stage. */
  caseEnded?: (caseId: string) => Promise<void>;
}

export function realTrialCores(w: TrialWiring): Partial<Record<CaseStage, StageCore>> {
  const als = new AsyncLocalStorage<Scope>();
  const scope = (): Scope => {
    const s = als.getStore();
    if (!s) throw new Error('a trial port was used outside a stage job');
    return s;
  };
  const store: CaseStore = {
    open: (cf, b) => scope().store.open(cf, b),
    stage: (id) => scope().store.stage(id),
    transition: (id, to) => scope().store.transition(id, to),
    chargeBudget: (id, c) => scope().store.chargeBudget(id, c),
    nextSeq: (id) => scope().store.nextSeq(id),
    appendVerdict: (v) => scope().store.appendVerdict(v),
    getVerdict: (id) => scope().store.getVerdict(id),
  };
  const sink: EventSink = { emit: (e) => scope().sink.emit(e) };
  const caseFiles: CaseFileSource = {
    next: (t) => scope().caseFiles.next(t),
    get: (id) => scope().caseFiles.get(id),
  };

  const s = w.settings;
  const workspace = new InMemoryWorkspace();
  const model = (id: Parameters<typeof modelFor>[1]) => modelFor(w.modelTable, id);
  const orchestrator = new Orchestrator({
    store,
    sink,
    model: w.model,
    workspace,
    handlers: {
      defense: createDefenseHandler({
        caseFiles,
        judge: w.judge,
        render: renderPrompt,
        workspace,
        config: {
          first: { promptId: 'defense', model: model('defense') },
          second: { promptId: 'defense-second-attempt', model: model('defense-second-attempt') },
          maxIterations: s.defenseIterations,
          maxTurns: s.maxAgentTurns,
          turnBudget: s.turnBudget,
        },
      }),
      prosecution: createProsecutionHandler({
        caseFiles,
        judge: w.judge,
        render: renderPrompt,
        workspace,
        config: {
          promptId: 'prosecution',
          model: model('prosecution'),
          maxCounterexamples: s.prosecutionCounterexamples,
          maxTurns: s.maxAgentTurns,
          turnBudget: s.turnBudget,
        },
      }),
      remedy: createRemedyHandler({
        caseFiles,
        judge: w.judge,
        render: renderPrompt,
        workspace,
        config: {
          promptId: 'remedy',
          model: model('remedy'),
          maxIterations: s.remedyIterations,
          maxTurns: s.maxAgentTurns,
          turnBudget: s.turnBudget,
        },
      }),
      verify: createVerifyHandler({ store, workspace, jury: 'disabled' }),
    },
    config: {
      // Stops the loop once this job's stage has moved the case, as well as on the real switch.
      killSwitch: async () => (await w.killSwitch()) || scope().advanced(),
      maxStageAttempts: w.maxStageAttempts,
    },
  });

  const core: StageCore = async (env) => {
    const ports = stageScopedPorts(env);
    const outcome = await als.run(
      {
        store: ports.store,
        sink: ports.sink,
        caseFiles: env.caseFiles,
        advanced: () => ports.advanced(),
      },
      () => orchestrator.run(env.job.caseId),
    );
    if (outcome.status === 'halted' && !ports.advanced()) {
      throw new TrialHaltedError(env.job.stage, outcome.reason);
    }
    if (w.caseEnded && TERMINAL.includes(await env.store.stage(env.job.caseId))) {
      // Best effort: a teardown failure must not undo a written verdict; the Judge keeps the case
      // tracked and retries the teardown on its next boot or release.
      await w.caseEnded(env.job.caseId).catch(() => undefined);
    }
  };

  return {
    defense: core,
    prosecution: core,
    remedy: core,
    verify: core,
    jury: () =>
      Promise.reject(
        new Error('the trial package has no jury handler yet (L3-11); run with the jury disabled'),
      ),
  };
}
