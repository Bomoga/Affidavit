import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type {
  CaseFile,
  EvidenceStore,
  Exhibit,
  ExhibitResult,
  JudgePort,
  PatchExhibit,
  RescanPort,
  SignerPort,
  TargetVariant,
  VerifyResult,
  Witness,
} from '@affidavit/contracts';
import {
  AUDIT_RUNTIME,
  DEFAULT_TRACE_ROOT,
  PLAIN_RUNTIME,
  pinnedDependencyBundle,
  readDependencyBundlePins,
  type DependencyBundleRef,
} from '@affidavit/sandbox';
import { Judge, type RunLogRecorder, type PatchReport } from '../judge.js';
import { DEFAULT_POLICY, type JudgePolicy } from '../rules.js';
import { JailExecutor } from './executor.js';
import { localImagePresent } from './harness.js';
import { CaseTargets, type SourceResolver, type TargetBootDeps } from './targets.js';
import { WorkerLease, type LeaseHandle, type SweepDeps } from './lease.js';
import { JailedPatchWorkbench } from './workbench.js';

/** A pinned dependency bundle the real Judge may build a repository's targets with. */
export interface DependencyBundleConfig {
  /** The app name in `docker/sandbox/dependency-bundles/pins.json`, for example `nodegoat`. */
  app: string;
  /** The `RepoId` of the case files it serves (`CaseFile.target.repo`). */
  repo: string;
  /** Absolute path of the bundle tar (`AFFIDAVIT_NODEGOAT_BUNDLE`). */
  path: string;
  /** Absolute path of the bundle store the file must resolve inside (`AFFIDAVIT_DEPENDENCY_BUNDLE_ROOT`). */
  storeRoot: string;
}

/**
 * Everything the real Judge needs, as typed values. The composition root (apps/worker) maps its
 * environment onto this; nothing here reads the environment. The evidence store and the signer
 * client are passed in built (`FsEvidenceStore`, `SignerClient`), because `@affidavit/judge` does
 * not depend on `@affidavit/evidence` or `apps/signer`; their paths are given too, so the startup
 * check can verify them.
 */
export interface RealJudgeConfig {
  /** Absolute, existing, quota'd directory for witness attempts, builds and patch workspaces. */
  workRoot: string;
  /** Witness runner image ID (`pnpm --filter @affidavit/judge runner-image`). */
  runnerImage: string;
  /** Patch-apply image ID (`buildPatchApplyImage`, docker/sandbox/patch-apply). */
  applyImage: string;
  /** Absolute, existing evidence store root. Must not contain or sit inside `workRoot`. */
  evidenceRoot: string;
  evidence: EvidenceStore;
  /** The signer's listening unix socket. */
  signerSocket: string;
  signer: SignerPort;
  /** Where each case's vulnerable and safe trees are (`directorySources`, or the corpus loader). */
  sources: SourceResolver;
  dependencyBundles?: readonly DependencyBundleConfig[];
  /** Lane 1's re-scan. Without it `verifyPatch` fails closed (throws), and the check says so. */
  rescan?: RescanPort;
  policy?: Readonly<JudgePolicy>;
  /**
   * Receives each judged exhibit's run log (L2-11: egress attempts, per-run time, CPU and peak
   * memory) so the worker can file it in the bundle record (`egress` and `usage` in
   * `@affidavit/evidence`). Optional: without it the logs are dropped and only the results remain.
   */
  runLogRecorder?: RunLogRecorder;
  /** Syscall trace directory of the audit runtime (default `/var/lib/affidavit-runsc`). */
  traceRoot?: string;
  /** Docker daemon config that registers the gVisor runtimes (default `/etc/docker/daemon.json`). */
  dockerDaemonConfig?: string;
  /**
   * At startup, remove the case networks (and their containers) of workers proven dead: a lease
   * in `leaseDir` on this host name, pid namespace and boot, with a heartbeat stale well past its
   * interval and a pid that is gone or recycled. Default false; the worker sets `true` when
   * `AFFIDAVIT_SWEEP_ORPHANS=1`. A possibly live owner's runs are never removed, and an unreadable
   * lease stops the sweep. Runs no lease claims are removed only with `'force'`
   * (`AFFIDAVIT_SWEEP_ORPHANS=force`).
   */
  sweepOrphans?: boolean | 'force';
  /** Directory of worker lease files shared by every worker on this host (default `<workRoot>/leases`). */
  leaseDir?: string;
}

/** Host facts the startup check reads; injectable so the check is tested without a host. */
export interface RealJudgeHostProbe {
  platform: NodeJS.Platform;
  isDirectory(path: string): Promise<boolean>;
  isSocket(path: string): Promise<boolean>;
  /** The path with every symlink resolved, or null when it cannot be resolved. */
  realpath(path: string): Promise<string | null>;
  /** Runtime names registered in the daemon config, or null when it cannot be read. */
  dockerRuntimes(daemonConfig: string): Promise<string[] | null>;
  imagePresent(imageId: string): Promise<boolean>;
  pins(): { app: string; commit: string; bundleSha256: string | null }[];
  pinBundle(input: {
    app: string;
    commit: string;
    path: string;
    storeRoot: string;
  }): Promise<DependencyBundleRef>;
}

export const realJudgeHostProbe: RealJudgeHostProbe = {
  platform: process.platform,
  isDirectory: (p) =>
    stat(p).then(
      (s) => s.isDirectory(),
      () => false,
    ),
  isSocket: (p) =>
    stat(p).then(
      (s) => s.isSocket(),
      () => false,
    ),
  realpath: (p) =>
    realpath(p).then(
      (r) => r,
      () => null,
    ),
  async dockerRuntimes(daemonConfig) {
    try {
      const parsed = JSON.parse(await readFile(daemonConfig, 'utf8')) as { runtimes?: unknown };
      const r = parsed.runtimes;
      return r !== null && typeof r === 'object' ? Object.keys(r) : [];
    } catch {
      return null;
    }
  },
  imagePresent: localImagePresent,
  pins: () => readDependencyBundlePins(),
  pinBundle: pinnedDependencyBundle,
};

export const DEFAULT_DOCKER_DAEMON_CONFIG = '/etc/docker/daemon.json';
const IMAGE_ID = /^sha256:[0-9a-f]{64}$/;

export interface PrerequisiteReport {
  /** Each one blocks startup. Names config fields (and the worker's variable), never values. */
  problems: string[];
  /** Limits that do not block startup but make some cases fail closed. */
  notes: string[];
  /** Verified bundle refs, by repo and pinned commit. */
  bundles: { repo: string; commit: string; ref: DependencyBundleRef }[];
}

export class RealJudgePrerequisiteError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(
      `the real Judge cannot start, nothing was started: ${problems.join('; ')} (see docs/lanes/lane2/real-judge-host.md)`,
    );
    this.name = 'RealJudgePrerequisiteError';
  }
}

/** Case-insensitive file systems by default: Windows and macOS. */
const fold = (platform: NodeJS.Platform, p: string): string =>
  platform === 'win32' || platform === 'darwin' ? resolve(p).toLowerCase() : resolve(p);

function inside(child: string, parent: string, platform: NodeJS.Platform): boolean {
  const rel = relative(fold(platform, parent), fold(platform, child));
  if (rel === '') return true;
  // Outside only when the first segment is exactly `..` or the result is absolute (another drive
  // on Windows); a child named `..evidence` is inside.
  const outside = rel === '..' || rel.startsWith(`..${sep}`) || rel.startsWith('../');
  return !outside && !isAbsolute(rel);
}

/** Replaces every configured path in a message with its name, so no host value is echoed. */
function scrub(text: string, pairs: readonly [string, string][]): string {
  let out = text;
  for (const [name, value] of pairs) if (value !== '') out = out.split(value).join(name);
  return out.slice(0, 500);
}

/**
 * Checks every host prerequisite of the real Judge and lists all that are missing at once. Each
 * entry names the config field and the worker variable it usually comes from, never the value.
 * Opens nothing but files and `docker image inspect`; starts no container.
 */
export async function checkRealJudgePrerequisites(
  config: RealJudgeConfig,
  probe: RealJudgeHostProbe = realJudgeHostProbe,
): Promise<PrerequisiteReport> {
  const problems: string[] = [];
  const notes: string[] = [];
  const bundles: PrerequisiteReport['bundles'] = [];

  if (probe.platform !== 'linux') {
    problems.push(
      `the real Judge needs a Linux sandbox host with gVisor (this host is ${probe.platform})`,
    );
  }
  const runtimes = await probe.dockerRuntimes(
    config.dockerDaemonConfig ?? DEFAULT_DOCKER_DAEMON_CONFIG,
  );
  if (runtimes === null) {
    problems.push(
      'the Docker daemon config cannot be read (dockerDaemonConfig, default /etc/docker/daemon.json)',
    );
  } else {
    if (!runtimes.includes(PLAIN_RUNTIME)) {
      problems.push(
        `Docker has no "${PLAIN_RUNTIME}" runtime (run docker/sandbox/install-gvisor.sh as root)`,
      );
    }
    if (!runtimes.includes(AUDIT_RUNTIME)) {
      problems.push(
        `Docker has no "${AUDIT_RUNTIME}" runtime (run docker/sandbox/setup-runsc-audit.sh as root)`,
      );
    }
  }
  if (!(await probe.isDirectory(config.traceRoot ?? DEFAULT_TRACE_ROOT))) {
    problems.push(
      'the syscall trace directory (traceRoot) does not exist (run docker/sandbox/setup-runsc-audit.sh as root)',
    );
  }

  const dirs: [string, string, string][] = [
    ['workRoot', 'AFFIDAVIT_JUDGE_WORK_ROOT', config.workRoot],
    ['evidenceRoot', 'AFFIDAVIT_EVIDENCE_DIR', config.evidenceRoot],
  ];
  for (const [field, env, value] of dirs) {
    if (!isAbsolute(value)) problems.push(`${field} (${env}) must be an absolute path`);
    else if (!(await probe.isDirectory(value))) {
      problems.push(`${field} (${env}) is not an existing directory`);
    }
  }
  // The witness runner holds no writable path to the evidence store (root CLAUDE.md). Compared
  // after resolving every symlink, in both directions, case-insensitively where the file system
  // is, so a work root that is a link into the store (or the store itself) is caught.
  const real = async (field: string, env: string, p: string, exists: boolean) => {
    if (!isAbsolute(p)) return null;
    const r = await probe.realpath(p);
    if (r === null && exists) problems.push(`${field} (${env}) cannot be resolved`);
    return r;
  };
  const workReal = await real(
    'workRoot',
    'AFFIDAVIT_JUDGE_WORK_ROOT',
    config.workRoot,
    await probe.isDirectory(config.workRoot),
  );
  const evidenceReal = await real(
    'evidenceRoot',
    'AFFIDAVIT_EVIDENCE_DIR',
    config.evidenceRoot,
    await probe.isDirectory(config.evidenceRoot),
  );
  const os = probe.platform;
  if (
    workReal !== null &&
    evidenceReal !== null &&
    (inside(workReal, evidenceReal, os) || inside(evidenceReal, workReal, os))
  ) {
    problems.push(
      'workRoot and evidenceRoot must not contain one another (the jail gets no path to the evidence store)',
    );
  }
  const storeRoot = (config.evidence as { root?: unknown }).root;
  if (typeof storeRoot === 'string') {
    const storeReal = isAbsolute(storeRoot) ? await probe.realpath(storeRoot) : null;
    if (
      storeReal === null ||
      evidenceReal === null ||
      fold(os, storeReal) !== fold(os, evidenceReal)
    ) {
      problems.push('the evidence store is rooted somewhere other than evidenceRoot');
    }
  }
  // Bundle stores are mounted read only into builds; the evidence store and the signer stay out.
  const bundleStores: string[] = [];
  for (const b of config.dependencyBundles ?? []) {
    const r = isAbsolute(b.storeRoot) ? await probe.realpath(b.storeRoot) : null;
    if (r !== null) bundleStores.push(r);
  }
  if (evidenceReal !== null && bundleStores.some((s) => inside(evidenceReal, s, os))) {
    problems.push('evidenceRoot must not be under a dependency bundle store');
  }
  const images: [string, string, string, string][] = [
    [
      'runnerImage',
      'AFFIDAVIT_WITNESS_RUNNER_IMAGE',
      config.runnerImage,
      '`pnpm --filter @affidavit/judge runner-image`',
    ],
    [
      'applyImage',
      'AFFIDAVIT_PATCH_APPLY_IMAGE',
      config.applyImage,
      '`pnpm --filter @affidavit/judge patch-apply-image`',
    ],
  ];
  for (const [field, env, value, how] of images) {
    if (!IMAGE_ID.test(value))
      problems.push(`${field} (${env}) must be a local image ID (sha256:<64 hex>)`);
    else if (!(await probe.imagePresent(value))) {
      problems.push(`the ${field} (${env}) image is not present locally (build it with ${how})`);
    }
  }

  if (!(await probe.isSocket(config.signerSocket))) {
    problems.push(
      'signerSocket (AFFIDAVIT_SIGNER_SOCKET) is not a listening unix socket (start apps/signer)',
    );
  } else {
    const sock = await real('signerSocket', 'AFFIDAVIT_SIGNER_SOCKET', config.signerSocket, true);
    const mountable = [workReal, evidenceReal, ...bundleStores].filter(
      (r): r is string => r !== null,
    );
    if (sock !== null && mountable.some((root) => inside(sock, root, os))) {
      problems.push(
        'signerSocket (AFFIDAVIT_SIGNER_SOCKET) must not be under workRoot, evidenceRoot or a dependency bundle store (paths a jail or build can mount)',
      );
    }
  }
  const configured = config.dependencyBundles ?? [];
  if (configured.length === 0) {
    notes.push(
      'no dependency bundle is configured: a target with npm dependencies (NodeGoat) is unsupported at build',
    );
  }
  let pins: ReturnType<RealJudgeHostProbe['pins']> = [];
  try {
    pins = probe.pins();
  } catch (err) {
    if (configured.length > 0) {
      problems.push(
        `docker/sandbox/dependency-bundles/pins.json is malformed: ${(err as Error).message.slice(0, 200)}`,
      );
    }
  }
  const seen = new Set<string>();
  for (const b of configured) {
    if (seen.has(b.repo)) {
      problems.push(`two dependency bundles are configured for repo ${b.repo}`);
      continue;
    }
    seen.add(b.repo);
    const pin = pins.find((p) => p.app === b.app);
    if (pin === undefined) {
      problems.push(`pins.json has no entry for ${b.app}`);
      continue;
    }
    if (pin.bundleSha256 === null) {
      problems.push(
        `pins.json has no bundleSha256 for ${b.app} at ${pin.commit}: a human builds the bundle on a networked host (packages/sandbox/scripts/build-dependency-bundle.ts), reviews the manifest and sets the pin`,
      );
      continue;
    }
    try {
      const ref = await probe.pinBundle({
        app: b.app,
        commit: pin.commit,
        path: b.path,
        storeRoot: b.storeRoot,
      });
      bundles.push({ repo: b.repo, commit: pin.commit, ref });
    } catch (err) {
      problems.push(
        `the ${b.app} dependency bundle (AFFIDAVIT_NODEGOAT_BUNDLE in AFFIDAVIT_DEPENDENCY_BUNDLE_ROOT) is refused: ${scrub(
          (err as Error).message,
          [
            ['<bundle>', b.path],
            ['<bundle store>', b.storeRoot],
          ],
        )}`,
      );
    }
  }
  if (config.rescan === undefined) {
    notes.push(
      'no RescanPort is configured: verifyPatch fails closed (throws) until Lane 1 provides one',
    );
  }
  return { problems, notes, bundles };
}

/**
 * The Judge bound to booted targets: every call first boots (or reuses) the case's vulnerable and
 * safe targets and runs the Judge on the case file with their image digests filled in. A boot
 * failure throws `CaseBootError` before any witness runs, so a case with a safe variant is never
 * judged without it. Inadmissible evidence is still a value, as `JudgePort` requires.
 */
export class CaseBoundJudge implements JudgePort {
  constructor(
    readonly judge: Judge,
    readonly targets: CaseTargets,
  ) {}

  async runWitness(
    caseFile: CaseFile,
    witness: Witness,
    variants: readonly TargetVariant[],
  ): Promise<ExhibitResult> {
    return this.judge.runWitness(await this.targets.bind(caseFile), witness, variants);
  }

  async runCounterexample(
    caseFile: CaseFile,
    witness: Witness,
    counterexample: Exhibit,
  ): Promise<ExhibitResult> {
    return this.judge.runCounterexample(await this.targets.bind(caseFile), witness, counterexample);
  }

  async verifyPatch(
    caseFile: CaseFile,
    patch: PatchExhibit,
    witness: Witness,
    counterexamples: readonly Exhibit[],
  ): Promise<VerifyResult> {
    return (await this.verifyPatchReport(caseFile, patch, witness, counterexamples)).result;
  }

  async verifyPatchReport(
    caseFile: CaseFile,
    patch: PatchExhibit,
    witness: Witness,
    counterexamples: readonly Exhibit[],
  ): Promise<PatchReport> {
    return this.judge.verifyPatchReport(
      await this.targets.bind(caseFile),
      patch,
      witness,
      counterexamples,
    );
  }
}

export interface RealJudge {
  judge: CaseBoundJudge;
  targets: CaseTargets;
  /** Held for bundle sealing; the jail is never given its path. */
  evidence: EvidenceStore;
  signer: SignerPort;
  /** Non-blocking limits found at startup (no bundle, no re-scan). */
  notes: string[];
  /** Tears down one case's targets; call when the case reaches a verdict or is flagged. */
  release(caseId: string): Promise<void>;
  /** Tears down every case's targets; call on shutdown. */
  close(): Promise<void>;
}

/**
 * Assembles the real Judge (CR-11): `Judge` on the gVisor `JailExecutor`, whose targets are a
 * `CaseTargets` provider booting each case's variants, the `JailedPatchWorkbench` registering the
 * patched target in the same case's registry, and the evidence store and signer client held for
 * sealing. Runs `checkRealJudgePrerequisites` first and throws `RealJudgePrerequisiteError`
 * listing every missing prerequisite before anything is built or started.
 */
export async function createRealJudge(
  config: RealJudgeConfig,
  opts: {
    probe?: RealJudgeHostProbe;
    deps?: TargetBootDeps;
    lease?: LeaseHandle;
    /** Test seams for the sweep's process checks (default: procfs and `process.kill`). */
    sweep?: Partial<Pick<SweepDeps, 'isAlive' | 'procStart' | 'identity' | 'now' | 'warn'>>;
  } = {},
): Promise<RealJudge> {
  const report = await checkRealJudgePrerequisites(config, opts.probe);
  if (report.problems.length > 0) throw new RealJudgePrerequisiteError(report.problems);

  const leaseDir = config.leaseDir ?? join(config.workRoot, 'leases');
  let lease: LeaseHandle;
  try {
    lease = opts.lease ?? (await WorkerLease.acquire(leaseDir));
  } catch (err) {
    throw new RealJudgePrerequisiteError([
      `the worker lease cannot be written in leaseDir: ${(err as Error).message.slice(0, 300)}`,
    ]);
  }
  const targets = new CaseTargets({
    lease,
    workRoot: config.workRoot,
    sources: config.sources,
    // The bundle is pinned to the vulnerable commit; the safe tree is built with the same one,
    // and a lockfile it does not cover is refused at the recipe step.
    dependencyBundle: (cf) =>
      report.bundles.find((b) => b.repo === cf.target.repo && b.commit === cf.target.commit)?.ref,
    ...(opts.deps === undefined ? {} : { deps: opts.deps }),
  });
  // Off by default: a sweep removes only runs whose lease proves a dead owner on this host.
  if (config.sweepOrphans === true || config.sweepOrphans === 'force') {
    try {
      await targets.sweepOrphans(leaseDir, lease, {
        forceUnclaimed: config.sweepOrphans === 'force',
        ...opts.sweep,
      });
    } catch (err) {
      await lease.close().catch(() => undefined);
      throw new RealJudgePrerequisiteError([
        `the startup sweep of case networks left by dead workers failed: ${(err as Error).message.slice(0, 300)}`,
      ]);
    }
  }
  const executor = new JailExecutor({
    workRoot: config.workRoot,
    runnerImage: config.runnerImage,
    targets,
    ...(config.traceRoot === undefined ? {} : { traceRoot: config.traceRoot }),
  });
  const workbench = new JailedPatchWorkbench({
    workRoot: config.workRoot,
    applyImage: config.applyImage,
    vulnerableSource: (cf) => targets.sourceDir(cf),
    targets: (cf) => targets.registry(cf),
    dependencyBundle: (cf) => targets.dependencyBundle(cf),
  });
  const judge = new Judge(
    executor,
    config.policy ?? DEFAULT_POLICY,
    config.rescan === undefined ? undefined : { workbench, rescan: config.rescan },
    config.runLogRecorder,
  );
  return {
    judge: new CaseBoundJudge(judge, targets),
    targets,
    evidence: config.evidence,
    signer: config.signer,
    notes: report.notes,
    release: (caseId) => targets.release(caseId),
    // The lease is deleted only after every case network is gone, so a failed teardown stays
    // claimed by this (then dead) worker and a later sweep can remove it.
    close: async () => {
      await targets.close();
      await lease.close();
    },
  };
}
