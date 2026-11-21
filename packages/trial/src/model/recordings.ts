import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PromptId, StageCost } from '@affidavit/contracts';
import { canonicalJson, sha256Hex } from '../canonical.js';
import type { ModelTurnRequest, ModelTurnResult } from '../orchestrator.js';
import { NoModelRecordingError } from './errors.js';
import { redactDeep } from './redact.js';

/** Where recorded agent outputs live by default: `fixtures/models/` at the repo root (Lane 3). */
export const DEFAULT_RECORDINGS_DIR = resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '../../../../fixtures/models',
);

const OUTCOMES = ['submitted', 'no-submission', 'budget-exhausted', 'turn-cap'] as const;

/**
 * The hash a recording is keyed by, together with the prompt id. It covers everything that
 * shapes the agent's answer (prompt version, model, system text, user content, tools, schema,
 * turn cap, budget), so a recording is never served for a request that differs from the one
 * recorded.
 */
export function inputSha256(req: ModelTurnRequest): string {
  return sha256Hex(
    canonicalJson({
      promptVersion: req.promptVersion,
      model: req.model,
      system: req.system,
      user: req.user,
      tools: [...req.tools],
      outputSchemaRef: req.outputSchemaRef,
      maxTurns: req.maxTurns,
      budget: req.budget,
    }),
  );
}

/**
 * One recorded turn. Only the agent's output and its usage are stored: never the API key, never a
 * request header, never the request itself beyond the hashes and ids that key it.
 */
export interface ModelRecording {
  schemaVersion: 1;
  promptId: PromptId;
  promptVersion: string;
  model: string;
  inputSha256: string;
  userSha256: string;
  result: ModelTurnResult;
}

export interface RecordingStore {
  read(req: ModelTurnRequest): Promise<ModelTurnResult>;
  write(req: ModelTurnRequest, result: ModelTurnResult, secrets: readonly string[]): Promise<void>;
}

function safeSegment(promptId: string): PromptId {
  // Prompt ids are a closed enum, so they are safe as a directory name.
  return PromptId.parse(promptId);
}

function parseRecording(raw: unknown, req: ModelTurnRequest, hash: string): ModelTurnResult {
  const r = raw as Partial<ModelRecording> | null;
  const result = r?.result as Partial<ModelTurnResult> | undefined;
  const cost = StageCost.safeParse(result?.cost);
  if (
    r?.schemaVersion !== 1 ||
    r.promptId !== req.promptId ||
    r.inputSha256 !== hash ||
    result === undefined ||
    !(OUTCOMES as readonly unknown[]).includes(result.outcome) ||
    !cost.success
  ) {
    throw new Error(`recording for prompt ${req.promptId} input ${hash} is malformed`);
  }
  const out: ModelTurnResult = { outcome: result.outcome!, cost: cost.data };
  if ('submission' in result) out.submission = result.submission;
  return out;
}

/** Recordings as JSON files: `<dir>/<prompt id>/<input sha256>.json`. */
export class FileRecordingStore implements RecordingStore {
  constructor(readonly dir: string = DEFAULT_RECORDINGS_DIR) {}

  private path(req: ModelTurnRequest, hash: string): string {
    return join(this.dir, safeSegment(req.promptId), `${hash}.json`);
  }

  read(req: ModelTurnRequest): Promise<ModelTurnResult> {
    const hash = inputSha256(req);
    let text: string;
    try {
      text = readFileSync(this.path(req, hash), 'utf8');
    } catch {
      return Promise.reject(new NoModelRecordingError(req.promptId, hash));
    }
    try {
      return Promise.resolve(parseRecording(JSON.parse(text), req, hash));
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
  }

  write(req: ModelTurnRequest, result: ModelTurnResult, secrets: readonly string[]): Promise<void> {
    const hash = inputSha256(req);
    const recording: ModelRecording = {
      schemaVersion: 1,
      promptId: safeSegment(req.promptId),
      promptVersion: req.promptVersion,
      model: req.model,
      inputSha256: hash,
      userSha256: sha256Hex(req.user),
      result: redactDeep(result, secrets) as ModelTurnResult,
    };
    const file = this.path(req, hash);
    mkdirSync(join(this.dir, recording.promptId), { recursive: true });
    // Write then rename, so a crash never leaves a half-written recording behind.
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(recording, null, 2)}\n`, 'utf8');
    renameSync(tmp, file);
    return Promise.resolve();
  }
}
