import {
  Escalation,
  TERMINAL_STAGES,
  TrialEvent,
  isLegalTransition,
  type BudgetState,
  type CaseId,
  type CaseStage,
  type CaseStore,
  type EventSink,
  type ModelPort,
  type Role,
  type StageCost,
} from '@affidavit/contracts';

export type ModelTurnRequest = Parameters<ModelPort['runTurn']>[0];
export type ModelTurnResult = Awaited<ReturnType<ModelPort['runTurn']>>;
export type EscalationReason = Escalation['reason'];
export type TrialEventType = TrialEvent['type'];
export type EventPayload<T extends TrialEventType> = Extract<TrialEvent, { type: T }>['payload'];

/** A request for one agent turn. Same shape as the model port's, plus who is acting. */
export interface AgentRequest extends ModelTurnRequest {
  actor: Role;
}

export type StageResult =
  | { kind: 'advance'; next: CaseStage }
  | { kind: 'escalate'; reason: EscalationReason; detail: string };

export interface StageContext {
  readonly caseId: CaseId;
  readonly stage: CaseStage;
  /** 1 for the first run of this stage, 2 for the first retry, and so on. */
  readonly attempt: number;
  /** The only way a handler reaches a model. Charges the budget before the call. */
  runAgent(req: AgentRequest): Promise<ModelTurnResult>;
  /** What model calls actually cost so far in this case, as reported by the model port. */
  costs(): readonly StageCost[];
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
}

/**
 * What `run` returns. A tripped kill switch is not an escalation and not a budget problem: the
 * case is left at its current stage, untouched, so an operator can resume it by running again.
 */
export type RunOutcome =
  | { status: 'terminal'; stage: CaseStage }
  | { status: 'halted'; stage: CaseStage; reason: 'kill-switch' };

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

/** Stages whose handlers may call a model, and the role that acts for each. */
export const MODEL_ROLE_FOR_STAGE: Readonly<Partial<Record<CaseStage, Role>>> = {
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

type StageRun = StageResult | { kind: 'halted' };

function isTerminal(stage: CaseStage): boolean {
  return TERMINAL_STAGES.includes(stage);
}

function overdrawn(b: BudgetState): boolean {
  return b.remainingUsd < 0 || b.remainingInputTokens < 0 || b.remainingOutputTokens < 0;
}

export class Orchestrator {
  private readonly ledgers = new Map<CaseId, StageCost[]>();

  constructor(private readonly deps: OrchestratorDeps) {}

  /** Runs the case from its current stage until it reaches a terminal stage or is halted. */
  async run(caseId: CaseId): Promise<RunOutcome> {
    const { store, handlers, config } = this.deps;
    let stage = await store.stage(caseId);
    let from: CaseStage | undefined;

    for (;;) {
      await this.emit(caseId, stage, 'stage-entered', from === undefined ? {} : { from });
      if (isTerminal(stage)) return { status: 'terminal', stage };

      if (await config.killSwitch()) return { status: 'halted', stage, reason: 'kill-switch' };
      const handler = handlers[stage];
      if (!handler) throw new Error(`no handler for stage ${stage}`);

      const outcome = await this.runStage(caseId, stage, handler);
      if (outcome.kind === 'halted') return { status: 'halted', stage, reason: 'kill-switch' };

      let next: CaseStage;
      if (outcome.kind === 'advance') {
        next = outcome.next;
        await store.transition(caseId, next);
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
        if (err instanceof KillSwitchError) return { kind: 'halted' };
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
      costs: () => [...this.ledger(caseId)],
    };
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
    const role = MODEL_ROLE_FOR_STAGE[stage];
    if (!role) throw new Error(`stage ${stage} never calls a model`);
    if (await config.killSwitch()) throw new KillSwitchError();

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
    await this.emit(caseId, stage, 'cost-charged', { cost: reservation, remaining }, role);
    if (overdrawn(remaining)) {
      throw new BudgetExhaustedError(
        `the charge for ${stage} attempt ${attempt} exceeds what is left of the case budget`,
      );
    }

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
    const started = now();
    const result = await model.runTurn(turn);
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

  private async escalate(
    caseId: CaseId,
    stage: CaseStage,
    reason: EscalationReason,
    detail: string,
  ): Promise<void> {
    if (!isLegalTransition(stage, 'escalated')) throw new EscalationNotAllowedError(stage, reason);
    const escalation = Escalation.parse({ schemaVersion: 1, caseId, reason, detail });
    await this.deps.store.transition(caseId, 'escalated');
    if (reason === 'budget-exhausted') {
      await this.emit(caseId, stage, 'budget-exhausted', { escalation });
    }
    await this.emit(caseId, stage, 'escalated', { escalation }, 'stenographer');
  }

  private async emit<T extends TrialEventType>(
    caseId: CaseId,
    stage: CaseStage,
    type: T,
    payload: EventPayload<T>,
    actor: Role = EVENT_ACTOR_FOR_STAGE[stage],
  ): Promise<void> {
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
  }
}
