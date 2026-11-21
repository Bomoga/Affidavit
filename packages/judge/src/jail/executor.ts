import type { CaseNetwork } from '@affidavit/sandbox';
import type { ExecutionRequest, RawAttempt, WitnessExecutor } from '../executor.js';
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

/**
 * Cuts `s` to at most `maxBytes` UTF-8 bytes without splitting a character, so output handed to
 * the Judge never exceeds its `maxOutputBytes` (the sandbox runner's own capture cap is larger).
 */
export function capUtf8(s: string, maxBytes: number): string {
  const buf = Buffer.from(s, 'utf8');
  if (buf.length <= maxBytes) return s;
  let end = Math.max(0, maxBytes);
  // Step back over continuation bytes (10xxxxxx) so the cut lands on a character boundary.
  while (end > 0 && ((buf[end] ?? 0) & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString('utf8');
}

export const NO_TARGET: TargetProvider = { endpoint: () => Promise.resolve(null) };

export interface JailExecutorOptions extends WitnessJailOptions {
  targets: TargetProvider;
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
          testTimeoutMs: req.timeoutMs,
        },
        timeoutMs: req.timeoutMs,
        network: endpoint === null ? undefined : { net: endpoint.net, hosts: endpoint.hosts },
      },
      this.opts,
      req.maxArtifactBytes,
    );
    return {
      exitCode: jailed.exitCode,
      timedOut: jailed.timedOut,
      oomKilled: jailed.oomKilled,
      durationMs: jailed.durationMs,
      stdout: capUtf8(jailed.stdout, req.maxOutputBytes),
      stderr: capUtf8(jailed.stderr, req.maxOutputBytes),
      egressAttempts: jailed.trace.egressAttempts,
      traceTampered: jailed.trace.tampered,
      egress: jailed.trace.egress,
      usage: jailed.usage,
      artifact,
    };
  }
}
