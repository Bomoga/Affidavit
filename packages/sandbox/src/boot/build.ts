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
import { composePathPairs, execErrorText, scrubPaths } from './scrub.js';

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

/**
 * Never copied into a staged tree: VCS data, installed modules, real env files, npm config, and
 * Docker CLI config (`.docker` can carry `cli-plugins/` binaries and a `config.json` that picks
 * plugin directories, contexts and proxies for any Docker CLI pointed at it).
 */
export const SKIPPED = (name: string): boolean =>
  name === '.git' ||
  name === 'node_modules' ||
  name === '.docker' ||
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

export type BuildOutcome = (
  | { ok: true; imageId: string; baseImage: string; recipe: BootRecipe; stage: StageReport }
  | {
      ok: false;
      /** `unsupported`: outside what the MVP can boot without weakening a control. */
      unsupported: boolean;
      step: 'stage' | 'recipe' | 'base' | 'fetch' | 'scripts' | 'assemble';
      /** Host paths are replaced by placeholders (`<tree>`, `<build>`, `<src>`, `<tmp>`). */
      reason: string;
    }
) & {
  /**
   * Operational signal, separate from the build's result: set when the build directory could not
   * be fully removed, so untrusted files may be left under the work root. Not an exception.
   */
  leftovers?: string;
};

export interface BuildOptions {
  /** Host directory for build workspaces. Each build gets its own directory, removed after. */
  workRoot: string;
  limits?: Readonly<Limits>;
  /**
   * Install devDependencies even when the app has no `build` script. Only for an image that runs
   * the target's own test suite (the patch workbench); a target that witnesses attack is built
   * as the app ships, without them.
   */
  devDependencies?: boolean;
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
  const dir = await mkdtemp(join(opts.workRoot, 'build-'));
  const scrub = (text: string): string =>
    scrubPaths(text, [
      ['<tree>', join(dir, 'tree')],
      ['<build>', dir],
      ['<src>', srcDir],
      ['<workRoot>', opts.workRoot],
      ...composePathPairs(),
    ]);
  let outcome: BuildOutcome | undefined;
  try {
    outcome = await buildIn(
      srcDir,
      parsedHints.data,
      dir,
      opts.limits ?? BUILD_LIMITS,
      opts.devDependencies === true,
    );
    if (!outcome.ok) outcome = { ...outcome, reason: scrub(outcome.reason) };
    return outcome;
  } finally {
    // Never throws: an exception here would replace the build's real outcome. What could not be
    // removed is reported on the outcome (or, if the build itself threw, as a process warning).
    const leftovers = await removeBuildDir(dir);
    if (leftovers !== null) {
      if (outcome !== undefined) outcome.leftovers = scrub(leftovers);
      else process.emitWarning(`build directory not fully removed: ${scrub(leftovers)}`);
    }
  }
}

async function buildIn(
  srcDir: string,
  hints: BootHints,
  dir: string,
  limits: Readonly<Limits>,
  devDependencies: boolean,
): Promise<BuildOutcome> {
  const tree = join(dir, 'tree');
  {
    let stage: StageReport;
    try {
      stage = await stageTree(srcDir, tree);
    } catch (err) {
      return { ok: false, unsupported: true, step: 'stage', reason: (err as Error).message };
    }
    const r = await deriveRecipe(tree, hints, { devDependencies });
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
        reason: execErrorText(err).slice(0, 500),
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
      // RLIMIT_FSIZE in the jail: no single file the steps write (sparse or not) may pass this.
      maxFileBytes: BUILD_MAX_FILE_BYTES,
      env: {
        npm_config_cache: '/scratch/npm-cache',
        npm_config_registry: `https://${NPM_REGISTRY}/`,
        npm_config_update_notifier: 'false',
        npm_config_fund: 'false',
        npm_config_audit: 'false',
      },
    };

    const install =
      recipe.buildScript || devDependencies
        ? ['npm', 'ci', '--ignore-scripts']
        : ['npm', 'ci', '--ignore-scripts', '--omit=dev'];
    // Pulling, resolving, the fetch setup and its teardown check can all throw; each is a
    // `failed` fetch step, never an exception out of buildTarget.
    let fetched: JailedRun;
    try {
      await pullPinned(FETCH_IMAGE);
      const fetchEnv = await createFetchEnv(await resolveRegistry());
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
    } catch (err) {
      return {
        ok: false,
        unsupported: false,
        step: 'fetch',
        reason: execErrorText(err).slice(0, 1500),
      };
    }
    if (failed(fetched))
      return { ok: false, unsupported: false, step: 'fetch', reason: tail(fetched) };
    const afterFetch = await checkBuiltTree(tree);
    if (afterFetch !== null) {
      return { ok: false, unsupported: false, step: 'fetch', reason: afterFetch };
    }

    const scripts = [['npm', 'rebuild'], ...(recipe.buildScript ? [['npm', 'run', 'build']] : [])];
    for (const command of scripts) {
      let run: JailedRun;
      try {
        run = await runJailed(
          { ...common, image: baseImage, command, timeoutMs: SCRIPTS_TIMEOUT_MS },
          { trace: false, limits },
        );
      } catch (err) {
        return {
          ok: false,
          unsupported: false,
          step: 'scripts',
          reason: `${command.join(' ')}: ${execErrorText(err).slice(0, 1500)}`,
        };
      }
      if (failed(run)) {
        return {
          ok: false,
          unsupported: false,
          step: 'scripts',
          reason: `${command.join(' ')}: ${tail(run)}`,
        };
      }
    }
    // The scripts ran repository and package code with write access to the tree. Before the
    // tree becomes a build context (which `COPY .` writes out in full, sparse files unsparse),
    // walk it again without following links and hold it to the caps.
    const afterScripts = await checkBuiltTree(tree);
    if (afterScripts !== null) {
      return { ok: false, unsupported: false, step: 'scripts', reason: afterScripts };
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
      // stderr only: the error message repeats the command line, with every host path in it.
      return {
        ok: false,
        unsupported: false,
        step: 'assemble',
        reason: execErrorText(err).slice(-1500),
      };
    }
    const imageId = (await readFile(iid, 'utf8')).trim();
    if (!/^sha256:[0-9a-f]{64}$/.test(imageId)) {
      return { ok: false, unsupported: false, step: 'assemble', reason: `bad image id ${imageId}` };
    }
    return { ok: true, imageId, baseImage, recipe, stage };
  }
}

/** What a built tree may hold after the fetch and scripts steps. Configuration only. */
export interface TreeCaps {
  /** Entries of any kind (files, directories, symlinks). */
  maxEntries: number;
  /** Sum of `st_size` over regular files: the bytes `COPY .` would write. */
  maxBytes: number;
}
export const BUILT_TREE_CAPS: Readonly<TreeCaps> = {
  maxEntries: 200_000,
  maxBytes: 2 * 1024 * 1024 * 1024,
};
/** RLIMIT_FSIZE for the fetch and scripts steps. Configuration only. */
export const BUILD_MAX_FILE_BYTES = 256 * 1024 * 1024;

/**
 * Walks a tree the jailed steps wrote, with `lstat` (links are counted, never followed) and an
 * explicit stack (no recursion depth to exhaust). Null when the tree is within `caps`, else the
 * reason, with paths relative to the tree. Refused: more entries or bytes than the caps, any
 * entry that is not a regular file, directory or symlink (FIFOs, sockets, devices), and any
 * directory the host cannot read.
 */
export async function checkBuiltTree(
  root: string,
  caps: Readonly<TreeCaps> = BUILT_TREE_CAPS,
): Promise<string | null> {
  let entries = 0;
  let bytes = 0;
  const stack: string[] = [''];
  while (stack.length > 0) {
    const rel = stack.pop() as string;
    let names: string[];
    try {
      names = await readdir(join(root, rel));
    } catch {
      return `built tree has an unreadable directory: ${rel === '' ? '.' : rel}`;
    }
    for (const name of names) {
      const childRel = rel === '' ? name : `${rel}/${name}`;
      entries++;
      if (entries > caps.maxEntries) {
        return `built tree has more than ${caps.maxEntries} entries`;
      }
      let s: Awaited<ReturnType<typeof lstat>>;
      try {
        s = await lstat(join(root, childRel));
      } catch {
        return `built tree has an unreadable entry: ${childRel}`;
      }
      if (s.isDirectory()) stack.push(childRel);
      else if (s.isFile()) {
        bytes += s.size;
        if (bytes > caps.maxBytes) return `built tree is over ${caps.maxBytes} bytes`;
      } else if (!s.isSymbolicLink()) {
        return `built tree has a special file: ${childRel}`;
      }
    }
  }
  return null;
}

/**
 * Removes a directory whose `tree` subdirectory was written by jailed steps (a build, or the patch
 * workbench's apply step). Build steps write as nobody, so the host user cannot delete what they wrote. A jailed janitor,
 * as the same nobody, first makes everything it owns readable and writable (a build script can
 * leave `chmod 000` directories that even nobody could not descend into), then empties the tree;
 * the host removes what is left. Never throws: returns null when the directory is gone, else what
 * was left and why, for the caller to report.
 */
export async function removeBuildDir(dir: string): Promise<string | null> {
  const tree = join(dir, 'tree');
  const problems: string[] = [];
  let hasTree = true;
  try {
    await lstat(tree);
  } catch {
    hasTree = false;
  }
  if (hasTree) {
    try {
      const mounts = validateMounts(
        [{ hostPath: tree, containerPath: '/w', readOnly: false }],
        [dir],
      );
      const janitor = await runJailed(
        {
          image: PROBE_IMAGE,
          command: JANITOR_COMMAND,
          mounts,
          timeoutMs: 120_000,
        },
        { trace: false },
      );
      if (janitor.exitCode !== 0) {
        problems.push(`janitor exited ${janitor.exitCode}: ${janitor.stderr.slice(-300)}`);
      }
    } catch (err) {
      problems.push(`janitor did not run: ${(err as Error).message.slice(0, 300)}`);
    }
  }
  try {
    await rm(dir, { recursive: true, force: true });
  } catch (err) {
    problems.push(`host removal failed: ${(err as NodeJS.ErrnoException).code ?? 'error'}`);
  }
  try {
    await lstat(dir);
  } catch {
    return null; // gone
  }
  return `<build> still exists${problems.length > 0 ? ` (${problems.join('; ')})` : ''}`;
}

/**
 * The janitor's command. The first `find` visits every directory before reading it and gives
 * each one that lacks owner rwx those bits, so a `chmod 000` directory the build left (at any
 * depth, under any parent) becomes traversable before `find` descends into it. Only directories
 * matter: deleting an entry needs write and search on its parent, not rights on the entry.
 * `-type d` uses lstat, so a symlink is never chmodded through. Directories the host staged are
 * already 0777 and do not match. (Busybox `chmod -R` cannot do this: it does not descend into a
 * directory it failed to chmod, and `/w` itself belongs to the host user.) The second `find`
 * empties the tree, and its exit status is the janitor's.
 */
export const JANITOR_COMMAND = [
  'sh',
  '-c',
  'find /w -mindepth 1 -type d ! -perm -u=rwx -exec chmod u+rwx {} \\; 2>/dev/null; find /w -mindepth 1 -delete',
];
