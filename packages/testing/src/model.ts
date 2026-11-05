import type { ModelPort, StageCost } from '@affidavit/contracts';
import { sha256Hex } from './hash.js';

type TurnRequest = Parameters<ModelPort['runTurn']>[0];
type TurnResult = Awaited<ReturnType<ModelPort['runTurn']>>;

export class NoRecordingError extends Error {
  constructor(key: string) {
    super(`no recorded model output for ${key}`);
    this.name = 'NoRecordingError';
  }
}

export function recordingKey(promptId: string, promptVersion: string, user: string): string {
  return `${promptId}:${promptVersion}:${sha256Hex(user)}`;
}

export const ZERO_COST: Omit<StageCost, 'stage'> = {
  inputTokens: 0,
  outputTokens: 0,
  usd: 0,
  wallMs: 0,
  attempt: 1,
};

/**
 * Replays recorded agent outputs keyed by (promptId, promptVersion, hash of the user content).
 * A missing recording throws so a test never silently passes on an unscripted model call.
 */
export class ReplayModel implements ModelPort {
  readonly requests: TurnRequest[] = [];

  constructor(private readonly recordings: ReadonlyMap<string, TurnResult>) {}

  runTurn(req: TurnRequest): Promise<TurnResult> {
    this.requests.push(req);
    const key = recordingKey(req.promptId, req.promptVersion, req.user);
    const hit = this.recordings.get(key);
    if (!hit) return Promise.reject(new NoRecordingError(key));
    return Promise.resolve(hit);
  }
}
