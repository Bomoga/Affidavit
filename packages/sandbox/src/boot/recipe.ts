import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BootHints, ExternalStub } from '@affidavit/contracts';
import {
  normalizeCompose,
  precheckCompose,
  selectServices,
  type ComposeSidecar,
} from './compose.js';
import { readDockerfile } from './dockerfile.js';
import { checkLockfile } from './lockfile.js';

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

  const lockProblem = checkLockfile(lockText, { production: typeof scripts.build !== 'string' });
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
      normalized = await normalizeCompose(treeDir, hints.path);
    } catch (err) {
      return fail(`compose file did not parse: ${(err as Error).message.slice(0, 500)}`);
    }
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

  return {
    ok: true,
    recipe: {
      base: stage.base,
      workdir: stage.workdir === '/' ? '/app' : stage.workdir,
      command,
      env,
      port: hints.ports[0] as number,
      healthRoute: hints.healthRoute,
      healthTimeoutMs: hints.healthTimeoutMs,
      sidecars,
      stubs: hints.stubs,
      ...(seedScript === undefined ? {} : { seedScript }),
      buildScript: typeof scripts.build === 'string',
    },
  };
}
