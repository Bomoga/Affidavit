import { execFile } from 'node:child_process';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { BootHints } from '@affidavit/contracts';
import { PROBE_IMAGE } from '../containment/probes.js';
import type { Limits } from '../gvisor/args.js';
import { validateMounts, type Mount } from '../gvisor/mounts.js';
import { runJailed, type JailedRun } from '../gvisor/runner.js';
import {
  FETCH_IMAGE,
  createFetchEnv,
  npmProxyEnv,
  removeFetchEnv,
  resolveRegistry,
} from './fetch.js';
import { baseImageProblem, imageOnBuild, pinImage, pullPinned } from './images.js';
import { NPM_REGISTRY } from './lockfile.js';
import { deriveRecipe, type BootRecipe } from './recipe.js';

const exec = promisify(execFile);

/** Label on every image the split build makes, so they can be listed and removed. */
export const IMAGE_LABEL = 'affidavit.sandbox.image';

/** Build-step limits: dependency installs need more room than a witness. Configuration only. */
export const BUILD_LIMITS: Readonly<Limits> = {
  memoryMb: 2048,
  pids: 512,
  cpus: 2,
  scratchMb: 1024,
};
const FETCH_TIMEOUT_MS = 10 * 60_000;
const SCRIPTS_TIMEOUT_MS = 10 * 60_000;
const MAX_TREE_FILES = 50_000;
const MAX_TREE_BYTES = 512 * 1024 * 1024;

/** Never copied into a staged tree: VCS data, installed modules, real env files, npm config. */
const SKIPPED = (name: string): boolean =>
  name === '.git' ||
  name === 'node_modules' ||
  name === '.npmrc' ||
  name === '.env' ||
  name.startsWith('.env.');

export interface StageReport {
  files: number;
  bytes: number;
  /** Symlinks and other non-regular files left out (a symlink could point anywhere on the host). */
  skippedLinks: number;
}

/**
 * Copies a source checkout into `dest` with only regular files and directories, so nothing the
 * build later touches on the host can follow a link out of the tree. Directories are made
 * world-writable and files world-readable, because build steps run as nobody.
 */
export async function stageTree(src: string, dest: string): Promise<StageReport> {
  const report: StageReport = { files: 0, bytes: 0, skippedLinks: 0 };
  const walk = async (from: string, to: string): Promise<void> => {
    await mkdir(to, { recursive: true });
    await chmod(to, 0o777);
    for (const name of await readdir(from)) {
      if (SKIPPED(name)) continue;
      const s = await lstat(join(from, name));
      if (s.isDirectory()) await walk(join(from, name), join(to, name));
      else if (s.isFile()) {
        report.files++;
        report.bytes += s.size;
        if (report.files > MAX_TREE_FILES || report.bytes > MAX_TREE_BYTES) {
          throw new Error('source tree is over the size limit');
        }
        await copyFile(join(from, name), join(to, name));
        await chmod(join(to, name), (s.mode & 0o111) !== 0 ? 0o777 : 0o666);
      } else report.skippedLinks++;
    }
  };
  await walk(src, dest);
  return report;
}

export type BuildOutcome =
  | { ok: true; imageId: string; baseImage: string; recipe: BootRecipe; stage: StageReport }
  | {
      ok: false;
      /** `unsupported`: outside what the MVP can boot without weakening a control. */
      unsupported: boolean;
      step: 'stage' | 'recipe' | 'base' | 'fetch' | 'scripts' | 'assemble';
      reason: string;
    };

export interface BuildOptions {
  /** Host directory for build workspaces. Each build gets its own directory, removed after. */
  workRoot: string;
  limits?: Readonly<Limits>;
}

const tail = (r: JailedRun): string => `${r.stderr}\n${r.stdout}`.trim().slice(-1500);
const failed = (r: JailedRun): boolean => r.exitCode !== 0;

/**
 * The split build (L2-04). Nothing from the repository runs outside gVisor, and nothing runs with
 * a route out except npm itself, from Lane 2's pinned image (`FETCH_IMAGE`), with install scripts
 * off, through a per-build proxy that forwards only to the registry:
 *
 * 1. Stage the checkout (regular files only, no `.git`, `.env*`, `.npmrc`, `node_modules`).
 * 2. Derive the recipe from boot hints, compose file and Dockerfile, without running them, and
 *    check the lockfile only points at the npm registry.
 * 3. Base: the final stage's base must be an official `node` image; it is pinned by digest, and
 *    refused when it carries ONBUILD triggers.
 * 4. Fetch: `npm ci --ignore-scripts` in gVisor on a fresh internal network whose only peer is
 *    the fetch proxy (fetch.ts). The proxy allows only CONNECT to the registry on 443, at
 *    addresses the host resolved and checked are public.
 * 5. Scripts: `npm rebuild` (dependency install scripts) and the `build` script, offline, on the
 *    pinned base.
 * 6. Assemble: `docker build --network=none` from a generated Dockerfile with only FROM (pinned)
 *    and COPY, so no RUN step exists to execute.
 */
export async function buildTarget(
  srcDir: string,
  bootHints: BootHints,
  opts: BuildOptions,
): Promise<BuildOutcome> {
  const parsedHints = BootHints.safeParse(bootHints);
  if (!parsedHints.success) {
    return { ok: false, unsupported: false, step: 'recipe', reason: 'boot hints do not parse' };
  }
  const hints = parsedHints.data;
  const dir = await mkdtemp(join(opts.workRoot, 'build-'));
  const tree = join(dir, 'tree');
  const limits = opts.limits ?? BUILD_LIMITS;
  try {
    let stage: StageReport;
    try {
      stage = await stageTree(srcDir, tree);
    } catch (err) {
      return { ok: false, unsupported: true, step: 'stage', reason: (err as Error).message };
    }
    const r = await deriveRecipe(tree, hints);
    if (!r.ok) return { ok: false, unsupported: true, step: 'recipe', reason: r.reason };
    const recipe = r.recipe;

    const baseProblem = baseImageProblem(recipe.base);
    if (baseProblem !== null) {
      return { ok: false, unsupported: true, step: 'base', reason: baseProblem };
    }
    let baseImage: string;
    let onBuild: string[];
    try {
      baseImage = await pinImage(recipe.base);
      onBuild = await imageOnBuild(baseImage);
    } catch (err) {
      return {
        ok: false,
        unsupported: true,
        step: 'base',
        reason: (err as Error).message.slice(0, 500),
      };
    }
    if (onBuild.length > 0) {
      return {
        ok: false,
        unsupported: true,
        step: 'base',
        reason: `base image ${recipe.base} has ONBUILD triggers, which would run inside the build`,
      };
    }

    let mounts: Mount[];
    try {
      mounts = validateMounts(
        [{ hostPath: tree, containerPath: recipe.workdir, readOnly: false }],
        [dir],
      );
    } catch (err) {
      return { ok: false, unsupported: true, step: 'recipe', reason: (err as Error).message };
    }
    const common = {
      mounts,
      workdir: recipe.workdir,
      writableTmpMb: 256,
      env: {
        npm_config_cache: '/scratch/npm-cache',
        npm_config_registry: `https://${NPM_REGISTRY}/`,
        npm_config_update_notifier: 'false',
        npm_config_fund: 'false',
        npm_config_audit: 'false',
      },
    };

    await pullPinned(FETCH_IMAGE);
    const install = recipe.buildScript
      ? ['npm', 'ci', '--ignore-scripts']
      : ['npm', 'ci', '--ignore-scripts', '--omit=dev'];
    const fetchEnv = await createFetchEnv(await resolveRegistry());
    let fetched: JailedRun;
    try {
      fetched = await runJailed(
        {
          ...common,
          image: FETCH_IMAGE,
          env: { ...common.env, ...npmProxyEnv() },
          command: install,
          timeoutMs: FETCH_TIMEOUT_MS,
          fetch: fetchEnv.fetch,
        },
        { trace: false, limits },
      );
    } finally {
      await removeFetchEnv(fetchEnv);
    }
    if (failed(fetched))
      return { ok: false, unsupported: false, step: 'fetch', reason: tail(fetched) };

    const scripts = [['npm', 'rebuild'], ...(recipe.buildScript ? [['npm', 'run', 'build']] : [])];
    for (const command of scripts) {
      const run = await runJailed(
        { ...common, image: baseImage, command, timeoutMs: SCRIPTS_TIMEOUT_MS },
        { trace: false, limits },
      );
      if (failed(run)) {
        return {
          ok: false,
          unsupported: false,
          step: 'scripts',
          reason: `${command.join(' ')}: ${tail(run)}`,
        };
      }
    }

    const ctxDir = join(dir, 'dockerfile');
    await mkdir(ctxDir);
    const dockerfile = join(ctxDir, 'Dockerfile');
    await writeFile(
      dockerfile,
      `FROM ${baseImage}\nCOPY . ${recipe.workdir}\nWORKDIR ${recipe.workdir}\n`,
    );
    // An empty ignore file next to the generated Dockerfile takes precedence over the tree's own.
    await writeFile(`${dockerfile}.dockerignore`, '');
    const iid = join(dir, 'iid');
    try {
      await exec(
        'docker',
        [
          'build',
          '--network',
          'none',
          '--pull=false',
          '--quiet',
          '--label',
          `${IMAGE_LABEL}=1`,
          '--iidfile',
          iid,
          '-f',
          dockerfile,
          tree,
        ],
        {
          timeout: 600_000,
          maxBuffer: 16 * 1024 * 1024,
          env: { ...process.env, DOCKER_BUILDKIT: '1' },
        },
      );
    } catch (err) {
      return {
        ok: false,
        unsupported: false,
        step: 'assemble',
        reason: (err as Error).message.slice(-1500),
      };
    }
    const imageId = (await readFile(iid, 'utf8')).trim();
    if (!/^sha256:[0-9a-f]{64}$/.test(imageId)) {
      return { ok: false, unsupported: false, step: 'assemble', reason: `bad image id ${imageId}` };
    }
    return { ok: true, imageId, baseImage, recipe, stage };
  } finally {
    await removeBuildDir(dir);
  }
}

/**
 * Build steps write as nobody, so the host user cannot delete what they wrote. A jailed janitor,
 * as the same nobody, empties the tree first; the host then removes what is left.
 */
async function removeBuildDir(dir: string): Promise<void> {
  const tree = join(dir, 'tree');
  try {
    await lstat(tree);
    const mounts = validateMounts(
      [{ hostPath: tree, containerPath: '/w', readOnly: false }],
      [dir],
    );
    await runJailed(
      {
        image: PROBE_IMAGE,
        command: ['find', '/w', '-mindepth', '1', '-delete'],
        mounts,
        timeoutMs: 120_000,
      },
      { trace: false },
    );
  } catch {
    // No tree, or the janitor failed: the host removal below reports what is left.
  }
  await rm(dir, { recursive: true, force: true });
}
