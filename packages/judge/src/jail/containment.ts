import {
  createCaseNetwork,
  removeCaseNetwork,
  type JailRunReport,
  type JailRunRequest,
  type JailRunner,
} from '@affidavit/sandbox';
import { DEFAULT_POLICY } from '../rules.js';
import { runWitnessJail, type WitnessJailOptions } from './jail.js';

/**
 * A probe is top-level code that reads its arguments from `process.argv[2]`. As a witness it gets
 * those arguments set first, and one passing `witness()` call at the end so the runner sees a
 * valid one-parameter family. Imports are hoisted in ES modules, so the appended import is legal.
 * The probe's own misbehaviour (for example a timer that never stops) is what the jail sees.
 */
export const asWitness = (probe: string, args: unknown): string =>
  [
    `process.argv[2] = ${JSON.stringify(JSON.stringify(args))};`,
    probe,
    `import { witness as affidavitWitness } from '@affidavit/witness';`,
    'affidavitWitness(() => {});',
    '',
  ].join('\n');

/**
 * Runs each containment probe (L2-01) as a witness: the probe is the witness module, executed by
 * the witness harness, in the witness jail, on its own case network. This is the L2-03 "done
 * when": the suite must pass when the misbehaving code is a witness.
 */
export class WitnessJailRunner implements JailRunner {
  readonly name = 'witness jail (gVisor, case network)';
  constructor(private readonly opts: WitnessJailOptions) {}

  async run(req: JailRunRequest): Promise<JailRunReport> {
    const net = await createCaseNetwork();
    try {
      const { jailed } = await runWitnessJail(
        {
          source: asWitness(req.script, req.args),
          input: { schemaVersion: 1, params: [], target: null, testTimeoutMs: req.timeoutMs },
          timeoutMs: req.timeoutMs,
          network: { net, hosts: {} },
        },
        this.opts,
        DEFAULT_POLICY.maxArtifactBytes,
      );
      if (jailed.trace.tampered) {
        throw new Error('syscall trace was tampered with by the probe; the run cannot be judged');
      }
      return {
        exitCode: jailed.exitCode,
        durationMs: jailed.durationMs,
        stdout: jailed.stdout,
        stderr: jailed.stderr,
        observations: {
          egressAttempts: jailed.trace.egressAttempts,
          deniedReads: jailed.trace.deniedReads,
          deniedWrites: jailed.trace.deniedWrites,
          pidsLimitHit: jailed.trace.pidsLimitHit,
          oomKilled: jailed.oomKilled,
          timedOut: jailed.timedOut,
        },
      };
    } finally {
      await removeCaseNetwork(net);
    }
  }
}
