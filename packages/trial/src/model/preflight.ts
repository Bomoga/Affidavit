import type { ModelPort } from '@affidavit/contracts';

type TurnRequest = Parameters<ModelPort['runTurn']>[0];

/**
 * A model port that can say, before the orchestrator charges any budget, whether a call can run.
 * The orchestrator calls `preflight` when the port has one. This is a Lane 3 extension of the
 * contract `ModelPort`, not a contract change: ports without it behave as before.
 */
export interface PreflightModelPort extends ModelPort {
  preflight(req: TurnRequest): Promise<void>;
}

export function hasPreflight(model: ModelPort): model is PreflightModelPort {
  return typeof (model as Partial<PreflightModelPort>).preflight === 'function';
}
