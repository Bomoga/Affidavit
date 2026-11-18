import type { BootHints } from '@affidavit/contracts';
import {
  bootTarget,
  buildTarget,
  createCaseNetwork,
  removeCaseNetwork,
  type BootRecipe,
  type CaseNetwork,
} from '@affidavit/sandbox';
import type { ExecutionRequest } from '../executor.js';
import type { TargetEndpoint, TargetProvider } from './executor.js';

/** A target built from source with the L2-04 boot recipes and running on its own case network. */
export interface BootedTarget {
  endpoint: TargetEndpoint;
  /** Local image ID of the built target, usable as `TargetRef.imageDigest`. */
  imageId: string;
  /** Pinned sidecar images by service name, for the evidence bundle. */
  sidecarImages: Readonly<Record<string, string>>;
  /** The recipe the target was built and booted with (working directory, command). */
  recipe: BootRecipe;
}

export class TargetBootError extends Error {
  constructor(
    readonly step: 'build' | 'boot',
    readonly outcome: 'unsupported' | 'failed',
    readonly reason: string,
  ) {
    super(`target ${step} ${outcome}: ${reason}`);
    this.name = 'TargetBootError';
  }
}

/**
 * Builds and boots one target variant (split build, then boot with sidecars and health check) on a
 * fresh case network. Throws `TargetBootError` when it cannot boot; the network is removed then.
 * On success the caller owns the network and removes it with `removeCaseNetwork`, which also
 * removes the target and its sidecars.
 */
export async function bootVariant(
  srcDir: string,
  hints: BootHints,
  opts: { workRoot: string },
): Promise<BootedTarget> {
  const build = await buildTarget(srcDir, hints, { workRoot: opts.workRoot });
  if (!build.ok) {
    throw new TargetBootError('build', build.unsupported ? 'unsupported' : 'failed', build.reason);
  }
  const net: CaseNetwork = await createCaseNetwork();
  try {
    const boot = await bootTarget(net, build.imageId, build.recipe);
    if (boot.status !== 'healthy') throw new TargetBootError('boot', boot.status, boot.reason);
    return {
      endpoint: { net, hosts: boot.hosts, url: boot.url },
      imageId: build.imageId,
      sidecarImages: boot.sidecarImages,
      recipe: build.recipe,
    };
  } catch (err) {
    await removeCaseNetwork(net);
    throw err;
  }
}

type Variant = ExecutionRequest['variant'];

/**
 * `TargetProvider` over targets that are already running, one per variant. Asking for a variant
 * that has no target is an infrastructure failure, so it throws instead of running the witness
 * with no target (which would make a real witness fail and look like evidence). The patch
 * workbench registers the `patched` target while a patch is being verified and removes it after.
 */
export class BootedTargets implements TargetProvider {
  readonly #byVariant = new Map<Variant, BootedTarget>();

  constructor(initial: Readonly<Partial<Record<Variant, BootedTarget>>> = {}) {
    for (const [v, t] of Object.entries(initial) as [Variant, BootedTarget | undefined][]) {
      if (t !== undefined) this.#byVariant.set(v, t);
    }
  }

  set(variant: Variant, target: BootedTarget): void {
    if (this.#byVariant.has(variant)) throw new Error(`a ${variant} target is already registered`);
    this.#byVariant.set(variant, target);
  }

  delete(variant: Variant): void {
    this.#byVariant.delete(variant);
  }

  endpoint(req: ExecutionRequest): Promise<TargetEndpoint> {
    const t = this.#byVariant.get(req.variant);
    if (t === undefined) {
      return Promise.reject(new Error(`no booted target for the ${req.variant} variant`));
    }
    return Promise.resolve(t.endpoint);
  }
}
