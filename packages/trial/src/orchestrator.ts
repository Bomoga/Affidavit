import {
  Escalation,
  type Dismissal,
  Halt,
  PromptId,
  RefusalCategory,
  TERMINAL_STAGES,
  TrialEvent,
  isLegalTransition,
  type BudgetState,
  type CostReleaseReason,
  type HaltReason as ContractHaltReason,
  type CaseId,
  type CaseStage,
  type CaseStore,
  type EventSink,
  type ExhibitId,
  type ModelPort,
  type Role,
  StageCost,
} from '@affidavit/contracts';
import { digestOf } from './canonical.js';
import type { SubmissionSpec } from './envelope.js';
import { ModelCallError, ModelUnconfiguredError, isModelRefusal } from './model/errors.js';
import { hasPreflight } from './model/preflight.js';
import { assertAllowedTools, type ModelRole } from './roles.js';
import { buildVerdict, finalizeVerdict } from './verdict.js';
import type { TrialWorkspace } from './workspace.js';

export type ModelTurnRequest = Parameters<ModelPort['runTurn']>[0];
export type ModelTurnResult = Awaited<ReturnType<ModelPort['runTurn']>>;
export type EscalationReason = Escalation['reason'];
export type TrialEventType = TrialEvent['type'];
export type EventPayload<T extends TrialEventType> = Extract<TrialEvent, { type: T }>['payload'];

/**
 * A request for one agent turn: the model port's request. The acting role is derived from the
 * stage (`MODEL_ROLE_FOR_STAGE`), never taken from the handler. A handler may name the actor it
 * expects; a mismatch is refused before any spend.
 */
export interface AgentRequest extends ModelTurnRequest {
  actor?: Role;
}

export type StageResult =
  | { kind: 'advance'; next: CaseStage }
  | { kind: 'escalate'; reason: EscalationReason; detail: string };

export type ValidatedAgentResult<T> =
  | { outcome: 'admitted'; value: T; result: ModelTurnResult }
  | {
      outcome: 'inadmissible';
      rule: 'schema';
      exhibitId: ExhibitId;
      errors: string[];
      result: ModelTurnResult;
    }
  | { outcome: 'no-submission'; result: ModelTurnResult };

export interface StageContext {
  readonly caseId: CaseId;
  readonly stage: CaseStage;
  /** 1 for the first run of this stage, 2 for the first retry, and so on. */
  readonly attempt: number;
  /** The only way a handler reaches a model. Charges the budget before the call. */
  runAgent(req: AgentRequest): Promise<ModelTurnResult>;
  /**
   * runAgent plus validation of the submission against the role's contract-derived schema.
   * Output that fails is recorded as an `exhibit-inadmissible` event with rule `schema` and
   * returned; it is never retried here.
   */
  runAgentValidated<R extends ModelRole, T>(
    req: AgentRequest,
    spec: SubmissionSpec<R, T>,
  ): Promise<ValidatedAgentResult<T>>;
  /** Append a schema-valid trial event for this stage. */
  record<T extends TrialEventType>(type: T, payload: EventPayload<T>, actor?: Role): Promise<void>;
  /**
   * What model calls cost so far in this case, one row per call: the call's `cost-charged`
   * events minus its `cost-released` events (CR-T1). With a working settlement that is the spend
   * the port reported; when nothing could be given back (no settlement, unknown spend, a refused
   * release) the up-front charge stands in the row, as it does in the stream.
   */
  costs(): readonly StageCost[];
  /** Prompt versions and model ids of every model call so far in this case, keyed by prompt id. */
  runInfo(): RunInfo;
}

export interface RunInfo {
  promptVersions: Partial<Record<PromptId, string>>;
  modelIds: Partial<Record<PromptId, string>>;
}

export interface StageHandler {
  run(ctx: StageContext): Promise<StageResult>;
}

export interface OrchestratorConfig {
  /**
   * Global kill switch, read before every stage and every model call. Only the real switch: a
   * tripped switch records a `halted` event with reason `kill-switch`. Use `stopAfterTransition`
   * to end a run early for any other reason.
   */
  killSwitch: () => boolean | Promise<boolean>;
  /**
   * Optional: ends the run quietly once it returns true, read at the top of each stage after its
   * `stage-entered` (and after the terminal check, so a terminal stage still writes its verdict).
   * No `halted` event, no kill-switch semantics; `run` returns `{ status: 'stopped' }`. The worker
   * uses it to move the case at most one stage per job (CR-7).
   */
  stopAfterTransition?: () => boolean | Promise<boolean>;
  /** Total runs of one stage, including the first. */
  maxStageAttempts: number;
  now?: () => number;
}

export interface OrchestratorDeps {
  store: CaseStore;
  /**
   * Any contract `EventSink`, or a sink that assigns the seq itself and reports it: its `emit`
   * may resolve to the seq it assigned, or to the stored event (CR-T1, see `ReportingEventSink`).
   */
  sink: EventSink | ReportingEventSink;
  model: ModelPort;
  handlers: Partial<Record<CaseStage, StageHandler>>;
  config: OrchestratorConfig;
  /**
   * Lane-internal hand-off store. When given, the recorded Dismissal is kept there so a dismissed
   * case whose verdict write failed can be repaired by a new Orchestrator instance.
   */
  workspace?: TrialWorkspace;
  /**
   * Gives back the unspent part of a turn's up-front charge once the port has reported what the
   * call spent, whether the call succeeded (`reservation-unspent`) or failed (`model-call-failed`)
   * (CR-T1, contracts v1.2). Optional: without it the orchestrator uses `store.releaseCharge`
   * when the store has it, and otherwise the up-front charge stands, which over-counts but never
   * under-counts.
   */
  settlement?: BudgetSettlement;
}

/**
 * A sink that assigns each event's seq itself (the worker's stage-scoped sink, whose store hands
 * out a placeholder) and resolves to the seq it assigned, or the stored event, or nothing for an
 * event it dropped. A release names its reservation by that seq, so a sink that assigns seqs must
 * report them.
 */
export interface ReportingEventSink {
  emit(event: TrialEvent): Promise<number | { seq: number } | void>;
}

/**
 * Credits a case budget with the unspent part of an up-front charge (CR-T1), with the semantics
 * of `CaseStore.releaseCharge`. `refund` holds non-negative amounts for the stage and attempt of
 * the call, never more than the reservation. `reservationSeq` is the seq of the `cost-charged`
 * event that recorded the charge being settled: an implementation must give back at most once per
 * (caseId, reservationSeq), so a replayed settle cannot mint budget.
 */
export interface BudgetSettlement {
  release(caseId: CaseId, refund: StageCost, reservationSeq: number): Promise<BudgetState>;
}

/**
 * Why a case stopped, the contracts v1.2 `HaltReason` (CR-T12). Every halt is recorded as a
 * `halted` event at the stage the case is in, and none moves the stage.
 * - `kill-switch`: the global kill switch tripped. `run` returns `halted`.
 * - `model-unconfigured`: the model port has no API key (or the provider refused it). Checked
 *   before the call's budget is charged, so nothing is spent. `run` returns `halted`.
 * - `model-refusal`: a provider safety refusal (`ModelCallError` of class `refusal`) reached the
 *   orchestrator unhandled. `run` returns `halted` with the allowlisted category. Never a
 *   dismissal.
 * - `budget-exhausted`: the budget cannot pay for the call. The `halted` event comes first, then
 *   the existing `budget-exhausted` event and Escalation; `run` returns `terminal` `escalated`.
 */
export type HaltReason = ContractHaltReason;

/** The halt reasons that end a run as `halted` (a budget halt ends it `escalated`). */
export type RunHaltReason = Exclude<HaltReason, 'budget-exhausted'>;

/**
 * What `run` returns. A halted case is left at its current stage, untouched, so an operator can
 * resume it by running again.
 */
export type RunOutcome =
  | { status: 'terminal'; stage: CaseStage }
  /** `config.stopAfterTransition` ended the run at `stage`. Nothing is recorded for it. */
  | { status: 'stopped'; stage: CaseStage }
  | {
      status: 'halted';
      stage: CaseStage;
      reason: RunHaltReason;
      /** Only with reason `model-refusal`. */
      refusalCategory?: RefusalCategory;
    };

/** Throw from a handler to run the stage again. The next agent call is charged first. */
export class RetryStageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RetryStageError';
  }
}

export class BudgetExhaustedError extends Error {
  constructor(readonly detail: string) {
    super(`budget exhausted: ${detail}`);
    this.name = 'BudgetExhaustedError';
  }
}

export class KillSwitchError extends Error {
  constructor() {
    super('kill switch tripped');
    this.name = 'KillSwitchError';
  }
}

/**
 * `STAGE_TRANSITIONS` only allows `escalated` from defense onward. Intake, map, and arraign are
 * deterministic and never call a model, so they have nothing to escalate. A handler there that
 * asks to escalate is a bug: the case stays where it is and the job fails loudly.
 */
export class EscalationNotAllowedError extends Error {
  constructor(
    readonly stage: CaseStage,
    readonly reason: EscalationReason,
  ) {
    super(`stage ${stage} cannot escalate (reason ${reason}); no legal transition to escalated`);
    this.name = 'EscalationNotAllowedError';
  }
}

/** A handler named an actor that is not the role this stage runs. Refused before any spend. */
export class ActorMismatchError extends Error {
  constructor(
    readonly stage: CaseStage,
    readonly expected: Role,
    readonly supplied: Role,
  ) {
    super(`stage ${stage} acts as ${expected}; handler asked to act as ${supplied}`);
    this.name = 'ActorMismatchError';
  }
}

/** Stages whose handlers may call a model, and the role that acts for each. */
export const MODEL_ROLE_FOR_STAGE: Readonly<Partial<Record<CaseStage, ModelRole>>> = {
  defense: 'defense',
  prosecution: 'prosecution',
  remedy: 'remedy',
  jury: 'juror',
};

/** Who an orchestrator event is attributed to by default, per stage. */
export const EVENT_ACTOR_FOR_STAGE: Readonly<Record<CaseStage, Role>> = {
  intake: 'stenographer',
  map: 'stenographer',
  arraign: 'stenographer',
  defense: 'defense',
  prosecution: 'prosecution',
  remedy: 'remedy',
  verify: 'judge',
  jury: 'juror',
  verdict: 'stenographer',
  dismissed: 'stenographer',
  escalated: 'stenographer',
};

type RunHalt = Halt & { reason: RunHaltReason };
type StageRun = StageResult | { kind: 'halted'; halt: RunHalt };

/** The allowlisted category of a provider refusal, or undefined when `err` is not one. */
function refusalOf(err: unknown): RefusalCategory | undefined {
  if (!isModelRefusal(err)) return undefined;
  const parsed = RefusalCategory.safeParse(err.provider?.refusalCategory);
  return parsed.success ? parsed.data : 'other';
}

/** Operator-facing halt text. Fixed strings only: never model output or a credential. */
const HALT_DETAIL: Readonly<Record<RunHaltReason, (stage: CaseStage) => string>> = {
  'kill-switch': (stage) => `the kill switch is on; the case waits at ${stage}`,
  'model-unconfigured': (stage) =>
    `the model is not configured; nothing was charged for the refused ${stage} call`,
  'model-refusal': (stage) => `the provider declined the ${stage} request under its usage policy`,
};

const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;

/** Per field, how far `a` is above `b` (never below zero), for the stage and attempt given. */
function excess(stage: CaseStage, attempt: number, a: StageCost, b: StageCost): StageCost {
  return {
    stage,
    attempt,
    inputTokens: Math.max(0, a.inputTokens - b.inputTokens),
    outputTokens: Math.max(0, a.outputTokens - b.outputTokens),
    usd: Math.max(0, round6(a.usd - b.usd)),
    wallMs: 0,
  };
}

function isZero(c: StageCost): boolean {
  return c.inputTokens === 0 && c.outputTokens === 0 && c.usd === 0;
}

function isTerminal(stage: CaseStage): boolean {
  return TERMINAL_STAGES.includes(stage);
}

/** A port-reported cost the orchestrator may trust: schema-valid, finite and non-negative. */
function validCost(cost: unknown): StageCost | undefined {
  const parsed = StageCost.safeParse(cost);
  if (!parsed.success) return undefined;
  const c = parsed.data;
  const nums = [c.inputTokens, c.outputTokens, c.usd, c.wallMs];
  return nums.every((n) => Number.isFinite(n) && n >= 0) ? c : undefined;
}

function overdrawn(b: BudgetState): boolean {
  return b.remainingUsd < 0 || b.remainingInputTokens < 0 || b.remainingOutputTokens < 0;
}

export class Orchestrator {
  private readonly ledgers = new Map<CaseId, StageCost[]>();
  private readonly runInfos = new Map<CaseId, RunInfo>();
  private readonly dismissals = new Map<CaseId, Dismissal>();
  /**
   * Every exhibit id this run saw submitted, resulted, or rejected, in first-seen order.
   * KNOWN GAP: in memory only, like the cost ledger. A case resumed in a new Orchestrator cites
   * only the exhibits seen after the resume. Fixing it needs a seen-exhibit record in the
   * TrialWorkspace (separate from the admitted-only getExhibits); not done here.
   */
  private readonly exhibitsSeen = new Map<CaseId, ExhibitId[]>();
  /**
   * Per case, the reservation seqs this instance already released, so a seq is never released
   * twice. Dropped when the case reaches a terminal stage, so a long-lived instance holds entries
   * only for cases still in progress.
   */
  private readonly released = new Map<CaseId, Set<number>>();
  /**
   * The last halt this instance recorded per case, until the case moves on. A halt moves no
   * stage, so the next run resumes inside the stage it already entered (no second
   * `stage-entered`), and the same halt at the same stage is recorded once, not on every rerun
   * while the kill switch stays on. Dropped on the next transition or terminal stage. In memory
   * only: a new instance emits `stage-entered` and the halt again.
   */
  private readonly haltedAt = new Map<CaseId, { stage: CaseStage; reason: HaltReason }>();
  /**
   * Per case, the highest event seq this instance saw assigned, and whether seqs proved not to be
   * unique (a seq not above the last one). A release is keyed by its reservation's seq, so when
   * seqs are not trustworthy nothing is released and the charge stands (fail closed). Dropped
   * when the case reaches a terminal stage.
   */
  private readonly seqs = new Map<
    CaseId,
    {
      last: number;
      untrusted: boolean;
      /** The sink has reported a seq for this case. */ reported: boolean;
    }
  >();

  constructor(private readonly deps: OrchestratorDeps) {}

  /** Runs the case from its current stage until it reaches a terminal stage or is halted. */
  async run(caseId: CaseId): Promise<RunOutcome> {
    const { store, handlers, config } = this.deps;
    let stage = await store.stage(caseId);
    let from: CaseStage | undefined;
    let resumed = this.haltedAt.get(caseId)?.stage === stage;
    if (!resumed) this.haltedAt.delete(caseId);

    for (;;) {
      if (!resumed) {
        await this.emit(caseId, stage, 'stage-entered', from === undefined ? {} : { from });
      }
      resumed = false;
      if (isTerminal(stage)) {
        // A terminal case must carry a verdict. If an earlier run reached this stage but failed
        // before writing it, write it now rather than leave the case closed with no verdict.
        if (stage === 'dismissed' || stage === 'escalated') {
          await this.writeTerminalVerdict(caseId, stage, stage);
        }
        this.forgetCase(caseId);
        return { status: 'terminal', stage };
      }
      // Only after this run moved the case: a stop hook that is already true cannot stop a run
      // before it has done anything.
      if (
        from !== undefined &&
        config.stopAfterTransition !== undefined &&
        (await config.stopAfterTransition())
      ) {
        return { status: 'stopped', stage };
      }

      if (await config.killSwitch()) {
        return this.halt(caseId, stage, {
          reason: 'kill-switch',
          detail: HALT_DETAIL['kill-switch'](stage),
        });
      }
      const handler = handlers[stage];
      if (!handler) throw new Error(`no handler for stage ${stage}`);
      // A verdict on a case that is still in progress means an earlier run wrote it for a
      // different ending. Rerunning agents could only contradict it, so stop.
      const early = await store.getVerdict(caseId);
      if (early !== null) {
        throw new Error(
          `case ${caseId} is at ${stage} but already has a ${early.outcome} verdict; refusing to rerun agents`,
        );
      }

      const outcome = await this.runStage(caseId, stage, handler);
      if (outcome.kind === 'halted') return this.halt(caseId, stage, outcome.halt);

      let next: CaseStage;
      if (outcome.kind === 'advance') {
        next = outcome.next;
        // Transition first, so a refused transition leaves no verdict behind. A crash between the
        // transition and the write is repaired on re-entry (see above) from the stored Dismissal.
        await store.transition(caseId, next);
        if (next === 'dismissed') await this.writeTerminalVerdict(caseId, stage, 'dismissed');
      } else {
        next = 'escalated';
        await this.escalate(caseId, stage, outcome.reason, outcome.detail);
      }
      // The case moved on, so an earlier halt no longer describes it.
      this.haltedAt.delete(caseId);
      await this.emit(caseId, stage, 'stage-exited', { to: next });
      from = stage;
      stage = next;
    }
  }

  /**
   * Drops the per-case bookkeeping once a terminal case has its verdict (called only after the
   * terminal verdict was written or found), so a long-lived instance holds state only for cases
   * still in progress. A later run of the same terminal case finds the stored verdict and needs
   * none of it.
   */
  private forgetCase(caseId: CaseId): void {
    this.released.delete(caseId);
    this.haltedAt.delete(caseId);
    this.seqs.delete(caseId);
    this.ledgers.delete(caseId);
    this.runInfos.delete(caseId);
    this.dismissals.delete(caseId);
    this.exhibitsSeen.delete(caseId);
  }

  private async runStage(
    caseId: CaseId,
    stage: CaseStage,
    handler: StageHandler,
  ): Promise<StageRun> {
    const max = Math.max(1, this.deps.config.maxStageAttempts);
    for (let attempt = 1; ; attempt++) {
      try {
        return await handler.run(this.context(caseId, stage, attempt));
      } catch (err) {
        if (err instanceof BudgetExhaustedError) {
          return { kind: 'escalate', reason: 'budget-exhausted', detail: err.detail };
        }
        if (err instanceof KillSwitchError) {
          return {
            kind: 'halted',
            halt: { reason: 'kill-switch', detail: HALT_DETAIL['kill-switch'](stage) },
          };
        }
        if (err instanceof ModelUnconfiguredError) {
          return {
            kind: 'halted',
            halt: {
              reason: 'model-unconfigured',
              detail: HALT_DETAIL['model-unconfigured'](stage),
            },
          };
        }
        // A refusal that a handler did not route says nothing about the finding, so it never
        // dismisses, and it is not retried here (the same input is likely refused again). The
        // case waits at its stage with the allowlisted category on record.
        const refusalCategory = refusalOf(err);
        if (refusalCategory !== undefined) {
          return {
            kind: 'halted',
            halt: {
              reason: 'model-refusal',
              refusalCategory,
              detail: HALT_DETAIL['model-refusal'](stage),
            },
          };
        }
        if (err instanceof RetryStageError && attempt < max) continue;
        throw err;
      }
    }
  }

  private context(caseId: CaseId, stage: CaseStage, attempt: number): StageContext {
    return {
      caseId,
      stage,
      attempt,
      runAgent: (req) => this.runAgent(caseId, stage, attempt, req),
      runAgentValidated: (req, spec) => this.runAgentValidated(caseId, stage, attempt, req, spec),
      record: async (type, payload, actor) => {
        await this.emit(caseId, stage, type, payload, actor);
      },
      costs: () => this.ledger(caseId).map((c) => ({ ...c })),
      runInfo: () => {
        const i = this.info(caseId);
        return { promptVersions: { ...i.promptVersions }, modelIds: { ...i.modelIds } };
      },
    };
  }

  private roleFor(stage: CaseStage, req: AgentRequest): ModelRole {
    const role = MODEL_ROLE_FOR_STAGE[stage];
    if (!role) throw new Error(`stage ${stage} never calls a model`);
    if (req.actor !== undefined && req.actor !== role) {
      throw new ActorMismatchError(stage, role, req.actor);
    }
    return role;
  }

  private async runAgentValidated<R extends ModelRole, T>(
    caseId: CaseId,
    stage: CaseStage,
    attempt: number,
    req: AgentRequest,
    spec: SubmissionSpec<R, T>,
  ): Promise<ValidatedAgentResult<T>> {
    const role = this.roleFor(stage, req);
    if (spec.role !== role) throw new ActorMismatchError(stage, role, spec.role);
    if (req.outputSchemaRef !== spec.schemaRef) {
      throw new Error(
        `prompt output schema ${req.outputSchemaRef} does not match ${role} submissions (${spec.schemaRef})`,
      );
    }

    const result = await this.runAgent(caseId, stage, attempt, req);
    if (result.outcome !== 'submitted') return { outcome: 'no-submission', result };

    const check = spec.check(result.submission);
    if (check.ok) return { outcome: 'admitted', value: check.value, result };

    // Name the rejected output by its content, so the record points at exactly what was refused.
    const exhibitId = `exhibit-${spec.exhibitKind}-rejected-${digestOf({
      caseId,
      stage,
      attempt,
      submission: result.submission,
    }).slice(0, 24)}` as ExhibitId;
    await this.emit(
      caseId,
      stage,
      'exhibit-inadmissible',
      { exhibitId, rejectedBy: 'schema' },
      'judge',
    );
    return { outcome: 'inadmissible', rule: 'schema', exhibitId, errors: check.errors, result };
  }

  private info(caseId: CaseId): RunInfo {
    let i = this.runInfos.get(caseId);
    if (!i) {
      i = { promptVersions: {}, modelIds: {} };
      this.runInfos.set(caseId, i);
    }
    return i;
  }

  private ledger(caseId: CaseId): StageCost[] {
    let l = this.ledgers.get(caseId);
    if (!l) {
      l = [];
      this.ledgers.set(caseId, l);
    }
    return l;
  }

  private async runAgent(
    caseId: CaseId,
    stage: CaseStage,
    attempt: number,
    req: AgentRequest,
  ): Promise<ModelTurnResult> {
    const { store, model, config } = this.deps;
    const now = config.now ?? Date.now;
    const role = this.roleFor(stage, req);
    assertAllowedTools(role, req.tools);
    const promptId = PromptId.safeParse(req.promptId);
    if (!promptId.success) throw new Error(`unknown prompt id ${req.promptId}`);
    const info = this.info(caseId);
    const seenVersion = info.promptVersions[promptId.data];
    const seenModel = info.modelIds[promptId.data];
    if (
      (seenVersion !== undefined && seenVersion !== req.promptVersion) ||
      (seenModel !== undefined && seenModel !== req.model)
    ) {
      throw new Error(
        `prompt ${promptId.data} already ran as ${seenVersion} on ${seenModel} in this case; a verdict can record only one`,
      );
    }
    if (await config.killSwitch()) throw new KillSwitchError();

    const turn: ModelTurnRequest = {
      promptId: req.promptId,
      promptVersion: req.promptVersion,
      model: req.model,
      system: req.system,
      user: req.user,
      tools: req.tools,
      outputSchemaRef: req.outputSchemaRef,
      maxTurns: req.maxTurns,
      budget: req.budget,
    };
    // A port that can refuse a call without spending (no API key, unknown model) does so before
    // the charge, so a missing key halts the case with nothing charged.
    if (hasPreflight(model)) await model.preflight(turn);

    // Charge the turn's whole budget before the call, so a retry cannot spend unrecorded money.
    // The model port is held to the same budget, so what it spends cannot exceed this charge.
    const reservation: StageCost = {
      stage,
      attempt,
      inputTokens: req.budget.maxInputTokens,
      outputTokens: req.budget.maxOutputTokens,
      usd: req.budget.maxUsd,
      wallMs: 0,
    };
    const remaining = await store.chargeBudget(caseId, reservation);
    const reservationSeq = await this.emit(
      caseId,
      stage,
      'cost-charged',
      { cost: reservation, remaining },
      role,
    );
    // This call's row in the ledger: the reservation until a settlement moves it, so the ledger
    // always nets exactly the charges and releases the event stream records.
    const row: StageCost = { ...reservation };
    this.ledger(caseId).push(row);
    if (overdrawn(remaining)) {
      throw new BudgetExhaustedError(
        `the charge for ${stage} attempt ${attempt} exceeds what is left of the case budget`,
      );
    }

    // Recorded per call, keyed by prompt id, so the verdict lists exactly the prompts that ran.
    info.promptVersions[promptId.data] = req.promptVersion;
    info.modelIds[promptId.data] = req.model;
    const started = now();
    let result: ModelTurnResult;
    try {
      result = await model.runTurn(turn);
    } catch (err) {
      const replacement = await this.settleFailedCall(
        caseId,
        stage,
        attempt,
        role,
        reservation,
        reservationSeq,
        row,
        err,
        started,
      );
      throw replacement ?? err;
    }
    // A reported cost that is not a valid StageCost with finite, non-negative numbers is unknown
    // spend, as on the failure path: nothing is charged or released and the whole charge stands.
    const reported = validCost(result.cost);
    if (reported === undefined) {
      row.wallMs = Math.max(0, now() - started);
      if (result.outcome === 'budget-exhausted') {
        throw new BudgetExhaustedError(`the model reported its turn budget exhausted in ${stage}`);
      }
      return result;
    }
    const actual: StageCost = {
      ...reported,
      stage,
      attempt,
      wallMs: reported.wallMs || Math.max(0, now() - started),
    };
    row.wallMs = actual.wallMs;

    // A port that overspends its own budget is charged the difference; what it did not spend is
    // given back (reason `reservation-unspent`). A release that fails leaves the charge standing
    // and does not fail a call that succeeded: the stream and the ledger both keep the charge.
    const settled = await this.settleCall(
      caseId,
      stage,
      attempt,
      role,
      reservation,
      reservationSeq,
      actual,
      row,
      'reservation-unspent',
    );
    if (settled.overdrawn) {
      throw new BudgetExhaustedError(`the model overspent its turn budget in ${stage}`);
    }

    if (result.outcome === 'budget-exhausted') {
      throw new BudgetExhaustedError(`the model reported its turn budget exhausted in ${stage}`);
    }
    return result;
  }

  /** The settlement to use: the one wired in, else the store's own `releaseCharge`, else none. */
  private settlement(): BudgetSettlement | undefined {
    if (this.deps.settlement !== undefined) return this.deps.settlement;
    const store = this.deps.store;
    if (typeof store.releaseCharge !== 'function') return undefined;
    return { release: (caseId, refund, seq) => store.releaseCharge!(caseId, refund, seq) };
  }

  /**
   * Settles a reservation against the spend the port reported, per field: an overage is charged
   * on top (a `cost-charged` event) and the unspent part is released (a `cost-released` event
   * with `reason`, emitted only after the release succeeded). `row` moves by exactly what the
   * stream records, so the ledger and the stream net to the same figures. An overage charge that
   * fails throws. A release that fails (`ReleaseRejectedError`, a store error, a refund that is
   * not a valid StageCost, an invalid budget returned) is returned as `releaseError`, emits
   * nothing and leaves `row` alone: the charge stands. With no settlement nothing is released.
   */
  private async settleCall(
    caseId: CaseId,
    stage: CaseStage,
    attempt: number,
    role: Role,
    reservation: StageCost,
    reservationSeq: number | undefined,
    actual: StageCost,
    row: StageCost,
    reason: CostReleaseReason,
  ): Promise<{ overdrawn: boolean; releaseError?: unknown }> {
    const overage = excess(stage, attempt, actual, reservation);
    let overdrew = false;
    if (!isZero(overage)) {
      const after = await this.deps.store.chargeBudget(caseId, overage);
      await this.emit(caseId, stage, 'cost-charged', { cost: overage, remaining: after }, role);
      row.inputTokens += overage.inputTokens;
      row.outputTokens += overage.outputTokens;
      row.usd = round6(row.usd + overage.usd);
      overdrew = overdrawn(after);
    }

    // Not rounded: a release gives back exactly the unspent part, so a sub-micro-dollar spend
    // (5e-7) still shows in the stream and the verdict instead of rounding away to zero.
    // Capped at the reservation here, field by field, whatever the store would allow.
    const gap = excess(stage, attempt, reservation, actual);
    const unspent: StageCost = {
      ...gap,
      inputTokens: Math.min(gap.inputTokens, reservation.inputTokens),
      outputTokens: Math.min(gap.outputTokens, reservation.outputTokens),
      usd: Math.min(Math.max(0, reservation.usd - actual.usd), reservation.usd),
    };
    const settlement = this.settlement();
    let releasedSeqs = this.released.get(caseId);
    if (isZero(unspent) || settlement === undefined) return { overdrawn: overdrew };
    if (reservationSeq !== undefined && releasedSeqs?.has(reservationSeq)) {
      return { overdrawn: overdrew };
    }
    if (reservationSeq === undefined || this.seqs.get(caseId)?.untrusted !== false) {
      // The store keys a release by the reservation's seq. With no seq (the sink dropped the
      // charge event) or seqs that are not unique (a sink that assigns the real seq and does not
      // return it), a release would name the wrong charge, so nothing is released.
      return {
        overdrawn: overdrew,
        releaseError: new Error(
          'event seqs are not unique for this case, so the reservation cannot be named; the charge stands',
        ),
      };
    }
    let refund: StageCost;
    let remaining: BudgetState;
    try {
      refund = StageCost.parse(unspent);
      remaining = await settlement.release(caseId, refund, reservationSeq);
    } catch (releaseError) {
      return { overdrawn: overdrew, releaseError };
    }
    // Released in the store: never release this seq again, even if the event below fails.
    if (releasedSeqs === undefined) {
      releasedSeqs = new Set();
      this.released.set(caseId, releasedSeqs);
    }
    releasedSeqs.add(reservationSeq);
    try {
      await this.emit(
        caseId,
        stage,
        'cost-released',
        { cost: refund, remaining, reservationSeq, reason },
        role,
      );
    } catch (emitError) {
      // The store gave the budget back but the stream has no record of it. Keep the row at the
      // charge, so the verdict agrees with the stream (over-counting, never under-counting).
      return { overdrawn: overdrew, releaseError: emitError };
    }
    // The released fields now net to exactly what the call spent. Snapped to `actual` rather
    // than subtracted, so a float difference cannot make the verdict show a cost nobody reported.
    if (refund.inputTokens > 0) row.inputTokens = actual.inputTokens;
    if (refund.outputTokens > 0) row.outputTokens = actual.outputTokens;
    if (refund.usd > 0) row.usd = actual.usd;
    return { overdrawn: overdrew };
  }

  /**
   * A call that failed after its up-front charge. When the port reported what the call spent
   * (`ModelCallError.cost`, a valid `StageCost` with finite, non-negative numbers), the
   * reservation is settled against it as on success, with reason `model-call-failed`: an overage
   * is charged and the unspent part is given back. When the spend is unknown (a timeout, an
   * abort, a broken stream, any other error, or a reported cost that is not valid), nothing is
   * given back: the whole charge stands, in the stream and in the ledger.
   *
   * Returns the error the call should end with instead of the original: only a
   * `BudgetExhaustedError` when the overage charge overdraws the case, as on the success path.
   * A failure while settling never replaces the call's own error; it is attached to it as
   * `settlementError`, and the charge stays (over-counting, never under-counting).
   */
  private async settleFailedCall(
    caseId: CaseId,
    stage: CaseStage,
    attempt: number,
    role: Role,
    reservation: StageCost,
    reservationSeq: number | undefined,
    row: StageCost,
    err: unknown,
    started: number,
  ): Promise<Error | undefined> {
    const now = this.deps.config.now ?? Date.now;
    const reported = err instanceof ModelCallError ? validCost(err.cost) : undefined;
    if (!(err instanceof ModelCallError) || reported === undefined) {
      row.wallMs = Math.max(0, now() - started);
      return undefined;
    }
    const actual: StageCost = {
      ...reported,
      stage,
      attempt,
      wallMs: reported.wallMs || Math.max(0, now() - started),
    };
    row.wallMs = actual.wallMs;
    try {
      const settled = await this.settleCall(
        caseId,
        stage,
        attempt,
        role,
        reservation,
        reservationSeq,
        actual,
        row,
        'model-call-failed',
      );
      if (settled.releaseError !== undefined) err.settlementError = settled.releaseError;
      if (settled.overdrawn) {
        return new BudgetExhaustedError(`the model overspent its turn budget in ${stage}`);
      }
    } catch (settleErr) {
      err.settlementError = settleErr;
    }
    return undefined;
  }

  /** Records a halt at `stage` (a `halted` event, no stage change) and returns the outcome. */
  private async halt(caseId: CaseId, stage: CaseStage, halt: RunHalt): Promise<RunOutcome> {
    const prior = this.haltedAt.get(caseId);
    // Once per case: a rerun that halts again at the same stage for the same reason (the kill
    // switch still on) records nothing new.
    if (prior?.stage !== stage || prior.reason !== halt.reason) {
      await this.emit(caseId, stage, 'halted', Halt.parse(halt), 'stenographer');
    }
    this.haltedAt.set(caseId, { stage, reason: halt.reason });
    return {
      status: 'halted',
      stage,
      reason: halt.reason,
      ...(halt.refusalCategory === undefined ? {} : { refusalCategory: halt.refusalCategory }),
    };
  }

  private async escalate(
    caseId: CaseId,
    stage: CaseStage,
    reason: EscalationReason,
    detail: string,
  ): Promise<void> {
    if (!isLegalTransition(stage, 'escalated')) throw new EscalationNotAllowedError(stage, reason);
    const escalation = Escalation.parse({ schemaVersion: 1, caseId, reason, detail });
    // Crash gap: the transition comes first, so a crash before the events below leaves an
    // escalated case with no `escalated` event. The verdict is repaired on rerun (see run());
    // the missing events are not.
    if (reason === 'budget-exhausted') {
      // CR-T12: say why the trial stopped calling models. A halt moves no stage and never
      // replaces the `budget-exhausted` event and its Escalation below.
      const halt = Halt.parse({ reason: 'budget-exhausted', detail });
      await this.emit(caseId, stage, 'halted', halt, 'stenographer');
    }
    await this.deps.store.transition(caseId, 'escalated');
    if (reason === 'budget-exhausted') {
      await this.emit(caseId, stage, 'budget-exhausted', { escalation });
    }
    await this.emit(caseId, stage, 'escalated', { escalation }, 'stenographer');
    await this.writeTerminalVerdict(caseId, stage, 'escalated');
  }

  /**
   * A case that ends dismissed or escalated still gets a contract Verdict, built structurally
   * from what actually happened: every exhibit seen (inadmissible ones included), the prompts and
   * models that ran, and the recorded cost. The summary is generated from it and checked.
   */
  private async writeTerminalVerdict(
    caseId: CaseId,
    stage: CaseStage,
    outcome: 'dismissed' | 'escalated',
  ): Promise<void> {
    const existing = await this.deps.store.getVerdict(caseId);
    if (existing !== null) {
      if (existing.outcome === outcome) return;
      throw new Error(
        `case ${caseId} ended ${outcome} but already has a ${existing.outcome} verdict`,
      );
    }
    // A dismissed verdict needs the recorded contract Dismissal it summarizes, from this run or
    // read back from the workspace. Without one, refuse to invent it.
    if (outcome === 'dismissed') {
      const dismissal =
        this.dismissals.get(caseId) ?? (await this.deps.workspace?.getDismissal(caseId));
      if (!dismissal) {
        throw new Error(
          `case ${caseId} is dismissed but no recorded dismissal was found; not writing a dismissed verdict`,
        );
      }
    }
    const { promptVersions, modelIds } = this.info(caseId);
    const verdict = finalizeVerdict(
      buildVerdict({
        caseId,
        outcome,
        exhibits: this.exhibitsSeen.get(caseId) ?? [],
        promptVersions,
        modelIds,
        cost: this.ledger(caseId),
      }),
    );
    await this.deps.store.appendVerdict(verdict);
    await this.emit(caseId, stage, 'verdict-written', { verdict }, 'stenographer');
  }

  private noteExhibits(event: TrialEvent): void {
    let id: ExhibitId | undefined;
    if (event.type === 'exhibit-submitted' || event.type === 'exhibit-inadmissible') {
      id = event.payload.exhibitId;
    } else if (event.type === 'exhibit-result') id = event.payload.result.exhibitId;
    if (id === undefined) return;
    const list = this.exhibitsSeen.get(event.caseId) ?? [];
    if (!list.includes(id)) list.push(id);
    this.exhibitsSeen.set(event.caseId, list);
  }

  private async emit<T extends TrialEventType>(
    caseId: CaseId,
    stage: CaseStage,
    type: T,
    payload: EventPayload<T>,
    actor: Role = EVENT_ACTOR_FOR_STAGE[stage],
  ): Promise<number | undefined> {
    const { store, sink, config } = this.deps;
    const at = new Date((config.now ?? Date.now)()).toISOString();
    // Parse before emitting so a malformed event is a bug here, not a surprise downstream.
    const event = TrialEvent.parse({
      schemaVersion: 1,
      caseId,
      seq: await store.nextSeq(caseId),
      stage,
      at,
      actor,
      type,
      payload,
    });
    // The contract sink returns nothing, but a sink that assigns the seq itself (the worker's
    // stage-scoped sink, whose store hands out a placeholder) may return the stored event or its
    // seq. That is the seq a release must name.
    const returned: unknown = await sink.emit(event);
    const seq = this.assigned(caseId, event, assignedSeq(returned));
    this.noteExhibits(event);
    if (event.type === 'dismissed') {
      // Kept where another instance can read it back, so a dismissed case can be repaired.
      this.dismissals.set(caseId, event.payload.dismissal);
      await this.deps.workspace?.saveDismissal(caseId, event.payload.dismissal);
    }
    return seq;
  }

  /**
   * The seq an emitted event got, or undefined when the sink dropped it, and the trust record.
   * - The sink reported a seq: that one. A `stage-entered` whose reported seq is not above the
   *   last one is the duplicate a stage-scoped sink drops (it may report the seq of the event it
   *   duplicates); it is not noted. Any other event with such a seq marks the case's seqs
   *   untrustworthy, so nothing is released for it again (fail closed).
   * - The sink reported nothing, after it has reported a seq for this case: the event was
   *   dropped. Nothing is noted, so a dropped duplicate never poisons the record.
   * - The sink has never reported a seq for this case (a contract `EventSink`): the seq parsed
   *   from `store.nextSeq`, held to the same strictly increasing rule. A `stage-entered` that is
   *   the first event this instance sees for the case is not noted (it may be a dropped duplicate
   *   carrying the store's placeholder, as on a worker job after a restart).
   */
  private assigned(
    caseId: CaseId,
    event: TrialEvent,
    reported: number | undefined,
  ): number | undefined {
    const s = this.seqs.get(caseId);
    if (reported === undefined) {
      if (s?.reported === true) return undefined;
      // The first event this instance emits for a case is the `stage-entered` that starts the
      // job. A stage-scoped sink drops it when it duplicates the stored one and reports nothing,
      // so its parsed seq is the store's placeholder. Noting it would make every real seq after
      // it look out of order and disable release, so it is not noted.
      if (s === undefined && event.type === 'stage-entered') return event.seq;
      this.noteSeq(caseId, event.seq, false);
      return event.seq;
    }
    if (event.type === 'stage-entered' && s !== undefined && reported <= s.last) return undefined;
    this.noteSeq(caseId, reported, true);
    return reported;
  }

  /** Records a seq; one that is not above the last seen marks the case's seqs unusable. */
  private noteSeq(caseId: CaseId, seq: number, reported: boolean): void {
    const s = this.seqs.get(caseId);
    if (s === undefined) {
      this.seqs.set(caseId, { last: seq, untrusted: false, reported });
      return;
    }
    if (reported) s.reported = true;
    if (seq <= s.last) s.untrusted = true;
    else s.last = seq;
  }
}

/** The seq a sink reports it assigned: a non-negative integer, or a stored event carrying one. */
function assignedSeq(returned: unknown): number | undefined {
  const ok = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 0;
  if (ok(returned)) return returned;
  if (typeof returned === 'object' && returned !== null) {
    const seq = (returned as { seq?: unknown }).seq;
    if (ok(seq)) return seq;
  }
  return undefined;
}
