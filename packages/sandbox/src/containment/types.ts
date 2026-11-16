/**
 * Containment suite (L2-01). Each probe checks one invariant from the plan.md threat model by
 * misbehaving in exactly one way. A probe passes only when the boundary held (contained) and the
 * runner's own report shows the attempt (recorded).
 */

export const INVARIANTS = [
  'no-egress',
  'no-credential-access',
  'no-evidence-store-access',
  'no-orchestrator-reach',
  'no-writes-outside-scratch',
  'bounded-processes',
  'bounded-memory',
  'bounded-wall-clock',
] as const;
export type Invariant = (typeof INVARIANTS)[number];

/**
 * What a runner saw from outside the jail. A field left undefined means the runner cannot observe
 * it, which counts as "not recorded".
 */
export interface Observations {
  egressAttempts?: number;
  deniedReads?: number;
  deniedWrites?: number;
  pidsLimitHit?: boolean;
  oomKilled?: boolean;
  timedOut?: boolean;
}

export interface JailRunRequest {
  /** Source of an ES module run with `node` inside the jail. */
  script: string;
  /** Passed to the script as one JSON argv entry. Never contains a secret. */
  args: Record<string, unknown>;
  timeoutMs: number;
}

export interface JailRunReport {
  /** Null when the process was killed by a signal or never started. */
  exitCode: number | null;
  durationMs: number;
  stdout: string;
  stderr: string;
  observations: Observations;
}

/** The thing under test: plain Docker today, gVisor in L2-02, the witness-runner jail in L2-03. */
export interface JailRunner {
  readonly name: string;
  run(req: JailRunRequest): Promise<JailRunReport>;
}

/** Host-side facts the suite prepares before a probe and checks after it. */
export interface HostFixtures {
  /** A random token written to `credentialPath` and set in the runner's own environment. */
  credentialCanary: string;
  credentialPath: string;
  /** A random token stored in `evidenceDir/exhibit.bin`. */
  evidenceCanary: string;
  evidenceDir: string;
  orchestratorUrl: string;
}

/** What the suite measured on the host after the probe ran. */
export interface HostChecks {
  orchestratorRequests: number;
  evidenceDirUnchanged: boolean;
  /** Wall time the suite measured around the runner call, so a runner cannot under-report it. */
  elapsedMs: number;
}

export interface ProbeOutcome {
  invariant: Invariant;
  contained: boolean;
  recorded: boolean;
  passed: boolean;
  detail: string;
}

export interface Probe {
  invariant: Invariant;
  /** One line for the report. */
  description: string;
  timeoutMs: number;
  script: string;
  args(fx: HostFixtures): Record<string, unknown>;
  assess(report: JailRunReport, fx: HostFixtures, host: HostChecks): Omit<ProbeOutcome, 'passed'>;
}
