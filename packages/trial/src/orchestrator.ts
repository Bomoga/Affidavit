import {
  Escalation,
  type Dismissal,
  PromptId,
  TERMINAL_STAGES,
  TrialEvent,
  isLegalTransition,
  type BudgetState,
  type CaseId,
  type CaseStage,
  type CaseStore,
  type EventSink,
  type ExhibitId,
  type ModelPort,
  type Role,
  type StageCost,
} from '@affidavit/contracts';
import { digestOf } from './canonical.js';
import type { SubmissionSpec } from './envelope.js';
import { ModelCallError, ModelUnconfiguredError } from './model/errors.js';
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
  /** What model calls actually cost so far in this case, as reported by the model port. */
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
  /** Global kill switch, read before every stage and every model call. */
  killSwitch: () => boolean | Promise<boolean>;
  /** Total runs of one stage, including the first. */
  maxStageAttempts: number;
  now?: () => number;
}

export interface OrchestratorDeps {
  store: CaseStore;
  sink: EventSink;
  model: ModelPort;
  handlers: Partial<Record<CaseStage, StageHandler>>;
  config: OrchestratorConfig;
  /**
   * Lane-internal hand-off store. When given, the recorded Dismissal is kept there so a dismissed
   * case whose verdict write failed can be repaired by a new Orchestrator instance.
   */
  workspace?: TrialWorkspace;
  /**
   * Gives back the unspent part of a turn's up-front charge when a model call failed and the
   * port reported what it actually spent (CR-T1). Optional: without it the up-front charge
   * stands, which over-counts but never under-counts. The composition root wires it once the
   * case store can credit a charge.
   */
  settlement?: BudgetSettlement;
}

/**
 * Credits a case budget with the unspent part of an up-front charge (CR-T1). `refund` holds
 * non-negative amounts for the stage and attempt of the failed call. `reservationSeq` is the seq
 * of the `cost-charged` event that recorded the charge being settled: an implementation must give
 * back at most once per (caseId, reservationSeq), so a replayed settle cannot mint budget.
 */
export interface BudgetSettlement {
  release(caseId: CaseId, refund: StageCost, reservationSeq: number): Promise<BudgetState>;
}

/**
 * Why a run stopped without finishing. Neither is an escalation or a budget problem.
 * - `kill-switch`: the global kill switch tripped.
 * - `model-unconfigured`: the model port has no API key (or the provider refused it). Checked
 *   before the call's budget is charged, so nothing is spent.
 */
export type HaltReason = 'kill-switch' | 'model-unconfigured';

/**
 * What `run` returns. A halted case is left at its current stage, untouched, so an operator can
 * resume it by running again.
 */
export type RunOutcome =
  | { status: 'terminal'; stage: CaseStage }
  | { status: 'halted'; stage: CaseStage; reason: HaltReason };

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

type StageRun = StageResult | { kind: 'halted'; reason: HaltReason };

function isTerminal(stage: CaseStage): boolean {
  return TERMINAL_STAGES.includes(stage);
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

  constructor(private readonly deps: OrchestratorDeps) {}

  /** Runs the case from its current stage until it reaches a terminal stage or is halted. */
  async run(caseId: CaseId): Promise<RunOutcome> {
    const { store, handlers, config } = this.deps;
    let stage = await store.stage(caseId);
    let from: CaseStage | undefined;

    for (;;) {
      await this.emit(caseId, stage, 'stage-entered', from === undefined ? {} : { from });
      if (isTerminal(stage)) {
        // A terminal case must carry a verdict. If an earlier run reached this stage but failed
        // before writing it, write it now rather than leave the case closed with no verdict.
        if (stage === 'dismissed' || stage === 'escalated') {
          await this.writeTerminalVerdict(caseId, stage, stage);
        }
        return { status: 'terminal', stage };
      }

      if (await config.killSwitch()) return { status: 'halted', stage, reason: 'kill-switch' };
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
      if (outcome.kind === 'halted') return { status: 'halted', stage, reason: outcome.reason };

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
      await this.emit(caseId, stage, 'stage-exited', { to: next });
      from = stage;
      stage = next;
    }
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
        if (err instanceof KillSwitchError) return { kind: 'halted', reason: 'kill-switch' };
        if (err instanceof ModelUnconfiguredError) {
          return { kind: 'halted', reason: 'model-unconfigured' };
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
      costs: () => [...this.ledger(caseId)],
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
      await this.settleFailedCall(
        caseId,
        stage,
        attempt,
        reservation,
        reservationSeq,
        err,
        started,
      );
      throw err;
    }
    const actual: StageCost = {
      ...result.cost,
      stage,
      attempt,
      wallMs: result.cost.wallMs || now() - started,
    };
    this.ledger(caseId).push(actual);

    // A port that overspends its own budget is charged the difference, never refunded.
    const overage: StageCost = {
      stage,
      attempt,
      inputTokens: Math.max(0, actual.inputTokens - reservation.inputTokens),
      outputTokens: Math.max(0, actual.outputTokens - reservation.outputTokens),
      usd: Math.max(0, Math.round((actual.usd - reservation.usd) * 1e6) / 1e6),
      wallMs: 0,
    };
    if (overage.inputTokens > 0 || overage.outputTokens > 0 || overage.usd > 0) {
      const after = await store.chargeBudget(caseId, overage);
      await this.emit(caseId, stage, 'cost-charged', { cost: overage, remaining: after }, role);
      if (overdrawn(after)) {
        throw new BudgetExhaustedError(`the model overspent its turn budget in ${stage}`);
      }
    }

    if (result.outcome === 'budget-exhausted') {
      throw new BudgetExhaustedError(`the model reported its turn budget exhausted in ${stage}`);
    }
    return result;
  }

  /**
   * A call that failed after its up-front charge. When the port reported what the call spent
   * (`ModelCallError.cost`), that figure goes in the ledger, so the verdict reports what calls
   * cost rather than what was reserved, and the unspent part of the charge is given back through
   * `settlement` when one is wired. When the spend is unknown (a timeout, an abort, a broken
   * stream, any other error), nothing changes: the whole charge stands.
   */
  private async settleFailedCall(
    caseId: CaseId,
    stage: CaseStage,
    attempt: number,
    reservation: StageCost,
    reservationSeq: number,
    err: unknown,
    started: number,
  ): Promise<void> {
    if (!(err instanceof ModelCallError) || err.cost === undefined) return;
    const now = this.deps.config.now ?? Date.now;
    const actual: StageCost = {
      ...err.cost,
      stage,
      attempt,
      wallMs: err.cost.wallMs || Math.max(0, now() - started),
    };
    this.ledger(caseId).push(actual);
    // A failed call that spent more than its charge is charged the difference, as on success.
    const overage: StageCost = {
      stage,
      attempt,
      inputTokens: Math.max(0, actual.inputTokens - reservation.inputTokens),
      outputTokens: Math.max(0, actual.outputTokens - reservation.outputTokens),
      usd: Math.max(0, Math.round((actual.usd - reservation.usd) * 1e6) / 1e6),
      wallMs: 0,
    };
    if (overage.inputTokens > 0 || overage.outputTokens > 0 || overage.usd > 0) {
      const after = await this.deps.store.chargeBudget(caseId, overage);
      const role = MODEL_ROLE_FOR_STAGE[stage] ?? EVENT_ACTOR_FOR_STAGE[stage];
      await this.emit(caseId, stage, 'cost-charged', { cost: overage, remaining: after }, role);
    }
    const settlement = this.deps.settlement;
    if (settlement === undefined) return;
    const refund: StageCost = {
      stage,
      attempt,
      inputTokens: Math.max(0, reservation.inputTokens - actual.inputTokens),
      outputTokens: Math.max(0, reservation.outputTokens - actual.outputTokens),
      usd: Math.max(0, Math.round((reservation.usd - actual.usd) * 1e6) / 1e6),
      wallMs: 0,
    };
    if (refund.inputTokens === 0 && refund.outputTokens === 0 && refund.usd === 0) return;
    try {
      await settlement.release(caseId, refund, reservationSeq);
    } catch {
      // A refund that cannot be written leaves the whole charge in place: the budget over-counts
      // and never under-counts. The call's own error is the one the job reports.
    }
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
  ): Promise<number> {
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
    await sink.emit(event);
    this.noteExhibits(event);
    if (event.type === 'dismissed') {
      // Kept where another instance can read it back, so a dismissed case can be repaired.
      this.dismissals.set(caseId, event.payload.dismissal);
      await this.deps.workspace?.saveDismissal(caseId, event.payload.dismissal);
    }
    return event.seq;
  }
}
