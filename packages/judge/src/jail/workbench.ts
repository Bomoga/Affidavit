import { execFile } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, readdir, writeFile, chmod } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { promisify } from 'node:util';
import type { CaseFile, PatchExhibit } from '@affidavit/contracts';
import {
  buildTarget,
  deriveRecipe,
  openDependencyBundle,
  removeBuildDir,
  removeCaseNetwork,
  runJailed,
  stageTree,
  validateMounts,
  type CaseNetwork,
  type DependencyBundleManifest,
  type DependencyBundleRef,
  type Mount,
} from '@affidavit/sandbox';
import { renderDiff, type ParsedDiff } from '../patch/diff.js';
import { suiteManifestChange } from '../patch/literal.js';
import {
  numstatMismatch,
  type PatchPlan,
  type PatchWorkbench,
  type PrepareOutcome,
  type PreparedPatch,
} from '../patch/workbench.js';
import { bootVariant, TargetBootError, type BootedTarget, type BootedTargets } from './booted.js';

const exec = promisify(execFile);

/** Build context of the apply image (git on the pinned Alpine base). */
export const PATCH_APPLY_CONTEXT = join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  '..',
  'docker',
  'sandbox',
  'patch-apply',
);
export const PATCH_APPLY_TAG = 'affidavit-patch-apply:local';

/** Builds the apply image with the same reproducibility flags as the runner image; returns its ID. */
export async function buildPatchApplyImage(context: string = PATCH_APPLY_CONTEXT): Promise<string> {
  const { stdout } = await exec(
    'docker',
    [
      'build',
      '--quiet',
      '--provenance=false',
      '--sbom=false',
      '--build-arg',
      'SOURCE_DATE_EPOCH=0',
      '--tag',
      PATCH_APPLY_TAG,
      context,
    ],
    { maxBuffer: 16 * 1024 * 1024 },
  );
  const id = stdout.trim().split('\n').pop() ?? '';
  if (!/^sha256:[0-9a-f]{64}$/.test(id)) throw new Error(`docker build did not return an image ID`);
  return id;
}

/**
 * Git never reads a system or user config, a repository above `/w`, or hooks: the copied trees
 * hold no `.git` (it is excluded when copying), and nothing outside them is a repository.
 */
const GIT_ENV =
  'export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_CEILING_DIRECTORIES=/w HOME=/scratch;';

/** Prints `git apply --numstat` for both diffs, separated by a marker line. Reads only /patch. */
export const NUMSTAT_SCRIPT = `${GIT_ENV} set -e; cd /scratch;
for t in code full; do echo "== $t"; if [ -s /patch/$t.diff ]; then git apply --numstat /patch/$t.diff; fi; done`;

/**
 * Copies the vulnerable tree (without any `.git`) into /w/code and /w/full and applies each diff
 * with plain `git apply`: `-p1`, no `--unsafe-paths`, and git's refusal to write beyond a symlink
 * left on.
 */
export const APPLY_SCRIPT = `${GIT_ENV} set -e;
for t in code full; do
  mkdir /w/$t
  tar -C /src --exclude=.git -cf - . | tar -C /w/$t -xf -
  if [ -s /patch/$t.diff ]; then (cd /w/$t && git apply /patch/$t.diff); fi
done`;

const APPLY_TIMEOUT_MS = 120_000;
const SUITE_TIMEOUT_MS = 10 * 60_000;

export interface JailedPatchWorkbenchOptions {
  /** Quota'd host directory for builds and patch workspaces (boot-recipes.md, host setup). */
  workRoot: string;
  /** Image ID from `buildPatchApplyImage`. */
  applyImage: string;
  /** Host path of the vulnerable commit's source tree for a case (read only, never written). */
  vulnerableSource: (caseFile: CaseFile) => string | Promise<string>;
  /**
   * The provider the Judge's executor uses; the patched target is registered here while verified.
   * A function gives each case its own registry (`CaseTargets.registry`), so two cases can verify
   * patches at the same time.
   */
  targets: BootedTargets | ((caseFile: CaseFile) => Promise<BootedTargets>);
  /**
   * The case target's pinned dependency bundle (L2-04c; `pinnedDependencyBundle` checks it against
   * pins.json). Both builds install from it: the patched target with its production section, the
   * suite image with production and dev. Without it, a target with dependencies is unsupported.
   * A function picks the bundle per case (`CaseTargets.dependencyBundle`).
   */
  dependencyBundle?:
    DependencyBundleRef | ((caseFile: CaseFile) => DependencyBundleRef | undefined);
}

interface Workspace {
  dir: string;
  /** Where the patched target is registered until `release`. */
  registry: BootedTargets;
  target: BootedTarget;
  /** The patched build with devDependencies, used only to run the suite; or why there is none. */
  suite: { image: string } | { unavailable: string };
}

/**
 * Runs `fn` while owning a booted target's case network. The network is removed unless `fn`
 * returns `ok: true` (it was handed over to `release`); a refusal or a throw both remove it, so a
 * failed prepare never leaks a running target and its sidecars. Anything else `fn` creates on the
 * way (the suite image) is registered with `onFailure` and removed the same way.
 */
export async function ownBootedTarget<T extends { ok: boolean }>(
  net: CaseNetwork,
  fn: (onFailure: (cleanup: () => Promise<void>) => void) => Promise<T>,
  remove: (net: CaseNetwork) => Promise<void> = removeCaseNetwork,
): Promise<T> {
  let handedOver = false;
  const cleanups: (() => Promise<void>)[] = [];
  try {
    const out = await fn((c) => cleanups.push(c));
    handedOver = out.ok;
    return out;
  } finally {
    if (!handedOver) {
      for (const c of cleanups.reverse()) await c().catch(() => undefined);
      await remove(net);
    }
  }
}

/** Every `package.json` under `root` (relative paths), skipping `node_modules` and `.git`. */
async function packageJsons(root: string, dir = root): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await packageJsons(root, p)));
    else if (e.isFile() && e.name === 'package.json') out.push(relative(root, p));
  }
  return out;
}

async function readIfFile(path: string): Promise<string | null> {
  try {
    const st = await lstat(path);
    return st.isFile() ? await readFile(path, 'utf8') : null;
  } catch {
    return null;
  }
}

/**
 * The real `PatchWorkbench` (L2-07 contract in `patch/workbench.ts`): applies the patch inside the
 * jail, builds and boots the patched target with the L2-04 boot recipes, and runs the vulnerable
 * commit's own suite against that build.
 *
 * - `git apply --numstat` runs first, in the jail, on both diffs; any disagreement with the
 *   Judge's reading is `apply`.
 * - The apply step is the only writer of the workspace: the host writes only the diff files next
 *   to it, and later steps (build, boot, suite) get no writable handle to it.
 * - Every `package.json` of the vulnerable tree is compared with the applied tree
 *   (`suiteManifestChange`); a change is `suite`.
 * - The patched target is built from `PatchPlan.code` as the app ships (no devDependencies when
 *   it has no `build` script) and registered as `patched` in the executor's `BootedTargets` until
 *   `release`. The suite needs the test tooling the target image leaves out, so the same tree is
 *   built a second time with devDependencies (`buildTarget`'s `devDependencies`), and that image
 *   is never booted or attacked. Either build failing is `build`. Whether that suite build is
 *   possible at all is decided on the vulnerable commit first: when its recipe with
 *   devDependencies is refused (a devDependency from outside the npm registry), the suite is
 *   `unavailable` and is not built. A patch that makes the suite build refused is `build`.
 * - `runSuite` runs `npm test` in the suite image, in the recipe's working directory, with no
 *   network. The command is fixed here, and the `scripts` it resolves are the vulnerable commit's
 *   (unchanged, checked above). `runAddedTests` is not run yet (returns null).
 *
 * Throws only on infrastructure failure.
 */
export class JailedPatchWorkbench implements PatchWorkbench {
  readonly #open = new Map<string, Workspace>();

  constructor(private readonly opts: JailedPatchWorkbenchOptions) {}

  async prepare(
    caseFile: CaseFile,
    _patch: PatchExhibit,
    plan: PatchPlan,
  ): Promise<PrepareOutcome> {
    const srcDir = await this.opts.vulnerableSource(caseFile);
    const registry =
      typeof this.opts.targets === 'function'
        ? await this.opts.targets(caseFile)
        : this.opts.targets;
    const dir = await mkdtemp(join(this.opts.workRoot, 'patch-'));
    let keep = false;
    try {
      const patchDir = join(dir, 'patch');
      const tree = join(dir, 'tree');
      // A readable copy of the vulnerable commit for the jail (which runs as nobody), made the
      // same way the L2-04 build stages a tree: no `.git`, no symlinks, no host credentials.
      const staged = join(dir, 'src');
      await stageTree(srcDir, staged);
      await mkdir(patchDir, { mode: 0o755 });
      await mkdir(tree);
      await chmod(tree, 0o777); // the jail writes as nobody
      await writeFile(join(patchDir, 'code.diff'), diffText(plan.code), { mode: 0o644 });
      await writeFile(join(patchDir, 'full.diff'), diffText(plan.full), { mode: 0o644 });
      const mounts = (writable: boolean): Mount[] =>
        validateMounts(
          [
            { hostPath: staged, containerPath: '/src', readOnly: true },
            { hostPath: patchDir, containerPath: '/patch', readOnly: true },
            ...(writable ? [{ hostPath: tree, containerPath: '/w', readOnly: false }] : []),
          ],
          [dir],
        );

      const numstat = await runJailed(
        {
          image: this.opts.applyImage,
          command: ['sh', '-c', NUMSTAT_SCRIPT],
          mounts: mounts(false),
          timeoutMs: APPLY_TIMEOUT_MS,
        },
        { trace: false },
      );
      if (numstat.exitCode !== 0 || numstat.timedOut) {
        return { ok: false, stage: 'apply', detail: 'git apply --numstat refused the patch' };
      }
      const [codeStat, fullStat] = splitNumstat(numstat.stdout);
      const mismatch = numstatMismatch(codeStat, plan.code) ?? numstatMismatch(fullStat, plan.full);
      if (mismatch !== null) return { ok: false, stage: 'apply', detail: mismatch };

      const applied = await runJailed(
        {
          image: this.opts.applyImage,
          command: ['sh', '-c', APPLY_SCRIPT],
          mounts: mounts(true),
          timeoutMs: APPLY_TIMEOUT_MS,
        },
        { trace: false },
      );
      if (applied.exitCode !== 0 || applied.timedOut) {
        return {
          ok: false,
          stage: 'apply',
          detail: `the patch does not apply to the vulnerable commit: ${applied.stderr.slice(-300)}`,
        };
      }

      for (const rel of await packageJsons(srcDir)) {
        const before = await readIfFile(join(srcDir, rel));
        const after = await readIfFile(join(tree, 'full', rel));
        if (before === null) continue;
        const change = after === null ? 'package.json removed' : suiteManifestChange(before, after);
        if (change !== null) return { ok: false, stage: 'suite', detail: `${rel}: ${change}` };
      }

      const bundleRef =
        typeof this.opts.dependencyBundle === 'function'
          ? this.opts.dependencyBundle(caseFile)
          : this.opts.dependencyBundle;
      const bundleOpt = bundleRef === undefined ? {} : { dependencyBundle: bundleRef };
      // The suite precheck reads the bundle's manifest, verified against the pin the same way a
      // build verifies it; a bundle that does not verify is `build`.
      let manifest: DependencyBundleManifest | undefined;
      if (bundleRef !== undefined) {
        const opened = await openDependencyBundle(bundleRef, join(dir, 'bundle'));
        if (!opened.ok) {
          return { ok: false, stage: 'build', detail: `dependency bundle: ${opened.reason}` };
        }
        manifest = opened.bundle.manifest;
      }

      let target: BootedTarget;
      try {
        target = await bootVariant(join(tree, 'code'), caseFile.bootHints, {
          workRoot: this.opts.workRoot,
          ...bundleOpt,
        });
      } catch (err) {
        if (err instanceof TargetBootError) {
          return { ok: false, stage: 'build', detail: err.message.slice(0, 500) };
        }
        throw err;
      }
      // From here the booted network is ours until it is handed over to `release`: any refusal or
      // throw (deriveRecipe, buildTarget, a patched target already registered) removes it.
      return await ownBootedTarget(
        target.endpoint.net,
        async (onFailure): Promise<PrepareOutcome> => {
          let suite: Workspace['suite'];
          const vulnerableSuite = await deriveRecipe(staged, caseFile.bootHints, {
            devDependencies: true,
            ...(manifest === undefined ? {} : { bundle: manifest }),
          });
          if (!vulnerableSuite.ok) {
            suite = { unavailable: `the suite cannot be built: ${vulnerableSuite.reason}` };
          } else {
            const built = await buildTarget(join(tree, 'code'), caseFile.bootHints, {
              workRoot: this.opts.workRoot,
              devDependencies: true,
              ...bundleOpt,
            });
            if (!built.ok) {
              return {
                ok: false,
                stage: 'build',
                detail: `the suite build failed (${built.step}): ${built.reason}`.slice(0, 500),
              };
            }
            const suiteImage = built.imageId;
            // Removed by `release` once handed over; by this if registering the target throws.
            onFailure(async () => {
              await exec('docker', ['image', 'rm', '--force', suiteImage]);
            });
            suite = { image: suiteImage };
          }
          registry.set('patched', target);
          const prepared: PreparedPatch = {
            target: { ...caseFile.target, variant: 'patched', imageDigest: target.imageId },
            workspacePath: join(tree, 'full'),
          };
          this.#open.set(prepared.workspacePath, { dir, registry, target, suite });
          keep = true;
          return { ok: true, prepared };
        },
      );
    } finally {
      if (!keep) await removeBuildDir(dir);
    }
  }

  async runSuite(
    _caseFile: CaseFile,
    prepared: PreparedPatch,
  ): Promise<{ passed: boolean } | { unavailable: string }> {
    const ws = this.#workspace(prepared);
    if ('unavailable' in ws.suite) return { unavailable: ws.suite.unavailable };
    const workdir = ws.target.recipe.workdir;
    if (!/^\/[A-Za-z0-9._/-]*$/.test(workdir)) throw new Error('unexpected recipe workdir');
    const run = await runJailed(
      {
        image: ws.suite.image,
        command: ['sh', '-c', `cd '${workdir}' && npm test`],
        mounts: [],
        timeoutMs: SUITE_TIMEOUT_MS,
      },
      { trace: false },
    );
    return { passed: run.exitCode === 0 && !run.timedOut && !run.oomKilled };
  }

  runAddedTests(): Promise<{ passed: boolean } | null> {
    return Promise.resolve(null);
  }

  async release(prepared: PreparedPatch): Promise<void> {
    const ws = this.#workspace(prepared);
    this.#open.delete(prepared.workspacePath);
    ws.registry.delete('patched');
    let cleanupError: Error | undefined;
    try {
      await removeCaseNetwork(ws.target.endpoint.net);
    } catch (err) {
      cleanupError = err instanceof Error ? err : new Error(String(err));
    }
    if ('image' in ws.suite) {
      try {
        // Only this workbench ever uses the suite image; the patched target's image stays,
        // because the evidence bundle names it by ID.
        await exec('docker', ['image', 'rm', '--force', ws.suite.image]);
      } catch (err) {
        cleanupError ??= err instanceof Error ? err : new Error(String(err));
      }
    }
    const left = await removeBuildDir(ws.dir);
    if (cleanupError !== undefined) throw cleanupError;
    if (left !== null) throw new Error(`patch workspace was not removed: ${left}`);
  }

  #workspace(prepared: PreparedPatch): Workspace {
    const ws = this.#open.get(prepared.workspacePath);
    if (ws === undefined) throw new Error('unknown or already released patch workspace');
    return ws;
  }
}

/** The diff as git reads it: an empty plan is an empty file, which the apply step skips. */
function diffText(diff: ParsedDiff): string {
  if (diff.files.length === 0) return '';
  const text = renderDiff(diff);
  return text.endsWith('\n') ? text : `${text}\n`;
}

/** Splits the apply image's numstat output into the code and full parts; `?` when malformed. */
export function splitNumstat(stdout: string): [string, string] {
  const code = /== code\n([\s\S]*?)== full\n/.exec(stdout);
  const full = /== full\n([\s\S]*)$/.exec(stdout);
  if (code === null || full === null) return ['?', '?'];
  return [code[1] ?? '', full[1] ?? ''];
}
