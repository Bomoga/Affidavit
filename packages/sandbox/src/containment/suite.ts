import { PROBES } from './probes.js';
import type {
  HostChecks,
  HostFixtures,
  JailRunReport,
  JailRunner,
  Probe,
  ProbeOutcome,
} from './types.js';

/** Host-side setup and measurement around each probe. The real one lives in `host.ts`. */
export interface HostHarness {
  fixtures(): HostFixtures;
  /** Resets counters and restores the evidence directory before a probe runs. */
  reset(): Promise<void>;
  checks(): Promise<Omit<HostChecks, 'elapsedMs'>>;
}

export interface SuiteReport {
  runner: string;
  outcomes: ProbeOutcome[];
  allPassed: boolean;
}

/** How long past a probe's own timeout the suite waits before declaring the runner hung. */
export const RUNNER_HANG_MS = 30_000;

async function runWithDeadline(
  runner: JailRunner,
  probe: Probe,
  fx: HostFixtures,
): Promise<JailRunReport | null> {
  let timer: NodeJS.Timeout | undefined;
  const hung = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), probe.timeoutMs + RUNNER_HANG_MS);
  });
  try {
    return await Promise.race([
      runner.run({ script: probe.script, args: probe.args(fx), timeoutMs: probe.timeoutMs }),
      hung,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function runProbe(
  probe: Probe,
  runner: JailRunner,
  host: HostHarness,
): Promise<ProbeOutcome> {
  await host.reset();
  const fx = host.fixtures();
  let report: JailRunReport | null;
  const started = Date.now();
  try {
    report = await runWithDeadline(runner, probe, fx);
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    return {
      invariant: probe.invariant,
      contained: false,
      recorded: false,
      passed: false,
      detail: `runner error: ${why}`,
    };
  }
  if (report === null) {
    return {
      invariant: probe.invariant,
      contained: false,
      recorded: false,
      passed: false,
      detail: 'runner did not return',
    };
  }
  const elapsedMs = Date.now() - started;
  const outcome = probe.assess(report, fx, { ...(await host.checks()), elapsedMs });
  return { ...outcome, passed: outcome.contained && outcome.recorded };
}

/** Runs probes one at a time so a misbehaving probe cannot disturb another's measurements. */
export async function runSuite(
  runner: JailRunner,
  host: HostHarness,
  probes: readonly Probe[] = PROBES,
): Promise<SuiteReport> {
  const outcomes: ProbeOutcome[] = [];
  for (const probe of probes) outcomes.push(await runProbe(probe, runner, host));
  return { runner: runner.name, outcomes, allPassed: outcomes.every((o) => o.passed) };
}

const yesNo = (b: boolean): string => (b ? 'yes' : 'no');

export function renderMarkdown(report: SuiteReport): string {
  const rows = report.outcomes.map(
    (o) =>
      `| ${o.invariant} | ${yesNo(o.contained)} | ${yesNo(o.recorded)} | ${o.passed ? 'pass' : 'FAIL'} | ${o.detail.replace(/\|/g, '/')} |`,
  );
  return [
    `Runner: \`${report.runner}\``,
    '',
    '| Invariant | Contained | Recorded | Result | Detail |',
    '| --- | --- | --- | --- | --- |',
    ...rows,
  ].join('\n');
}
