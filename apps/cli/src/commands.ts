import { Command, CommanderError, InvalidArgumentError } from 'commander';
import type { TrialEvent } from '@affidavit/contracts';
import * as evidence from '@affidavit/evidence';
import { EXIT_CODE_HELP, CliError, ExitCode } from './exit.js';
import { renderEvent, renderMessage, sanitize } from './render.js';
import {
  DEFAULT_BUDGET,
  buildCaseFile,
  loadCliConfig,
  openPgCasePort,
  requireFakeIntake,
  secretsOf,
  toCliError,
  type CasePort,
  type CliConfig,
} from './runtime.js';

export type Env = Readonly<Record<string, string | undefined>>;

export interface CliDeps {
  env: Env;
  out(line: string): void;
  err(line: string): void;
  /** Opens the case backend. Defaults to Postgres from the environment. */
  openPort?: (config: CliConfig) => Promise<CasePort>;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
  signal?: AbortSignal;
  /** Lane 2 replay. Defaults to `replayBundle` from @affidavit/evidence when it exists. */
  replay?: ((bundlePath: string) => Promise<number>) | undefined;
}

const TERMINAL: ReadonlySet<TrialEvent['type']> = new Set([
  'verdict-written',
  'escalated',
  'budget-exhausted',
]);

function terminalExit(type: TrialEvent['type']): ExitCode {
  if (type === 'escalated') return ExitCode.ESCALATED;
  if (type === 'budget-exhausted') return ExitCode.BUDGET_EXHAUSTED;
  return ExitCode.OK;
}

const defaultSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const done = () => {
      clearTimeout(t);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const t = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });

function intOption(name: string, min: number, max: number) {
  return (raw: string): number => {
    if (!/^[0-9]{1,9}$/.test(raw)) throw new InvalidArgumentError(`${name} must be an integer`);
    const n = Number(raw);
    if (n < min || n > max) throw new InvalidArgumentError(`${name} must be ${min} to ${max}`);
    return n;
  };
}

/** The scan argument becomes `target.repo`: one line of printable text, bounded. */
export function parseTarget(raw: string): string {
  const t = raw.trim();
  if (t === '') throw new CliError(ExitCode.USAGE, 'the scan target must not be empty');
  if (t.length > 300) throw new CliError(ExitCode.USAGE, 'the scan target is too long (max 300)');
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(t)) {
    throw new CliError(ExitCode.USAGE, 'the scan target must not contain control characters');
  }
  return t;
}

export interface WatchOptions {
  pollMs: number;
  timeoutMs: number;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  now: () => number;
  signal?: AbortSignal | undefined;
  onEvent: (event: TrialEvent) => void;
}

export type WatchResult =
  { kind: 'terminal'; event: TrialEvent } | { kind: 'timeout' } | { kind: 'aborted' };

/** Polls for new events until a terminal one, the timeout, or an abort. Prints each event once. */
export async function watchCase(
  port: CasePort,
  caseId: string,
  o: WatchOptions,
): Promise<WatchResult> {
  const deadline = o.now() + o.timeoutMs;
  let lastSeq = -1;
  for (;;) {
    if (o.signal?.aborted) return { kind: 'aborted' };
    const batch = await port.events(caseId, lastSeq);
    for (const event of batch) {
      if (event.seq <= lastSeq || event.caseId !== caseId) continue;
      lastSeq = event.seq;
      o.onEvent(event);
      if (TERMINAL.has(event.type)) return { kind: 'terminal', event };
    }
    if (o.now() >= deadline) return { kind: 'timeout' };
    await o.sleep(Math.min(o.pollMs, Math.max(0, deadline - o.now())), o.signal);
  }
}

async function withPort<T>(
  deps: CliDeps,
  fn: (port: CasePort, config: CliConfig) => Promise<T>,
): Promise<T> {
  const config = loadCliConfig(deps.env);
  const open = deps.openPort ?? openPgCasePort;
  let port: CasePort;
  try {
    port = await open(config);
  } catch (err) {
    throw toCliError(err, secretsOf(config.databaseUrl));
  }
  try {
    return await fn(port, config);
  } catch (err) {
    throw toCliError(err, secretsOf(config.databaseUrl));
  } finally {
    await port.close().catch(() => undefined);
  }
}

async function runScan(
  target: string,
  opts: { timeout: number; pollMs: number },
  deps: CliDeps,
): Promise<ExitCode> {
  requireFakeIntake(deps.env);
  const repo = parseTarget(target);
  return withPort(deps, async (port, config) => {
    const file = buildCaseFile(repo, config.tenantId);
    deps.out(
      'FAKE INTAKE (v0): the case file is the recorded NodeGoat fixture, not an analysis of your target.',
    );
    deps.out(`target ${sanitize(repo)}`);
    await port.startCase(file, DEFAULT_BUDGET);
    deps.out(`case ${file.id} enqueued, waiting for a worker (timeout ${opts.timeout}s)`);
    const result = await watchCase(port, file.id, {
      pollMs: opts.pollMs,
      timeoutMs: opts.timeout * 1000,
      sleep: deps.sleep ?? defaultSleep,
      now: deps.now ?? Date.now,
      signal: deps.signal,
      onEvent: (e) => deps.out(renderEvent(e)),
    });
    if (result.kind === 'terminal') {
      const code = terminalExit(result.event.type);
      if (code !== ExitCode.OK) {
        deps.err(`case ${file.id} needs human review (${result.event.type})`);
      }
      return code;
    }
    if (result.kind === 'aborted') {
      deps.err(
        `interrupted; case ${file.id} keeps running. Follow it: affidavit status ${file.id}`,
      );
      return ExitCode.INTERRUPTED;
    }
    deps.err(
      `timed out; case ${file.id} keeps running (is a worker running?). Follow it: affidavit status ${file.id}`,
    );
    return ExitCode.TIMEOUT;
  });
}

async function runStatus(
  caseIdArg: string,
  opts: { tail: number },
  deps: CliDeps,
): Promise<ExitCode> {
  const id = caseIdArg.trim();
  if (id === '' || id.length > 200 || /[^\x21-\x7e]/.test(id)) {
    throw new CliError(ExitCode.USAGE, 'the case id must be printable text without spaces');
  }
  return withPort(deps, async (port) => {
    const stage = await port.stage(id);
    const events = await port.events(id, -1);
    const last = events.at(-1);
    const terminal = events.find((e) => TERMINAL.has(e.type));
    deps.out(`case ${sanitize(id)}`);
    deps.out(`stage ${sanitize(stage)}`);
    deps.out(`events ${events.length}${last ? `, last seq ${last.seq}` : ''}`);
    deps.out(
      terminal
        ? `state finished (${terminal.type})`
        : 'state running or waiting for a worker (no terminal event yet)',
    );
    const tail = events.slice(-opts.tail);
    if (tail.length > 0) deps.out('recent events:');
    for (const e of tail) deps.out(`  ${renderEvent(e)}`);
    return ExitCode.OK;
  });
}

type ReplayFn = (bundlePath: string) => Promise<number>;

function resolveReplay(deps: CliDeps): ReplayFn | undefined {
  if ('replay' in deps) return deps.replay;
  const fn = (evidence as Record<string, unknown>)['replayBundle'];
  return typeof fn === 'function' ? (fn as ReplayFn) : undefined;
}

async function runReplay(bundle: string, deps: CliDeps): Promise<ExitCode> {
  const path = bundle.trim();
  // eslint-disable-next-line no-control-regex
  if (path === '' || path.length > 1000 || /[\u0000-\u001f]/.test(path)) {
    throw new CliError(ExitCode.USAGE, 'the bundle path must be one line of printable text');
  }
  const replay = resolveReplay(deps);
  if (!replay) {
    deps.err('replay is not implemented yet (waiting on Lane 2 L2-08).');
    return ExitCode.NOT_IMPLEMENTED;
  }
  try {
    return (await replay(path)) === 0 ? ExitCode.OK : ExitCode.INTERNAL;
  } catch (err) {
    throw toCliError(err);
  }
}

/** Builds the commander program. Actions store their exit code in `result.code`. */
export function buildProgram(deps: CliDeps, result: { code: ExitCode }): Command {
  const program = new Command();
  program
    .name('affidavit')
    .description('Affidavit command line (v0). Intake is FAKE in this version.')
    .exitOverride()
    .configureOutput({
      writeOut: (s) => deps.out(s.replace(/\n$/, '')),
      writeErr: (s) => deps.err(s.replace(/\n$/, '')),
    })
    .addHelpText(
      'after',
      `
Environment:
  AFFIDAVIT_APP_DATABASE_URL  affidavit_app role URL (secret, never printed)
  AFFIDAVIT_TENANT_ID         tenant the cases belong to
  AFFIDAVIT_INTAKE_IMPL       must be "fake" for scan in v0

Exit codes:
${EXIT_CODE_HELP.split('\n')
  .map((l) => `  ${l}`)
  .join('\n')}`,
    );

  program
    .command('scan')
    .argument('<target>', 'repository or path (v0: only recorded as the case target)')
    .description(
      'Enqueue a case and stream its events. FAKE INTAKE: the case file is the recorded NodeGoat fixture whatever the target is; a worker must be running.',
    )
    .option(
      '--timeout <seconds>',
      'stop waiting after this long',
      intOption('timeout', 1, 3600),
      120,
    )
    .option('--poll-ms <ms>', 'event poll interval', intOption('poll-ms', 10, 60_000), 500)
    .action(async (target: string, opts: { timeout: number; pollMs: number }) => {
      result.code = await runScan(target, opts, deps);
    });

  program
    .command('status')
    .argument('<caseId>', 'case id printed by scan')
    .description('Show a case stage and its most recent events.')
    .option('--tail <n>', 'how many recent events to show', intOption('tail', 1, 100), 10)
    .action(async (caseId: string, opts: { tail: number }) => {
      result.code = await runStatus(caseId, opts, deps);
    });

  program
    .command('replay')
    .argument('<bundle>', 'path to an evidence bundle')
    .description('Replay an evidence bundle (Lane 2). Not implemented until L2-08.')
    .action(async (bundle: string) => {
      result.code = await runReplay(bundle, deps);
    });

  return program;
}

/** Runs the CLI with `argv` (no node/script prefix) and returns the exit code. Never throws. */
export async function run(argv: readonly string[], deps: CliDeps): Promise<ExitCode> {
  const result = { code: ExitCode.OK as ExitCode };
  const program = buildProgram(deps, result);
  try {
    await program.parseAsync([...argv], { from: 'user' });
    return result.code;
  } catch (err) {
    if (err instanceof CommanderError) {
      const help = /^commander\.(help|helpDisplayed|version)$/.test(err.code);
      return help ? ExitCode.OK : ExitCode.USAGE;
    }
    const e = toCliError(err, secretsOf(deps.env.AFFIDAVIT_APP_DATABASE_URL ?? ''));
    deps.err(`error: ${renderMessage(e.message)}`);
    return e.exitCode;
  }
}
