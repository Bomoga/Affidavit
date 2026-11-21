/**
 * Host prerequisites of the real implementations, checked once at startup before any connection
 * is opened. Every missing piece is listed in one error, by variable name or host fact, never by
 * value. Wiring only: what each Lane 2 piece needs is stated in its own docs, this checks it.
 */
import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { AUDIT_RUNTIME, DEFAULT_TRACE_ROOT, PLAIN_RUNTIME } from '@affidavit/sandbox';
import type { WorkerConfig } from '../config.js';

const exec = promisify(execFile);

/** The two gVisor runtimes `docker/sandbox/` registers (sandbox-runner.md, Host setup). */
const PLAIN_RUNSC = PLAIN_RUNTIME;
const AUDIT_RUNSC = AUDIT_RUNTIME;
/** Where the audit runtime writes syscall traces (setup-runsc-audit.sh). */
const TRACE_ROOT = DEFAULT_TRACE_ROOT;

export interface HostProbe {
  platform: NodeJS.Platform;
  isDirectory(path: string): Promise<boolean>;
  isSocket(path: string): Promise<boolean>;
  /** Registered Docker runtimes, or null when the Docker daemon cannot be reached. */
  dockerRuntimes(): Promise<string[] | null>;
  imagePresent(ref: string): Promise<boolean>;
}

export const realHostProbe: HostProbe = {
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
  async dockerRuntimes() {
    try {
      const { stdout } = await exec('docker', ['info', '--format', '{{json .Runtimes}}'], {
        timeout: 20_000,
      });
      const parsed: unknown = JSON.parse(stdout);
      return parsed !== null && typeof parsed === 'object' ? Object.keys(parsed) : [];
    } catch {
      return null;
    }
  },
  async imagePresent(ref) {
    try {
      await exec('docker', ['image', 'inspect', '--format', '{{.Id}}', ref], { timeout: 20_000 });
      return true;
    } catch {
      return false;
    }
  },
};

export class PrerequisiteError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(
      `the real wiring cannot start, nothing was started: ${problems.join('; ')} (see docs/lanes/lane1/real-wiring.md)`,
    );
    this.name = 'PrerequisiteError';
  }
}

function inside(child: string, parent: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** Throws PrerequisiteError listing everything missing for the configured real implementations. */
export async function checkPrerequisites(
  config: WorkerConfig,
  probe: HostProbe = realHostProbe,
): Promise<void> {
  const problems: string[] = [];
  const intake = config.intakeSettings;
  const judge = config.judgeSettings;
  const needsGvisor = intake?.toolRunner === 'gvisor' || judge !== null;
  const needsDocker = intake !== null || judge !== null;

  if (needsGvisor && probe.platform !== 'linux') {
    problems.push(
      `${judge ? 'AFFIDAVIT_JUDGE_IMPL=real' : 'AFFIDAVIT_TOOLRUNNER=gvisor'} needs a Linux sandbox host with gVisor (this host is ${probe.platform})`,
    );
  }
  let runtimes: string[] | null = [];
  if (needsDocker) {
    runtimes = await probe.dockerRuntimes();
    if (runtimes === null)
      problems.push('the Docker daemon cannot be reached (docker info failed)');
  }
  if (runtimes !== null && needsGvisor) {
    if (!runtimes.includes(PLAIN_RUNSC)) {
      problems.push(
        `Docker has no "${PLAIN_RUNSC}" runtime (run docker/sandbox/install-gvisor.sh as root)`,
      );
    }
    if (judge && !runtimes.includes(AUDIT_RUNSC)) {
      problems.push(
        `Docker has no "${AUDIT_RUNSC}" runtime (run docker/sandbox/setup-runsc-audit.sh as root)`,
      );
    }
  }

  if (intake && intake.workRoot !== '' && !(await probe.isDirectory(intake.workRoot))) {
    problems.push('AFFIDAVIT_INTAKE_WORK_ROOT is not an existing directory');
  }

  if (judge) {
    if (!(await probe.isDirectory(TRACE_ROOT))) {
      problems.push(
        `the syscall trace directory ${TRACE_ROOT} does not exist (run docker/sandbox/setup-runsc-audit.sh as root)`,
      );
    }
    if (!(await probe.isDirectory(judge.workRoot))) {
      problems.push('AFFIDAVIT_JUDGE_WORK_ROOT is not an existing directory');
    }
    if (!(await probe.isDirectory(judge.evidenceDir))) {
      problems.push('AFFIDAVIT_EVIDENCE_DIR is not an existing directory');
    }
    // The witness runner must have no writable path to the evidence store (root CLAUDE.md).
    if (
      judge.workRoot !== '' &&
      judge.evidenceDir !== '' &&
      (inside(judge.workRoot, judge.evidenceDir) || inside(judge.evidenceDir, judge.workRoot))
    ) {
      problems.push(
        'AFFIDAVIT_JUDGE_WORK_ROOT and AFFIDAVIT_EVIDENCE_DIR must not contain one another (the witness jail gets no path to the evidence store)',
      );
    }
    if (
      intake &&
      intake.workRoot !== '' &&
      judge.evidenceDir !== '' &&
      (inside(intake.workRoot, judge.evidenceDir) || inside(judge.evidenceDir, intake.workRoot))
    ) {
      problems.push(
        'AFFIDAVIT_INTAKE_WORK_ROOT and AFFIDAVIT_EVIDENCE_DIR must not contain one another',
      );
    }
    if (!(await probe.isSocket(judge.signerSocket))) {
      problems.push(
        'AFFIDAVIT_SIGNER_SOCKET is not a listening unix socket (start apps/signer, see its CLAUDE.md)',
      );
    }
    if (judge.nodegoatBundle !== null && !(await probe.isDirectory(judge.nodegoatBundle))) {
      problems.push('AFFIDAVIT_NODEGOAT_BUNDLE is set but is not an existing directory');
    }
    if (
      runtimes !== null &&
      judge.runnerImage !== '' &&
      !(await probe.imagePresent(judge.runnerImage))
    ) {
      problems.push(
        'the AFFIDAVIT_WITNESS_RUNNER_IMAGE image is not present (build it with `pnpm --filter @affidavit/judge runner-image`)',
      );
    }
  }
  if (problems.length > 0) throw new PrerequisiteError(problems);
}
