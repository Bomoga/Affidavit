import type { CaseFile, ParamSpace, TargetRef } from '@affidavit/contracts';
import type { EgressEvent, RunUsage } from '@affidavit/sandbox';

export type Attempt = 1 | 2 | 3;

/** The variants a witness or counterexample is judged on. `patched` belongs to verifyPatch. */
export type EvidenceVariant = 'vulnerable' | 'safe';

/** Every variant an executor may be asked to run; `patched` comes only from verifyPatch (L2-07). */
export type ExecutionVariant = EvidenceVariant | 'patched';

export interface ExecutionRequest {
  caseFile: CaseFile;
  variant: ExecutionVariant;
  target: TargetRef;
  attempt: Attempt;
  /** Witness or counterexample source. Untrusted: it only ever runs inside the jail. */
  template: string;
  params: ParamSpace;
  /** Hard wall clock. The executor kills the run at this point and reports `timedOut`. */
  timeoutMs: number;
  /**
   * Cap on stdout and on stderr, each in UTF-8 bytes. The executor stops collecting a stream at
   * this size while the run goes; the Judge throws on output over it (JudgePolicy.maxOutputBytes).
   */
  maxOutputBytes: number;
  /**
   * The Judge's artifact limit. The executor reads at most one byte more, so an oversized
   * artifact still reaches the Judge as oversized and one within the limit is never cut.
   */
  maxArtifactBytes: number;
}

/** What the executor observed for one run, before the Judge decides anything. */
export interface RawAttempt {
  /** Null when the run was killed or never exited. */
  exitCode: number | null;
  timedOut: boolean;
  oomKilled: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
  egressAttempts: number;
  /**
   * The jailed process wrote into the syscall trace in a way that could hide an attempt (see
   * packages/sandbox/src/gvisor/trace.ts), so `egressAttempts` cannot be trusted for this run.
   */
  traceTampered: boolean;
  /**
   * The egress attempts gVisor recorded, at most the first 50 (`MAX_EGRESS_EVENTS`); every one
   * is still counted in `egressAttempts`. Optional: an executor without a trace lists none.
   */
  egress?: readonly EgressEvent[];
  /**
   * True only when the executor read this run's whole syscall trace and found it intact, so
   * `egress` is a complete record (up to its cap) and an empty one means nothing tried to leave.
   * Absent or false when tracing was off, the trace passed its size cap, or it was tampered with:
   * the run's egress was then not observed, and the run log says so.
   */
  egressObserved?: boolean;
  /** Peak memory and CPU time the executor measured (L2-11). Optional, like `egress`. */
  usage?: RunUsage;
  /** Raw bytes of the result artifact (see artifact.ts), or null when the runner wrote none. */
  artifact: string | null;
}

/**
 * Runs one attempt of a witness family inside the jail. The real executor arrives with L2-03 and
 * L2-05 (sandbox runner plus runner image); tests use a scripted fake. An executor throws only on
 * infrastructure failure, never because the witness misbehaved.
 *
 * Invariant: the vulnerable and safe variants are indistinguishable to the witness. `variant` and
 * `target` tell the executor what to boot; they never reach the witness. Both variants are
 * reached at the same internal hostname and port, with the same environment, the same mounts,
 * the same parameters and the same limits, so a witness cannot pass the differential rule by
 * detecting which variant it is talking to instead of exploiting the bug.
 */
export interface WitnessExecutor {
  execute(req: ExecutionRequest): Promise<RawAttempt>;
}
