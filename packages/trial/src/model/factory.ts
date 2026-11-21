import {
  AnthropicModelPort,
  MODEL_MODES,
  type AnthropicModelPortConfig,
  type ModelMode,
} from './anthropic.js';
import { ModelConfigError } from './errors.js';
import { resolveModelTable } from './models.js';
import { FileRecordingStore } from './recordings.js';

type Env = Readonly<Record<string, string | undefined>>;

export const MODEL_MODE_ENV_VAR = 'AFFIDAVIT_MODEL_MODE';
export const MODEL_TIMEOUT_ENV_VAR = 'AFFIDAVIT_MODEL_TIMEOUT_MS';
/** Where replay reads recordings from; defaults to `fixtures/models/`. */
export const MODEL_FIXTURES_ENV_VAR = 'AFFIDAVIT_MODEL_FIXTURES_DIR';
/** Where record mode writes. Required for record mode; there is no default. */
export const RECORD_DIR_ENV_VAR = 'AFFIDAVIT_RECORD_DIR';
/** The deployment environment. In `production` only live mode is allowed. */
export const DEPLOY_ENV_VAR = 'AFFIDAVIT_ENV';

/** Per-turn wall-clock cap when none is configured. A placeholder until real runs tune it. */
export const DEFAULT_MODEL_TIMEOUT_MS = 300_000;

export function modelModeFrom(env: Env): ModelMode {
  const raw = env[MODEL_MODE_ENV_VAR];
  if (raw === undefined || raw === '') return 'live';
  if ((MODEL_MODES as readonly string[]).includes(raw)) return raw as ModelMode;
  throw new ModelConfigError(`${MODEL_MODE_ENV_VAR} must be live, record or replay`);
}

function timeoutFrom(env: Env): number {
  const raw = env[MODEL_TIMEOUT_ENV_VAR];
  if (raw === undefined || raw === '') return DEFAULT_MODEL_TIMEOUT_MS;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1000 || n > 3_600_000) {
    throw new ModelConfigError(`${MODEL_TIMEOUT_ENV_VAR} must be an integer from 1000 to 3600000`);
  }
  return n;
}

/**
 * The real model port, configured from the environment, for the composition root
 * (`AFFIDAVIT_TRIAL_IMPL=real` in apps/worker). Reads the mode, the model table and the timeout
 * now, so bad config fails at startup. It does not read the API key: the port reads
 * `ANTHROPIC_API_KEY` on every call, and a missing key halts the case without a charge.
 */
export function createModelPortFromEnv(
  env: Env = process.env,
  overrides: Partial<AnthropicModelPortConfig> = {},
): AnthropicModelPort {
  const mode = modelModeFrom(env);
  if (mode !== 'live' && env[DEPLOY_ENV_VAR] === 'production') {
    throw new ModelConfigError(
      `${MODEL_MODE_ENV_VAR}=${mode} is refused when ${DEPLOY_ENV_VAR}=production; only live runs there`,
    );
  }
  let recordings: FileRecordingStore | undefined;
  if (mode === 'record') {
    const dir = env[RECORD_DIR_ENV_VAR];
    if (dir === undefined || dir.trim() === '') {
      throw new ModelConfigError(`${MODEL_MODE_ENV_VAR}=record needs ${RECORD_DIR_ENV_VAR} set`);
    }
    recordings = new FileRecordingStore(dir);
  } else if (mode === 'replay') {
    const dir = env[MODEL_FIXTURES_ENV_VAR];
    recordings = dir !== undefined && dir !== '' ? new FileRecordingStore(dir) : undefined;
  }
  return new AnthropicModelPort({
    mode,
    modelTable: resolveModelTable(env),
    timeoutMs: timeoutFrom(env),
    ...(recordings === undefined ? {} : { recordings }),
    ...overrides,
  });
}
