import {
  isTerminal,
  type Budget,
  type CaseStage,
  type CaseStore,
  type EscalationReason,
  type EventSink,
  type ModelPort,
  type ModelTurnRequest,
  type ModelTurnResult,
  type Role,
  type StageCost,
  type TrialEventType,
} from './interim/types.js';

/** A request for one agent turn. Same shape as the model port's, plus who is acting. */
export interface AgentRequest extends ModelTurnRequest {
  actor: Role;
}

export type StageResult =
  | { kind: 'advance'; next: CaseStage }
  | { kind: 'escalate'; reason: EscalationReason; detail: string };

export interface StageContext {
  readonly caseId: string;
  readonly stage: CaseStage;
  /** 1 for the first run of this stage, 2 for the first retry, and so on. */
  readonly attempt: number;
  /** The only way a handler reaches a model. Charges the budget before the call. */
  runAgent(req: AgentRequest): Promise<ModelTurnResult>;
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

/** Throw from a handler to run the stage again. The next agent call is charged first. */
export class RetryStageError extends Error {}

export class BudgetExhaustedError extends Error {
  constructor(readonly detail: string) {
    super(`budget exhausted: ${detail}`);
  }
}

export class KillSwitchError extends Error {
  constructor() {
    super('kill switch tripped');
  }
}

const ACTOR_FOR_STAGE: Partial<Record<CaseStage, Role>> = {
  defense: 'defense',
  prosecution: 'prosecution',
  remedy: 'remedy',
  jury: 'juror',
};

export class Orchestrator {
  constructor(private readonly deps: OrchestratorDeps) {}

  /** Runs the case from its current stage to a terminal stage and returns that stage. */
  async run(caseId: string): Promise<CaseStage> {
    const { store, handlers } = this.deps;
    for (;;) {
      const stage = await store.getStage(caseId);
      if (isTerminal(stage)) return stage;

      if (await this.deps.config.killSwitch()) {
        return this.escalate(caseId, stage, 'budget-exhausted', 'kill switch tripped');
      }
      const handler = handlers[stage];
      if (!handler) throw new Error(`no handler for stage ${stage}`);

      const outcome = await this.runStage(caseId, stage, handler);
      if (outcome.kind === 'advance') {
        await store.transition(caseId, outcome.next);
      } else {
        return this.escalate(caseId, stage, outcome.reason, outcome.detail);
      }
    }
  }

  private async runStage(
    caseId: string,
    stage: CaseStage,
    handler: StageHandler,
  ): Promise<StageResult> {
    const max = Math.max(1, this.deps.config.maxStageAttempts);
    for (let attempt = 1; ; attempt++) {
      await this.emit(caseId, stage, 'stage-entered', { attempt });
      try {
        const result = await handler.run(this.context(caseId, stage, attempt));
        await this.emit(caseId, stage, 'stage-exited', { attempt, result: result.kind });
        return result;
      } catch (err) {
        if (err instanceof BudgetExhaustedError) {
          await this.emit(caseId, stage, 'budget-exhausted', { attempt, detail: err.detail });
          return { kind: 'escalate', reason: 'budget-exhausted', detail: err.detail };
        }
        if (err instanceof KillSwitchError) {
          return { kind: 'escalate', reason: 'budget-exhausted', detail: 'kill switch tripped' };
        }
        if (err instanceof RetryStageError && attempt < max) continue;
        throw err;
      }
    }
  }

  private context(caseId: string, stage: CaseStage, attempt: number): StageContext {
    return {
      caseId,
      stage,
      attempt,
      runAgent: (req) => this.runAgent(caseId, stage, attempt, req),
    };
  }

  private async runAgent(
    caseId: string,
    stage: CaseStage,
    attempt: number,
    req: AgentRequest,
  ): Promise<ModelTurnResult> {
    const { store, model, config } = this.deps;
    const now = config.now ?? Date.now;
    if (await config.killSwitch()) throw new KillSwitchError();

    // Charge the worst case before the call, so a retry cannot spend unrecorded money.
    const reservation = reservationFor(stage, attempt, req.budget);
    const receipt = await store.chargeBudget(caseId, reservation);
    await this.emit(
      caseId,
      stage,
      'cost-charged',
      { attempt, usd: reservation.usd, remainingUsd: receipt.remainingUsd },
      req.actor,
    );
    if (receipt.remainingUsd < 0 || receipt.remainingTokens < 0) {
      await store.settleCost(caseId, receipt.chargeId, {
        ...reservation,
        usd: 0,
        inputTokens: 0,
        outputTokens: 0,
      });
      throw new BudgetExhaustedError(
        `reservation for ${stage} attempt ${attempt} exceeds the case budget`,
      );
    }

    const started = now();
    const result = await model.runTurn(req);
    const actual: StageCost = {
      ...result.cost,
      stage,
      attempt,
      wallMs: result.cost.wallMs || now() - started,
    };
    await store.settleCost(caseId, receipt.chargeId, actual);

    if (result.outcome === 'budget-exhausted') {
      throw new BudgetExhaustedError(`model reported its budget exhausted in ${stage}`);
    }
    return result;
  }

  private async escalate(
    caseId: string,
    stage: CaseStage,
    reason: EscalationReason,
    detail: string,
  ): Promise<CaseStage> {
    const { store } = this.deps;
    await store.recordEscalation({ caseId, reason, detail });
    await this.emit(caseId, stage, 'escalated', { reason, detail });
    await store.transition(caseId, 'escalated');
    return 'escalated';
  }

  private async emit(
    caseId: string,
    stage: CaseStage,
    type: TrialEventType,
    payload: Record<string, unknown>,
    actor: Role = ACTOR_FOR_STAGE[stage] ?? 'judge',
  ): Promise<void> {
    const { store, sink, config } = this.deps;
    const at = new Date((config.now ?? Date.now)()).toISOString();
    await sink.emit({
      caseId,
      seq: await store.nextSeq(caseId),
      stage,
      at,
      actor,
      type,
      payload,
    });
  }
}

function reservationFor(stage: CaseStage, attempt: number, budget: Budget): StageCost {
  return {
    stage,
    attempt,
    inputTokens: budget.maxInputTokens,
    outputTokens: budget.maxOutputTokens,
    usd: budget.maxUsd,
    wallMs: 0,
  };
}
