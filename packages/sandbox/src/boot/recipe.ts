import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BootHints, ExternalStub } from '@affidavit/contracts';
import {
  findHostReadingKey,
  normalizeCompose,
  precheckCompose,
  selectServices,
  withEmptyDockerConfig,
  type ComposeSidecar,
} from './compose.js';
import { envProblem, hostAliasProblem, workdirProblem } from '../gvisor/args.js';
import { readDockerfile } from './dockerfile.js';
import { composePathPairs, execErrorText, scrubPaths } from './scrub.js';
import { checkLockfile, dependencyFetchProblem } from './lockfile.js';

/**
 * Everything needed to build and boot one target, derived from its boot hints, compose file and
 * Dockerfile without running any of them. A recipe is plain data, so it can be logged and stored
 * with the evidence.
 */
export interface BootRecipe {
  /** Final-stage base image as written; pinned by digest before use. */
  base: string;
  workdir: string;
  /** The target's full command: entrypoint plus command, compose first, then Dockerfile. */
  command: string[];
  env: Record<string, string>;
  port: number;
  healthRoute: string;
  healthTimeoutMs: number;
  sidecars: ComposeSidecar[];
  stubs: ExternalStub[];
  /** A seed script run with the target's image before the target starts. */
  seedScript?: string;
  /** package.json has a `build` script, run offline after the install scripts. */
  buildScript: boolean;
}

export type RecipeRead = { ok: true; recipe: BootRecipe } | { ok: false; reason: string };

/**
 * Longest health wait Lane 2 grants, whatever the boot hints ask for. The seed script, the health
 * probe and the boot diagnosis all derive their timeouts from the clamped value. Configuration,
 * not a measurement.
 */
export const MAX_HEALTH_TIMEOUT_MS = 180_000;

/** Value given to every environment variable the hints mark synthetic and nothing else sets. */
export const SYNTHETIC_VALUE = 'affidavit-synthetic';

async function readText(dir: string, rel: string, max = 1024 * 1024): Promise<string | null> {
  if (rel.startsWith('/') || rel.split('/').includes('..')) return null;
  try {
    const text = await readFile(join(dir, rel), 'utf8');
    return text.length > max ? null : text;
  } catch {
    return null;
  }
}

/**
 * Reads a staged tree (see build.ts: no `.git`, `.env`, `.npmrc`, `node_modules` or symlinks) and
 * returns its recipe, or the reason it is unsupported in the MVP.
 */
export async function deriveRecipe(treeDir: string, hints: BootHints): Promise<RecipeRead> {
  const fail = (reason: string): RecipeRead => ({ ok: false, reason });

  const pkgText = await readText(treeDir, 'package.json');
  if (pkgText === null) return fail('no package.json at the tree root');
  const lockText = await readText(treeDir, 'package-lock.json', 64 * 1024 * 1024);
  if (lockText === null) return fail('no package-lock.json (only npm lockfiles are supported)');
  let scripts: Record<string, unknown>;
  try {
    const pkg = JSON.parse(pkgText) as { scripts?: Record<string, unknown> };
    scripts = pkg.scripts ?? {};
  } catch {
    return fail('package.json is not JSON');
  }

  const production = { production: typeof scripts.build !== 'string' };
  const lockProblem =
    checkLockfile(lockText, production) ?? dependencyFetchProblem(lockText, pkgText, production);
  if (lockProblem !== null) return fail(lockProblem);

  let dockerfilePath = hints.path;
  let composeCmd: string[] | undefined;
  let composeEntrypoint: string[] | undefined;
  let composeEnv: Record<string, string> = {};
  let passThrough: string[] = [];
  let sidecars: ComposeSidecar[] = [];
  if (hints.kind === 'compose') {
    const text = await readText(treeDir, hints.path);
    if (text === null) return fail(`compose file ${hints.path} not found`);
    const pre = precheckCompose(text);
    if (pre !== null) return fail(pre);
    let normalized: unknown;
    try {
      // Compose runs on the host: its HOME, DOCKER_CONFIG and working directory are a fresh empty
      // directory outside the tree, never the tree (which could ship `.docker/cli-plugins`).
      normalized = await withEmptyDockerConfig((cfg) => normalizeCompose(treeDir, hints.path, cfg));
    } catch (err) {
      // stderr only (never `Command failed: <bin> --project-directory <tree> ...`), with any host
      // path that is left replaced by a placeholder.
      const text = scrubPaths(execErrorText(err), [['<tree>', treeDir], ...composePathPairs()]);
      return fail(`compose file did not parse: ${text.slice(0, 500)}`);
    }
    // Second layer: Compose's own reading of the file must not contain them either (a parser
    // difference between our key scanner and Compose). Nothing it read reaches a container.
    const post = findHostReadingKey(normalized);
    if (post !== null) return fail(post);
    const sel = selectServices(normalized, hints.service ?? 'app', treeDir);
    if (!sel.ok) return sel;
    dockerfilePath = sel.target.dockerfile;
    composeCmd = sel.target.command;
    composeEntrypoint = sel.target.entrypoint;
    composeEnv = sel.target.env;
    passThrough = sel.target.passThrough;
    sidecars = sel.target.sidecars;
  }

  const dfText = await readText(treeDir, dockerfilePath);
  if (dfText === null) return fail(`Dockerfile ${dockerfilePath} not found`);
  const df = readDockerfile(dfText);
  if (!df.ok) return df;
  const stage = df.stage;

  const entrypoint = composeEntrypoint ?? stage.entrypoint ?? [];
  const cmd = composeCmd ?? (composeEntrypoint !== undefined ? [] : stage.cmd) ?? [];
  let command = [...entrypoint, ...cmd];
  // An image whose only command is the base image's default (`node` for node images) would idle.
  if (command.length === 0 || (command.length === 1 && command[0] === 'node')) {
    if (typeof scripts.start !== 'string') return fail('no start command');
    command = ['npm', 'start'];
  }

  const env: Record<string, string> = { ...stage.env, ...composeEnv };
  // A key the compose file names without a value takes the host's value under Compose; here the
  // host has none, so it stays unset (NODE_ENV unset means "development" to most apps). Synthetic
  // values fill only keys nothing else sets, which is what secrets look like.
  for (const key of Object.keys(hints.env)) {
    if (!passThrough.includes(key)) env[key] ??= SYNTHETIC_VALUE;
  }
  for (const key of ['HOME', 'TMPDIR']) delete env[key];

  let seedScript: string | undefined;
  if (hints.seed !== undefined) {
    if (hints.seed.kind !== 'script') return fail('SQL seed files are not supported yet');
    if (hints.seed.path.startsWith('/') || hints.seed.path.split('/').includes('..')) {
      return fail(`seed path leaves the tree: ${hints.seed.path}`);
    }
    seedScript = hints.seed.path;
  }

  const workdir = stage.workdir === '/' ? '/app' : stage.workdir;
  const recipe: BootRecipe = {
    base: stage.base,
    workdir,
    command,
    env,
    port: hints.ports[0] as number,
    healthRoute: hints.healthRoute,
    // The hints are untrusted; every wait derived from this (seed, health probe, diagnosis) is
    // bounded by Lane 2's own maximum.
    healthTimeoutMs: Math.min(hints.healthTimeoutMs, MAX_HEALTH_TIMEOUT_MS),
    sidecars,
    stubs: hints.stubs,
    ...(seedScript === undefined ? {} : { seedScript }),
    buildScript: typeof scripts.build === 'string',
  };
  const problem = recipeProblem(recipe);
  return problem === null ? { ok: true, recipe } : fail(problem);
}

/**
 * Checks the values in a recipe that end up as jail flags (working directory, environment, host
 * aliases, timeouts), so a bad value from the target is an `unsupported` outcome rather than an
 * exception thrown while a run is being set up. `buildTarget` and `bootTarget` both call it.
 */
export function recipeProblem(r: BootRecipe): string | null {
  if (!Number.isSafeInteger(r.healthTimeoutMs) || r.healthTimeoutMs <= 0) {
    return 'health timeout is not a positive integer';
  }
  if (r.healthTimeoutMs > MAX_HEALTH_TIMEOUT_MS) {
    return `health timeout is over the ${MAX_HEALTH_TIMEOUT_MS} ms maximum`;
  }
  if (!Number.isSafeInteger(r.port) || r.port < 1 || r.port > 65535) return 'bad port';
  if (!r.healthRoute.startsWith('/') || /[\s\0]/.test(r.healthRoute)) return 'bad health route';
  return (
    workdirProblem(r.workdir) ??
    envProblem(r.env) ??
    r.sidecars.map((s) => hostAliasProblem(s.name) ?? envProblem(s.env)).find((p) => p !== null) ??
    r.stubs.map((s) => hostAliasProblem(s.hostAlias)).find((p) => p !== null) ??
    null
  );
}
