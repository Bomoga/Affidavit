import { readFileSync } from 'node:fs';
import { PromptId } from '@affidavit/contracts';
import { ModelConfigError } from './errors.js';

/**
 * Claude model ids this port will send. Anything else fails closed: a typo in config must never
 * become a request to a model nobody chose. Extend the list in a reviewed change.
 */
export const KNOWN_MODEL_IDS = [
  'claude-opus-5-5',
  'claude-opus-5',
  'claude-opus-4-8',
  'claude-opus-4-7',
  'claude-opus-4-6',
  'claude-sonnet-5-5',
  'claude-sonnet-5',
  'claude-sonnet-4-6',
  'claude-haiku-5-5',
  'claude-haiku-4-5',
  'claude-fable-5-2',
  'claude-fable-5-1',
  'claude-fable-5',
] as const;
export type KnownModelId = (typeof KNOWN_MODEL_IDS)[number];

export function isKnownModelId(id: string): id is KnownModelId {
  return (KNOWN_MODEL_IDS as readonly string[]).includes(id);
}

export type ModelTable = Readonly<Record<PromptId, KnownModelId>>;

/**
 * Defaults per prompt id. The second Defense attempt runs on a different model than the first
 * (F3), and the three jurors run on three different models (F4). These are starting choices, not
 * tuned ones; calibration (L3-12) decides once real runs exist.
 */
export const DEFAULT_MODEL_TABLE: ModelTable = {
  defense: 'claude-opus-5-5',
  'defense-second-attempt': 'claude-sonnet-5-5',
  prosecution: 'claude-opus-5-5',
  remedy: 'claude-opus-5-5',
  'juror-security': 'claude-opus-5-5',
  'juror-maintainability': 'claude-sonnet-5-5',
  'juror-blast-radius': 'claude-haiku-5-5',
};

/** The environment variable that overrides each prompt's model. */
export const MODEL_ENV_VARS: Readonly<Record<PromptId, string>> = {
  defense: 'ANTHROPIC_MODEL_DEFENSE',
  'defense-second-attempt': 'ANTHROPIC_MODEL_DEFENSE_SECOND',
  prosecution: 'ANTHROPIC_MODEL_PROSECUTION',
  remedy: 'ANTHROPIC_MODEL_REMEDY',
  'juror-security': 'ANTHROPIC_MODEL_JUROR_SECURITY',
  'juror-maintainability': 'ANTHROPIC_MODEL_JUROR_MAINTAINABILITY',
  'juror-blast-radius': 'ANTHROPIC_MODEL_JUROR_BLAST_RADIUS',
};

/** Path to an optional JSON file `{ "models": { "<prompt id>": "<model id>" } }`. */
export const MODEL_CONFIG_ENV_VAR = 'AFFIDAVIT_MODEL_CONFIG';

const JURORS = ['juror-security', 'juror-maintainability', 'juror-blast-radius'] as const;

type Env = Readonly<Record<string, string | undefined>>;

/** Throws unless the table keeps the independence rules: F3 for Defense and F4 for the jury. */
export function checkModelTable(table: Record<string, string>): ModelTable {
  const problems: string[] = [];
  for (const id of PromptId.options) {
    const model = table[id];
    if (model === undefined) problems.push(`no model for prompt ${id}`);
    else if (!isKnownModelId(model)) problems.push(`unknown model id for prompt ${id}`);
  }
  for (const key of Object.keys(table)) {
    if (!PromptId.safeParse(key).success) problems.push('model table names an unknown prompt id');
  }
  if (table.defense !== undefined && table.defense === table['defense-second-attempt']) {
    problems.push('the second Defense attempt must use a different model than the first');
  }
  const jurorModels = JURORS.map((j) => table[j]);
  if (new Set(jurorModels).size !== JURORS.length) {
    problems.push('each juror must use a different model');
  }
  if (problems.length > 0)
    throw new ModelConfigError(`model table refused: ${problems.join('; ')}`);
  return table as ModelTable;
}

function readConfigFile(path: string): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    // The path and the file body stay out of the message: the file is operator config.
    throw new ModelConfigError(`${MODEL_CONFIG_ENV_VAR} does not point at a readable JSON file`);
  }
  const models = (parsed as { models?: unknown } | null)?.models;
  if (models === null || typeof models !== 'object' || Array.isArray(models)) {
    throw new ModelConfigError(`${MODEL_CONFIG_ENV_VAR} file has no "models" object`);
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(models as Record<string, unknown>)) {
    if (typeof v !== 'string') throw new ModelConfigError(`model for ${k} is not a string`);
    out[k] = v;
  }
  return out;
}

/**
 * The model table: defaults, then the config file named by `AFFIDAVIT_MODEL_CONFIG`, then one
 * environment variable per prompt (`ANTHROPIC_MODEL_DEFENSE` and so on). Later wins. The result is
 * checked, so an unknown id or a broken independence rule fails at startup, not mid-case.
 */
export function resolveModelTable(env: Env = process.env): ModelTable {
  const table: Record<string, string> = { ...DEFAULT_MODEL_TABLE };
  const file = env[MODEL_CONFIG_ENV_VAR];
  if (file !== undefined && file !== '') Object.assign(table, readConfigFile(file));
  for (const id of PromptId.options) {
    const v = env[MODEL_ENV_VARS[id]];
    if (v !== undefined && v !== '') table[id] = v.trim();
  }
  return checkModelTable(table);
}

/** The model a prompt runs on. For building handler configs in the composition root. */
export function modelFor(table: ModelTable, promptId: PromptId): KnownModelId {
  return table[promptId];
}
