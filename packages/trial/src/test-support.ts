// Shared helpers for this package's tests. Not exported from the package entry point.
import {
  CaseFile,
  CaseId,
  TrialEvent,
  samples,
  type Budget,
  type BudgetState,
  type CaseStage,
  type StageCost,
} from '@affidavit/contracts';
import { FakeCaseStore, type FakeCaseStoreOptions } from '@affidavit/testing';
import type { ModelTurnResult } from './orchestrator.js';

export const NOW = 1_700_000_000_000;

export const BIG_BUDGET: Budget = {
  maxInputTokens: 1_000_000,
  maxOutputTokens: 1_000_000,
  maxUsd: 10,
};

export function makeCaseFile(overrides: Partial<Record<string, unknown>> = {}): CaseFile {
  const base = samples.CaseFile as Record<string, unknown>;
  return CaseFile.parse({ ...base, ...overrides });
}

export const asCaseId = (s: string): CaseId => CaseId.parse(s);

/** A FakeCaseStore that also logs every charge, so tests can check ordering against the model. */
export class LoggingCaseStore extends FakeCaseStore {
  constructor(
    readonly log: string[],
    options: FakeCaseStoreOptions = {},
  ) {
    super(options);
  }

  override chargeBudget(caseId: CaseId, cost: StageCost): Promise<BudgetState> {
    this.log.push(`charge:${cost.stage}:${cost.attempt}`);
    return super.chargeBudget(caseId, cost);
  }
}

/**
 * Opens a store at `stage` by walking legal transitions from intake, so tests can start a case
 * part way through the trial without reaching into the fake.
 */
export async function openAt(
  store: FakeCaseStore,
  cf: CaseFile,
  budget: Budget,
  path: readonly CaseStage[],
): Promise<void> {
  await store.open(cf, budget);
  for (const stage of path) await store.transition(cf.id, stage);
}

export const PATH_TO = {
  defense: ['map', 'arraign', 'defense'],
  prosecution: ['map', 'arraign', 'defense', 'prosecution'],
  remedy: ['map', 'arraign', 'defense', 'prosecution', 'remedy'],
  verify: ['map', 'arraign', 'defense', 'prosecution', 'remedy', 'verify'],
} as const;

/**
 * Recordings for ReplayModel that answer in call order. Used where the prompt text is built by
 * the handler under test (feedback, rendered blocks), so the exact key is not known up front.
 * Running out still throws NoRecordingError through ReplayModel.
 */
export function inOrder(results: readonly ModelTurnResult[]): ReadonlyMap<string, ModelTurnResult> {
  const queue = [...results];
  const map = new Map<string, ModelTurnResult>();
  return new Proxy(map, {
    get(target, prop, receiver) {
      if (prop === 'get') return () => queue.shift();
      return Reflect.get(target, prop, receiver) as unknown;
    },
  });
}

export function turnCost(stage: StageCost['stage'], usd = 0.01): StageCost {
  return { stage, attempt: 1, inputTokens: 10, outputTokens: 5, usd, wallMs: 1 };
}

/** Every event must parse against the contract. Returns the parsed events. */
export function assertSchemaValid(events: readonly unknown[]): TrialEvent[] {
  return events.map((e) => TrialEvent.parse(e));
}
