/**
 * Host prerequisites of the real implementations, checked once at startup before any connection
 * is opened. Every missing piece is listed in one error, by variable name or host fact, never by
 * value. Wiring only: what each Lane 2 piece needs is stated in its own docs, this checks it.
 */
import { execFile } from 'node:child_process';
import { lstat, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import {
  checkRealJudgePrerequisites,
  realJudgeHostProbe,
  type RealJudgeHostProbe,
} from '@affidavit/judge';
import { PLAIN_RUNTIME } from '@affidavit/sandbox';
import type { WorkerConfig } from '../config.js';
import { realJudgeConfig } from './components.js';

const exec = promisify(execFile);

export interface HostProbe {
  platform: NodeJS.Platform;
  isDirectory(path: string): Promise<boolean>;
  /** A regular file itself, not a symlink to one (lstat). */
  isRegularFile(path: string): Promise<boolean>;
  /** Registered Docker runtimes, or null when the Docker daemon cannot be reached. */
  dockerRuntimes(): Promise<string[] | null>;
}

export const realHostProbe: HostProbe = {
  platform: process.platform,
  isDirectory: (p) =>
    stat(p).then(
      (s) => s.isDirectory(),
      () => false,
    ),
  isRegularFile: (p) =>
    lstat(p).then(
      (s) => s.isFile(),
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

/**
 * Throws PrerequisiteError listing everything missing for the configured real implementations:
 * the worker's own checks (intake, NodeGoat inputs) plus, for the Judge, Lane 2's
 * `checkRealJudgePrerequisites` on the same `RealJudgeConfig` `createRealJudge` will get, so one
 * error lists all of it. Field and variable names only, never values.
 */
export async function checkPrerequisites(
  config: WorkerConfig,
  probe: HostProbe = realHostProbe,
  judgeProbe: RealJudgeHostProbe = realJudgeHostProbe,
): Promise<void> {
  const problems: string[] = [];
  const intake = config.intakeSettings;
  const judge = config.judgeSettings;

  if (intake) {
    if (intake.toolRunner === 'gvisor' && probe.platform !== 'linux') {
      problems.push(
        `AFFIDAVIT_TOOLRUNNER=gvisor needs a Linux sandbox host with gVisor (this host is ${probe.platform})`,
      );
    }
    const runtimes = await probe.dockerRuntimes();
    if (runtimes === null) {
      problems.push('the Docker daemon cannot be reached (docker info failed)');
    } else if (intake.toolRunner === 'gvisor' && !runtimes.includes(PLAIN_RUNTIME)) {
      problems.push(
        `Docker has no "${PLAIN_RUNTIME}" runtime (run docker/sandbox/install-gvisor.sh as root)`,
      );
    }
    if (intake.workRoot !== '' && !(await probe.isDirectory(intake.workRoot))) {
      problems.push('AFFIDAVIT_INTAKE_WORK_ROOT is not an existing directory');
    }
  }

  if (judge) {
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
    if (judge.nodegoatBundle !== null && !(await probe.isRegularFile(judge.nodegoatBundle))) {
      problems.push(
        'AFFIDAVIT_NODEGOAT_BUNDLE is set but is not an existing regular file (the bundle tar itself, not a directory or a symlink; the Judge checks its sha256 against pins.json)',
      );
    }
    for (const [name, dir] of [
      ['AFFIDAVIT_NODEGOAT_DIR', judge.nodegoatDir],
      ['AFFIDAVIT_NODEGOAT_SAFE_DIR', judge.nodegoatSafeDir],
    ] as const) {
      if (dir !== null && !(await probe.isDirectory(dir))) {
        problems.push(`${name} is set but is not an existing directory`);
      }
    }
    const report = await checkRealJudgePrerequisites(realJudgeConfig(judge), judgeProbe);
    problems.push(...report.problems);
  }
  if (problems.length > 0) throw new PrerequisiteError(problems);
}
