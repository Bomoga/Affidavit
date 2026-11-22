/**
 * REAL Lane 3 stage work (AFFIDAVIT_TRIAL_IMPL=real): defense, prosecution, remedy and verify run
 * through @affidavit/trial's `Orchestrator` and handlers on the real ModelPort. Wiring only.
 *
 * The orchestrator loops a case to the end, and there is no single-stage entry yet (CR-7). One
 * Orchestrator is built per process (it keeps the per-case cost ledger and prompt versions in
 * memory), and each stage job runs `Orchestrator.run` with the job's own lease-guarded ports,
 * routed through AsyncLocalStorage, and `stageScopedPorts` from @affidavit/db: the orchestrator
 * stops once the case has moved (`stopAfterTransition`, with no event), so one job moves the case
 * one stage, and the repeated `stage-entered` at the start of each run is not stored twice.
 *
 * A halt that did not move the case fails the job with TrialHaltedError, whose message names the
 * reason. Nothing is charged for a missing key: the port refuses before the orchestrator charges.
 * For `kill-switch` and `model-unconfigured`, recovery retries up to AFFIDAVIT_MAX_STAGE_ATTEMPTS
 * (each retry is a zero-amount cost row) and then flags the stage for review. A `model-refusal`
 * halt (for example a Defense refusal below the escalation floor on the `review` route, whose
 * `DefenseRefusedError` the orchestrator turns into the halt) is not retried: the stage is flagged
 * for review at once (`reviewReason`). A refusal thrown past the orchestrator is mapped the same
 * way. The case is never dismissed or escalated by a halt. `AFFIDAVIT_REFUSAL_ROUTE`
 * (`settings.refusalRoute`) picks what a first Defense refusal does: `review` (the default) or
 * `second-attempt` (the second Defense model and prompt, at any score).
 *
 * Settlement (contracts v1.2, CR-T1): the orchestrator charges each model turn up front at the
 * turn cap. When a call fails and the port reported what it spent, the orchestrator gives the
 * unspent part back through `settlement.release`, wired here to the job store's `releaseCharge`
 * (an insert-only `cost_releases` row; the budget is read net of releases). The store also
 * exposes `releaseCharge` directly; both reach the same idempotent call.
 *
 * Known limits, from @affidavit/trial: the hand-off between stages (`InMemoryWorkspace`) and the
 * cost ledger live in this process only, so a case whose worker restarts mid-trial fails at the
 * next stage (no admitted witness) and is flagged for review. There is no jury handler (L3-11),
 * so the jury must be disabled.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type {
  BudgetState,
  CaseFileSource,
  CaseId,
  CaseStage,
  CaseStore,
  HaltReason as ContractHaltReason,
  JudgePort,
  ModelPort,
  StageCost,
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
  isModelRefusal,
  modelFor,
  type ModelTable,
  type ReportingEventSink,
} from '@affidavit/trial';
import type { TrialSettings } from '../config.js';

/** The orchestrator stopped before the stage moved the case. */
const TERMINAL: readonly CaseStage[] = ['verdict', 'dismissed', 'escalated'];

/** What the job error says for each halt reason. Names variables only, never values. */
function haltMessage(stage: CaseStage, reason: ContractHaltReason): string {
  switch (reason) {
    case 'model-unconfigured':
      return `stage ${stage} halted: the model is not configured (ANTHROPIC_API_KEY missing or refused); nothing was charged for the refused call`;
    case 'kill-switch':
      return `stage ${stage} halted: the kill switch is on`;
    case 'model-refusal':
      return `stage ${stage} halted: the model refused the request on safety grounds; flagged for review, not retried (a retry asks the same model again)`;
    case 'budget-exhausted':
      return `stage ${stage} halted: the case budget is exhausted`;
    default:
      return `stage ${stage} halted (${String(reason)})`;
  }
}

/**
 * A halt that did not move the case. `model-refusal` is not retryable: it carries
 * `reviewReason`, so `@affidavit/db`'s stage handler flags the stage for review at once instead of
 * letting recovery retry it. Every other reason is retried as an ordinary failure.
 */
export class TrialHaltedError extends Error {
  readonly reviewReason: 'model-refusal' | undefined;

  constructor(
    readonly stage: CaseStage,
    readonly reason: ContractHaltReason,
  ) {
    super(haltMessage(stage, reason));
    this.name = 'TrialHaltedError';
    this.reviewReason = reason === 'model-refusal' ? 'model-refusal' : undefined;
  }
}

interface Scope {
  store: CaseStore;
  /** The stage-scoped sink resolves to the stored seq (undefined for a dropped event). */
  sink: ReportingEventSink;
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
  // v1.2 (CR-T1): give back the unspent part of an up-front charge through the job's own store
  // (stage-scoped, lease-guarded, tenant-scoped PgCaseStore). The seq is the one the orchestrator
  // got for its `cost-charged` event; the stage-scoped store maps it to the stored seq. A store
  // without releaseCharge refuses, and the orchestrator keeps the charge (over-counting).
  const release = (id: CaseId, refund: StageCost, seq: number): Promise<BudgetState> => {
    const s = scope().store;
    if (!s.releaseCharge) {
      return Promise.reject(new Error('this case store cannot release a charge'));
    }
    return s.releaseCharge(id, refund, seq);
  };
  const store: CaseStore = {
    open: (cf, b) => scope().store.open(cf, b),
    stage: (id) => scope().store.stage(id),
    transition: (id, to) => scope().store.transition(id, to),
    chargeBudget: (id, c) => scope().store.chargeBudget(id, c),
    releaseCharge: (id, r, seq) => release(id, r, seq),
    nextSeq: (id) => scope().store.nextSeq(id),
    appendVerdict: (v) => scope().store.appendVerdict(v),
    getVerdict: (id) => scope().store.getVerdict(id),
  };
  const sink: ReportingEventSink = { emit: (e) => scope().sink.emit(e) };
  const caseFiles: CaseFileSource = {
    next: (t) => scope().caseFiles.next(t),
    get: (id) => scope().caseFiles.get(id),
  };

  const s = w.settings;
  const workspace = new InMemoryWorkspace();
  const model = (id: Parameters<typeof modelFor>[1]) => modelFor(w.modelTable, id);
  // One job moves the case one stage: `stopAfterTransition` ends the run once this job's
  // transition has landed, with no event (the run returns `stopped`). The kill switch is the real
  // switch only, so moving the case is never reported as a halt.
  const deps: ConstructorParameters<typeof Orchestrator>[0] = {
    store,
    sink,
    model: w.model,
    workspace,
    settlement: { release },
    config: {
      killSwitch: w.killSwitch,
      stopAfterTransition: () => scope().advanced(),
      maxStageAttempts: w.maxStageAttempts,
    },
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
          refusalRoute: s.refusalRoute,
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
  };
  const orchestrator = new Orchestrator(deps);

  const core: StageCore = async (env) => {
    const ports = stageScopedPorts(env);
    const outcome = await als
      .run(
        {
          store: ports.store,
          sink: ports.sink,
          caseFiles: env.caseFiles,
          advanced: () => ports.advanced(),
        },
        () => orchestrator.run(env.job.caseId),
      )
      .catch((err: unknown) => {
        // The orchestrator turns a provider refusal into a `model-refusal` halt. Should one ever
        // escape it as a thrown error, it is still review, never a retry of the refused model.
        if (isModelRefusal(err) && !ports.advanced()) {
          throw new TrialHaltedError(env.job.stage, 'model-refusal');
        }
        throw err;
      });
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
