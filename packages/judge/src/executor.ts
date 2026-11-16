import type { CaseFile, ParamSpace, TargetRef } from '@affidavit/contracts';

export type Attempt = 1 | 2 | 3;

/** The variants a witness or counterexample is judged on. `patched` belongs to verifyPatch. */
export type EvidenceVariant = 'vulnerable' | 'safe';

export interface ExecutionRequest {
  caseFile: CaseFile;
  variant: EvidenceVariant;
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
