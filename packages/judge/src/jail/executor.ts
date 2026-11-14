import type { CaseNetwork } from '@affidavit/sandbox';
import type { ExecutionRequest, RawAttempt, WitnessExecutor } from '../executor.js';
import { DEFAULT_POLICY } from '../rules.js';
import { runWitnessJail, type WitnessJailOptions } from './jail.js';

/** Where the witness finds the target for one request. */
export interface TargetEndpoint {
  net: CaseNetwork;
  /** Names written into the witness's /etc/hosts, for example `{ target: '172.18.0.2' }`. */
  hosts: Readonly<Record<string, string>>;
  /** Base URL handed to the witness, for example `http://target:4000`. */
  url: string;
}

/**
 * Boots or finds the target for a request. Booting real targets is L2-04; until then tests use a
 * stub target started with `startJailedService`. Returning null runs the witness with no network.
 */
export interface TargetProvider {
  endpoint(req: ExecutionRequest): Promise<TargetEndpoint | null>;
}

export const NO_TARGET: TargetProvider = { endpoint: () => Promise.resolve(null) };

export interface JailExecutorOptions extends WitnessJailOptions {
  targets: TargetProvider;
  /** Bytes read from the artifact before the Judge sees it; keep equal to the Judge's policy. */
  maxArtifactBytes?: number;
}

/**
 * The real `WitnessExecutor` (L2-03): every attempt runs in a fresh gVisor container on the
 * case network, with no credential, no handle to the evidence store and no route to the host.
 * Throws only on infrastructure failure, as the port requires.
 */
export class JailExecutor implements WitnessExecutor {
  constructor(private readonly opts: JailExecutorOptions) {}

  async execute(req: ExecutionRequest): Promise<RawAttempt> {
    const endpoint = await this.opts.targets.endpoint(req);
    const { jailed, artifact } = await runWitnessJail(
      {
        source: req.template,
        input: {
          schemaVersion: 1,
          params: req.params,
          target: endpoint === null ? null : { url: endpoint.url },
        },
        timeoutMs: req.timeoutMs,
        network: endpoint === null ? undefined : { net: endpoint.net, hosts: endpoint.hosts },
      },
      this.opts,
      this.opts.maxArtifactBytes ?? DEFAULT_POLICY.maxArtifactBytes,
    );
    return {
      exitCode: jailed.exitCode,
      timedOut: jailed.timedOut,
      oomKilled: jailed.oomKilled,
      durationMs: jailed.durationMs,
      stdout: jailed.stdout,
      stderr: jailed.stderr,
      egressAttempts: jailed.trace.egressAttempts,
      traceTampered: jailed.trace.tampered,
      artifact,
    };
  }
}
