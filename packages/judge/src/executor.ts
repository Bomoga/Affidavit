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
  /** Raw bytes of the result artifact (see artifact.ts), or null when the runner wrote none. */
  artifact: string | null;
}

/**
 * Runs one attempt of a witness family inside the jail. The real executor arrives with L2-03 and
 * L2-05 (sandbox runner plus runner image); tests use a scripted fake. An executor throws only on
 * infrastructure failure, never because the witness misbehaved.
 */
export interface WitnessExecutor {
  execute(req: ExecutionRequest): Promise<RawAttempt>;
}
