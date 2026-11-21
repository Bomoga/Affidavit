import { CaseFile } from '@affidavit/contracts';
import type { TargetRef, TargetVariant } from '@affidavit/contracts';
import {
  bootTarget,
  buildTarget,
  createCaseNetwork,
  removeCaseNetwork,
  type BootOutcome,
  type BootRecipe,
  type BuildOptions,
  type BuildOutcome,
  type CaseNetwork,
  type DependencyBundleRef,
} from '@affidavit/sandbox';
import { canonicalJson } from '../canonical.js';
import type { EvidenceVariant, ExecutionRequest } from '../executor.js';
import { BootedTargets, type BootedTarget } from './booted.js';
import type { TargetEndpoint, TargetProvider } from './executor.js';

/**
 * Where a variant's pinned source tree is on this host. `ok: false` is a refusal (no tree for
 * that repo, commit and variant), which makes the case `unsupported`, never a run without it.
 */
export type SourceResolution = { ok: true; dir: string } | { ok: false; reason: string };

/**
 * Finds the source tree of one variant of a case: the vulnerable commit (`caseFile.target`) or
 * the known-safe variant (`caseFile.safeVariant`). The tree is read only (staged by the build,
 * never written). It must be a verified checkout, for example one `fetch-pinned.mjs` produced
 * (commit, tree and archive checked, safe-variant patches applied): the provider cannot check a
 * commit itself, because it never runs git on an untrusted tree.
 */
export type SourceResolver = (
  caseFile: CaseFile,
  variant: EvidenceVariant,
) => Promise<SourceResolution>;

/** One verified tree on this host, for `directorySources`. */
export interface SourceDirectory {
  repo: string;
  commit: string;
  variant: EvidenceVariant;
  /** Absolute host path of the checkout. */
  dir: string;
}

/**
 * A `SourceResolver` over a fixed list of checkouts, keyed by repo, commit and variant. A case
 * whose target or safe variant is not in the list is refused, never resolved to another tree.
 * Two entries for the same key are a configuration error.
 */
export function directorySources(entries: readonly SourceDirectory[]): SourceResolver {
  const byKey = new Map<string, string>();
  for (const e of entries) {
    const key = `${e.repo}\n${e.commit}\n${e.variant}`;
    if (byKey.has(key)) {
      throw new Error(`two source directories for ${e.repo} at ${e.commit} (${e.variant})`);
    }
    if (!e.dir.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(e.dir)) {
      throw new Error(`the source directory for ${e.repo} (${e.variant}) must be absolute`);
    }
    byKey.set(key, e.dir);
  }
  return (caseFile, variant) => {
    const ref = variant === 'vulnerable' ? caseFile.target : caseFile.safeVariant;
    if (ref === undefined) {
      return Promise.resolve({
        ok: false,
        reason: `case ${caseFile.id} has no ${variant} variant`,
      });
    }
    const dir = byKey.get(`${ref.repo}\n${ref.commit}\n${variant}`);
    return Promise.resolve(
      dir === undefined
        ? { ok: false, reason: `no ${variant} source tree for ${ref.repo} at ${ref.commit}` }
        : { ok: true, dir },
    );
  };
}

/**
 * The sandbox steps the provider uses, injectable so the ordering and teardown can be tested
 * without Docker. The defaults are the L2-04 boot recipes under the gVisor runner.
 */
export interface TargetBootDeps {
  buildTarget(
    srcDir: string,
    hints: CaseFile['bootHints'],
    opts: BuildOptions,
  ): Promise<BuildOutcome>;
  createCaseNetwork(): Promise<CaseNetwork>;
  bootTarget(net: CaseNetwork, imageId: string, recipe: BootRecipe): Promise<BootOutcome>;
  removeCaseNetwork(net: CaseNetwork): Promise<void>;
}

export const SANDBOX_BOOT: TargetBootDeps = {
  buildTarget,
  createCaseNetwork,
  bootTarget,
  removeCaseNetwork,
};

/**
 * Why a case's targets could not be booted. `unsupported`: outside what the MVP can boot without
 * weakening a control (no verified source tree, a dependency fetch, a base that is not official
 * `node`, a safe variant that boots differently from the vulnerable one). `boot-failed`: it should
 * boot but did not (a failed build step, an unhealthy target, a Docker error).
 */
export interface CaseBootFailure {
  ok: false;
  kind: 'unsupported' | 'boot-failed';
  variant: EvidenceVariant;
  step: 'source' | 'build' | 'compare' | 'network' | 'boot';
  /** Host paths are already scrubbed by the build; this never carries a secret. */
  reason: string;
  /** Set when tearing down what was started also failed, so something may be left running. */
  teardown?: string;
}

export interface CaseBootSuccess {
  ok: true;
  /** The booted image ID per variant, for `BundleManifest.targetDigests`. */
  digests: Partial<Record<TargetVariant, string>>;
  /**
   * The case file with `target.imageDigest` (and `safeVariant.imageDigest`) set to the booted
   * images. The Judge runs on this copy, so `BootedTargets` serves a variant only for the exact
   * image the evidence names. The stored case file is never changed.
   */
  caseFile: CaseFile;
  /** Operational signals (a build directory not fully removed); not part of the outcome. */
  warnings: string[];
}

export type CaseBootOutcome = CaseBootSuccess | CaseBootFailure;

/**
 * Thrown by `CaseTargets.bind` (and so by the case-bound Judge) when a case's targets cannot be
 * booted. It is an infrastructure failure, never evidence: the Judge runs no witness for the case,
 * so the differential rule is never skipped, and the worker fails the stage attempt, which ends in
 * a review flag, never a dismissal.
 */
export class CaseBootError extends Error {
  constructor(
    readonly caseId: string,
    readonly failure: CaseBootFailure,
  ) {
    super(
      `case ${caseId}: ${failure.variant} target ${failure.kind} at ${failure.step}: ${failure.reason}` +
        (failure.teardown === undefined ? '' : ` (teardown: ${failure.teardown})`),
    );
    this.name = 'CaseBootError';
  }
}

export interface CaseTargetsOptions {
  /** Quota'd host directory for builds (boot-recipes.md, host setup). Never the evidence store. */
  workRoot: string;
  sources: SourceResolver;
  /** The pinned dependency bundle for a case (`pinnedDependencyBundle`), if it has one. */
  dependencyBundle?: (caseFile: CaseFile) => DependencyBundleRef | undefined;
  deps?: TargetBootDeps;
}

interface Session {
  /** Identity of the case file the targets were booted for (target, safe variant, boot hints). */
  key: string;
  outcome: CaseBootOutcome;
  targets: BootedTargets;
  booted: Partial<Record<EvidenceVariant, BootedTarget>>;
  sources: Partial<Record<EvidenceVariant, string>>;
}

const withoutDigest = (ref: TargetRef | undefined) => {
  if (ref === undefined) return null;
  return { repo: ref.repo, commit: ref.commit, variant: ref.variant };
};

/** What a session is booted for: two case files that agree on it share the same targets. */
const caseKey = (cf: CaseFile): string =>
  canonicalJson({
    target: withoutDigest(cf.target),
    safeVariant: withoutDigest(cf.safeVariant),
    bootHints: cf.bootHints,
  });

const message = (err: unknown): string =>
  (err instanceof Error ? err.message : String(err)).slice(0, 800);

/**
 * Null when the safe variant's recipe exposes the same surface to the witness as the vulnerable
 * one: the same target port and health route, the same sidecar names and the same stub aliases.
 * Otherwise the witness could tell the variants apart by what answers where, and pass the
 * differential rule without exploiting anything (executor.ts, the variant invariant).
 */
export function recipeSurfaceMismatch(vulnerable: BootRecipe, safe: BootRecipe): string | null {
  const surface = (r: BootRecipe) => ({
    port: r.port,
    healthRoute: r.healthRoute,
    sidecars: r.sidecars.map((s) => s.name).sort(),
    stubs: r.stubs.map((s) => s.hostAlias).sort(),
  });
  const v = surface(vulnerable);
  const s = surface(safe);
  for (const k of Object.keys(v) as (keyof typeof v)[]) {
    if (canonicalJson(v[k]) !== canonicalJson(s[k])) {
      return `the safe variant's ${k} differs from the vulnerable variant's`;
    }
  }
  return null;
}

/**
 * The real target provider (CR-11): boots a case's vulnerable and safe variants from their pinned
 * trees, records the image digests, and serves their endpoints to the witness jail. It is the
 * `TargetProvider` the `JailExecutor` uses.
 *
 * `boot` order, every step fail closed:
 * 1. Resolve the vulnerable tree, then the safe tree when the case file has a safe variant. A
 *    refusal is `unsupported` at `source`; nothing is built.
 * 2. Build the vulnerable image, then the safe image (`buildTarget`: stage, recipe from the boot
 *    hints with `deriveRecipe`, pinned base, offline scripts, assemble with no network), each with
 *    the case's pinned dependency bundle when it has one. Both are built before anything runs.
 * 3. Compare the two recipes' surfaces (`recipeSurfaceMismatch`); a difference is `unsupported`.
 * 4. Boot the vulnerable target on a fresh case network, then the safe target on its own, each
 *    waiting for its health route. Their witness-facing URL and host names must match.
 * 5. Record both image IDs. Only then can any witness run for the case.
 *
 * A failure at any step tears down every case network the boot created (which removes the target,
 * its sidecars and their anonymous volumes) and returns a typed `CaseBootFailure`; Docker errors
 * become `boot-failed`, never an exception out of `boot`. A case with a safe variant is never
 * served with only its vulnerable target. Images are kept: evidence names them by ID.
 *
 * Sessions are keyed by case id. `unsupported` is remembered (it does not change on a retry);
 * `boot-failed` is not, so the next call boots again. `release` (one case) and `close` (all) tear
 * down; the worker calls them when a case ends and on shutdown.
 */
export class CaseTargets implements TargetProvider {
  readonly #opts: CaseTargetsOptions;
  readonly #deps: TargetBootDeps;
  readonly #sessions = new Map<string, Promise<Session>>();

  constructor(opts: CaseTargetsOptions) {
    this.#opts = opts;
    this.#deps = opts.deps ?? SANDBOX_BOOT;
  }

  /** Boots the case's targets, or returns the session already booted for it. Never throws. */
  async boot(caseFile: CaseFile): Promise<CaseBootOutcome> {
    return (await this.#session(caseFile)).outcome;
  }

  /**
   * The case file the Judge should run on: the caller's, with the booted image digests filled in.
   * Throws `CaseBootError` when the targets cannot be booted, and an Error when the caller's case
   * file already names other images than the booted ones (evidence is tied to what ran).
   */
  async bind(caseFile: CaseFile): Promise<CaseFile> {
    const cf = CaseFile.parse(caseFile);
    const session = await this.#session(cf);
    const outcome = session.outcome;
    if (!outcome.ok) throw new CaseBootError(cf.id, outcome);
    const named: [EvidenceVariant, TargetRef | undefined][] = [
      ['vulnerable', cf.target],
      ['safe', cf.safeVariant],
    ];
    for (const [variant, ref] of named) {
      const booted = outcome.digests[variant];
      if (ref?.imageDigest !== undefined && ref.imageDigest !== booted) {
        throw new Error(
          `case ${cf.id} names ${variant} image ${ref.imageDigest}, but ${booted ?? 'none'} was booted`,
        );
      }
    }
    return CaseFile.parse({
      ...cf,
      target: { ...cf.target, imageDigest: outcome.digests.vulnerable },
      ...(cf.safeVariant === undefined
        ? {}
        : { safeVariant: { ...cf.safeVariant, imageDigest: outcome.digests.safe } }),
    });
  }

  /**
   * The endpoint for one execution request, from the case's own `BootedTargets` (which also checks
   * the request's `imageDigest` against the booted image). A case that was not booted, or whose
   * boot failed, is an infrastructure failure: the request is refused, never run without a target.
   */
  async endpoint(req: ExecutionRequest): Promise<TargetEndpoint> {
    const pending = this.#sessions.get(req.caseFile.id);
    if (pending === undefined) throw new Error(`case ${req.caseFile.id} has no booted targets`);
    const session = await pending;
    if (!session.outcome.ok) throw new CaseBootError(req.caseFile.id, session.outcome);
    if (session.key !== caseKey(req.caseFile)) {
      throw new Error(`case ${req.caseFile.id} was booted from another case file`);
    }
    return session.targets.endpoint(req);
  }

  /**
   * The case's `BootedTargets`, where the patch workbench registers the `patched` target while a
   * patch is verified. Throws for a case that is not booted.
   */
  async registry(caseFile: CaseFile): Promise<BootedTargets> {
    return (await this.#ready(caseFile)).targets;
  }

  /** Host path of a booted case's vulnerable tree (read only), for the patch workbench. */
  async sourceDir(caseFile: CaseFile): Promise<string> {
    const dir = (await this.#ready(caseFile)).sources.vulnerable;
    if (dir === undefined) throw new Error(`case ${caseFile.id} has no vulnerable source tree`);
    return dir;
  }

  /** The dependency bundle sha256 each booted variant was built from, for `toolVersions`. */
  async dependencyBundles(caseFile: CaseFile): Promise<Partial<Record<EvidenceVariant, string>>> {
    const out: Partial<Record<EvidenceVariant, string>> = {};
    for (const [v, t] of Object.entries((await this.#ready(caseFile)).booted)) {
      if (t.dependencyBundleSha256 !== undefined) {
        out[v as EvidenceVariant] = t.dependencyBundleSha256;
      }
    }
    return out;
  }

  /** The case's pinned dependency bundle, as the boot used it. */
  dependencyBundle(caseFile: CaseFile): DependencyBundleRef | undefined {
    return this.#opts.dependencyBundle?.(caseFile);
  }

  /** Booted case ids, for the worker's shutdown and its leak checks. */
  get caseIds(): string[] {
    return [...this.#sessions.keys()];
  }

  /**
   * Tears down a case's targets (both case networks, so every container and anonymous volume on
   * them) and forgets the session. Tries every network, then throws the first error. A case with
   * no session is a no-op. A `patched` target the workbench still holds is the workbench's to
   * release.
   */
  async release(caseId: string): Promise<void> {
    const pending = this.#sessions.get(caseId);
    if (pending === undefined) return;
    this.#sessions.delete(caseId);
    const session = await pending;
    let first: Error | undefined;
    for (const v of ['safe', 'vulnerable'] as const) {
      const t = session.booted[v];
      if (t === undefined) continue;
      try {
        await this.#deps.removeCaseNetwork(t.endpoint.net);
      } catch (err) {
        first ??= err instanceof Error ? err : new Error(message(err));
      }
      session.targets.delete(v);
    }
    if (first !== undefined) throw first;
  }

  /** Releases every case; tries all, then throws the first error. */
  async close(): Promise<void> {
    let first: Error | undefined;
    for (const id of this.caseIds) {
      try {
        await this.release(id);
      } catch (err) {
        first ??= err instanceof Error ? err : new Error(message(err));
      }
    }
    if (first !== undefined) throw first;
  }

  async #ready(caseFile: CaseFile): Promise<Session> {
    const pending = this.#sessions.get(caseFile.id);
    if (pending === undefined) throw new Error(`case ${caseFile.id} has no booted targets`);
    const session = await pending;
    if (!session.outcome.ok) throw new CaseBootError(caseFile.id, session.outcome);
    if (session.key !== caseKey(caseFile)) {
      throw new Error(`case ${caseFile.id} was booted from another case file`);
    }
    return session;
  }

  async #session(caseFile: CaseFile): Promise<Session> {
    const cf = CaseFile.parse(caseFile);
    const key = caseKey(cf);
    const existing = this.#sessions.get(cf.id);
    if (existing !== undefined) {
      const session = await existing;
      if (session.key !== key) {
        throw new Error(`case ${cf.id} was booted from another case file`);
      }
      // A failed boot may be transient; an unsupported one is not.
      if (session.outcome.ok || session.outcome.kind === 'unsupported') return session;
      if (this.#sessions.get(cf.id) === existing) this.#sessions.delete(cf.id);
      return this.#session(cf);
    }
    const started = this.#bootSession(cf, key);
    this.#sessions.set(cf.id, started);
    return started;
  }

  async #bootSession(cf: CaseFile, key: string): Promise<Session> {
    const session: Session = {
      key,
      outcome: {
        ok: false,
        kind: 'boot-failed',
        variant: 'vulnerable',
        step: 'source',
        reason: '',
      },
      targets: new BootedTargets(),
      booted: {},
      sources: {},
    };
    session.outcome = await this.#bootBoth(cf, session);
    return session;
  }

  async #bootBoth(cf: CaseFile, session: Session): Promise<CaseBootOutcome> {
    const variants: EvidenceVariant[] =
      cf.safeVariant === undefined ? ['vulnerable'] : ['vulnerable', 'safe'];
    const warnings: string[] = [];
    const fail = (
      kind: CaseBootFailure['kind'],
      variant: EvidenceVariant,
      step: CaseBootFailure['step'],
      reason: string,
    ): CaseBootFailure => ({ ok: false, kind, variant, step, reason });

    // 1. Sources.
    for (const v of variants) {
      let src: SourceResolution;
      try {
        src = await this.#opts.sources(cf, v);
      } catch (err) {
        return fail('boot-failed', v, 'source', `source lookup failed: ${message(err)}`);
      }
      if (!src.ok) return fail('unsupported', v, 'source', src.reason);
      session.sources[v] = src.dir;
    }

    // 2. Builds, all before any boot.
    let bundle: DependencyBundleRef | undefined;
    try {
      bundle = this.#opts.dependencyBundle?.(cf);
    } catch (err) {
      return fail('boot-failed', 'vulnerable', 'build', `dependency bundle: ${message(err)}`);
    }
    const built: Partial<Record<EvidenceVariant, Extract<BuildOutcome, { ok: true }>>> = {};
    for (const v of variants) {
      let out: BuildOutcome;
      try {
        out = await this.#deps.buildTarget(session.sources[v] as string, cf.bootHints, {
          workRoot: this.#opts.workRoot,
          ...(bundle === undefined ? {} : { dependencyBundle: bundle }),
        });
      } catch (err) {
        return fail('boot-failed', v, 'build', `build error: ${message(err)}`);
      }
      if (out.leftovers !== undefined) warnings.push(`${v} build: ${out.leftovers}`);
      if (!out.ok) {
        return fail(
          out.unsupported ? 'unsupported' : 'boot-failed',
          v,
          'build',
          `${out.step}: ${out.reason}`,
        );
      }
      built[v] = out;
    }

    // 3. The safe variant must look the same to the witness.
    if (built.safe !== undefined && built.vulnerable !== undefined) {
      const mismatch = recipeSurfaceMismatch(built.vulnerable.recipe, built.safe.recipe);
      if (mismatch !== null) return fail('unsupported', 'safe', 'compare', mismatch);
    }

    // 4. Boots, each on its own case network; any failure removes every network made so far.
    const nets: CaseNetwork[] = [];
    const teardown = async (failure: CaseBootFailure): Promise<CaseBootFailure> => {
      const problems: string[] = [];
      for (const net of nets.reverse()) {
        try {
          await this.#deps.removeCaseNetwork(net);
        } catch (err) {
          problems.push(`${net.name}: ${message(err)}`);
        }
      }
      session.booted = {};
      return problems.length === 0 ? failure : { ...failure, teardown: problems.join('; ') };
    };
    for (const v of variants) {
      const b = built[v] as Extract<BuildOutcome, { ok: true }>;
      let net: CaseNetwork;
      try {
        net = await this.#deps.createCaseNetwork();
      } catch (err) {
        return teardown(fail('boot-failed', v, 'network', `case network: ${message(err)}`));
      }
      nets.push(net);
      let boot: BootOutcome;
      try {
        boot = await this.#deps.bootTarget(net, b.imageId, b.recipe);
      } catch (err) {
        return teardown(fail('boot-failed', v, 'boot', `boot error: ${message(err)}`));
      }
      if (boot.status !== 'healthy') {
        return teardown(
          fail(
            boot.status === 'unsupported' ? 'unsupported' : 'boot-failed',
            v,
            'boot',
            boot.reason,
          ),
        );
      }
      session.booted[v] = {
        endpoint: { net, hosts: boot.hosts, url: boot.url },
        imageId: b.imageId,
        sidecarImages: boot.sidecarImages,
        recipe: b.recipe,
        ...(b.dependencyBundle === undefined
          ? {}
          : { dependencyBundleSha256: b.dependencyBundle.sha256 }),
      };
    }
    const vt = session.booted.vulnerable as BootedTarget;
    const st = session.booted.safe;
    if (
      st !== undefined &&
      (st.endpoint.url !== vt.endpoint.url ||
        canonicalJson(Object.keys(st.endpoint.hosts).sort()) !==
          canonicalJson(Object.keys(vt.endpoint.hosts).sort()))
    ) {
      return teardown(
        fail(
          'unsupported',
          'safe',
          'compare',
          'the safe target answers at another URL or host names',
        ),
      );
    }

    // 5. Record.
    const digests: Partial<Record<TargetVariant, string>> = { vulnerable: vt.imageId };
    session.targets.set('vulnerable', vt);
    if (st !== undefined) {
      digests.safe = st.imageId;
      session.targets.set('safe', st);
    }
    const bound = CaseFile.parse({
      ...cf,
      target: { ...cf.target, imageDigest: vt.imageId },
      ...(cf.safeVariant === undefined || st === undefined
        ? {}
        : { safeVariant: { ...cf.safeVariant, imageDigest: st.imageId } }),
    });
    return { ok: true, digests, caseFile: bound, warnings };
  }
}
