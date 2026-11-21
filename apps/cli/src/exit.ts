/**
 * Process exit codes of the `affidavit` CLI. Documented in `--help` and in apps/cli/CLAUDE.md.
 * 10 and 11 mean the case finished but a person has to look at it, so a script can tell them
 * apart from a clean verdict.
 */
export const ExitCode = {
  /** A verdict was written (scan), or the command did what was asked. */
  OK: 0,
  /** An unexpected error. */
  INTERNAL: 1,
  /** Bad arguments or options. */
  USAGE: 2,
  /** Missing or invalid environment configuration, or intake is not the fake one. */
  CONFIG: 3,
  /** The feature is not built yet (real intake, replay before L2-08). */
  NOT_IMPLEMENTED: 4,
  /** `scan` stopped waiting; the case keeps running and `status` can follow it. */
  TIMEOUT: 5,
  /** The case does not exist for this tenant. */
  NOT_FOUND: 6,
  /** The database could not be reached or refused the request. */
  UNAVAILABLE: 7,
  /** The case ended escalated and needs human review. */
  ESCALATED: 10,
  /** The case ran out of budget and needs human review. */
  BUDGET_EXHAUSTED: 11,
  /** `scan` was interrupted (SIGINT); the case keeps running. */
  INTERRUPTED: 130,
} as const;
export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];

export const EXIT_CODE_HELP = [
  '0   ok (scan: a verdict was written)',
  '1   unexpected error',
  '2   usage error (bad arguments or options)',
  '3   configuration error (environment variables, or intake is not fake)',
  '4   not implemented (real intake, replay until L2-08)',
  '5   scan timed out; the case keeps running, use `affidavit status`',
  '6   case not found for this tenant',
  '7   database unavailable or request refused',
  '10  case escalated, needs human review',
  '11  case budget exhausted, needs human review',
  '130 interrupted; the case keeps running',
].join('\n');

/** An error that already knows its exit code and carries a message safe to print. */
export class CliError extends Error {
  constructor(
    readonly exitCode: ExitCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'CliError';
  }
}
