import type { JailRunReport, Probe } from './types.js';

export const PROBE_MARKER = 'AFFIDAVIT_PROBE ';
/** Printed first, so a probe that never ran is not mistaken for one that was stopped. */
export const STARTED_MARKER = 'AFFIDAVIT_PROBE_STARTED';
/** Probe stdout above this size is ignored, so a chatty probe cannot slow the parser down. */
const MAX_PARSED_OUTPUT = 1024 * 1024;

/** Every probe ends by printing one marker line with a JSON object. */
const PRELUDE = `
console.log('${STARTED_MARKER}');
const args = JSON.parse(process.argv[2] ?? '{}');
const report = (o) => console.log('${PROBE_MARKER}' + JSON.stringify(o));
`;

/** Reads the probe's final marker line. Anything malformed counts as "no report". */
export function parseProbeReport(stdout: string): Record<string, unknown> | null {
  if (stdout.length > MAX_PARSED_OUTPUT) return null;
  const line = stdout
    .split('\n')
    .reverse()
    .find((l) => l.startsWith(PROBE_MARKER));
  if (line === undefined) return null;
  try {
    const value: unknown = JSON.parse(line.slice(PROBE_MARKER.length));
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** True when the probe printed its start marker, so a missing report means it was stopped. */
export function probeStarted(report: JailRunReport): boolean {
  return report.stdout.startsWith(STARTED_MARKER) || report.stdout.includes(`\n${STARTED_MARKER}`);
}

function leaked(report: JailRunReport, canary: string): boolean {
  return report.stdout.includes(canary) || report.stderr.includes(canary);
}

const egress: Probe = {
  invariant: 'no-egress',
  description: 'Resolves a public name and opens a TCP connection to a public address.',
  timeoutMs: 20_000,
  script: `${PRELUDE}
import net from 'node:net';
import dns from 'node:dns/promises';
let resolved = false;
try { await dns.lookup('example.com'); resolved = true; } catch {}
const connected = await new Promise((done) => {
  const s = net.connect({ host: '1.1.1.1', port: 443, timeout: 3000 });
  s.once('connect', () => { s.destroy(); done(true); });
  s.once('error', () => done(false));
  s.once('timeout', () => { s.destroy(); done(false); });
});
report({ resolved, connected });
`,
  args: () => ({}),
  assess(report) {
    const r = parseProbeReport(report.stdout);
    const recorded = (report.observations.egressAttempts ?? 0) > 0;
    if (r === null)
      return {
        invariant: this.invariant,
        contained: false,
        recorded,
        detail: 'probe did not report',
      };
    const contained = r.resolved === false && r.connected === false;
    return {
      invariant: this.invariant,
      contained,
      recorded,
      detail: `dns resolved: ${String(r.resolved)}, tcp connected: ${String(r.connected)}`,
    };
  },
};

const credential: Probe = {
  invariant: 'no-credential-access',
  description:
    "Dumps its environment and tries to read the host credential file; the host looks for the canary in the jail's output.",
  timeoutMs: 20_000,
  script: `${PRELUDE}
import { readFile } from 'node:fs/promises';
const seen = [JSON.stringify(process.env)];
for (const p of [args.credentialPath, '/proc/1/environ']) {
  try { seen.push(await readFile(p, 'utf8')); } catch {}
}
console.log(seen.join('\\n'));
report({ done: true });
`,
  args: (fx) => ({ credentialPath: fx.credentialPath }),
  assess(report, fx) {
    const ran = parseProbeReport(report.stdout) !== null;
    const contained = ran && !leaked(report, fx.credentialCanary);
    return {
      invariant: this.invariant,
      contained,
      recorded: (report.observations.deniedReads ?? 0) > 0,
      detail: !ran
        ? 'probe did not report'
        : contained
          ? 'canary not seen'
          : 'credential canary leaked into the jail',
    };
  },
};

const evidence: Probe = {
  invariant: 'no-evidence-store-access',
  description:
    'Tries to read an exhibit from the host evidence directory and to write a forged one.',
  timeoutMs: 20_000,
  script: `${PRELUDE}
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
let read = '';
try { read = await readFile(join(args.evidenceDir, 'exhibit.bin'), 'utf8'); } catch {}
let wrote = false;
try { await writeFile(join(args.evidenceDir, 'forged.bin'), 'forged'); wrote = true; } catch {}
console.log(read);
report({ wrote });
`,
  args: (fx) => ({ evidenceDir: fx.evidenceDir }),
  assess(report, fx, host) {
    const r = parseProbeReport(report.stdout);
    const readLeak = leaked(report, fx.evidenceCanary);
    const contained = r !== null && !readLeak && host.evidenceDirUnchanged;
    return {
      invariant: this.invariant,
      contained,
      recorded:
        (report.observations.deniedReads ?? 0) + (report.observations.deniedWrites ?? 0) > 0,
      detail:
        r === null
          ? 'probe did not report'
          : `exhibit read: ${String(readLeak)}, evidence dir unchanged: ${String(host.evidenceDirUnchanged)}`,
    };
  },
};

const orchestrator: Probe = {
  invariant: 'no-orchestrator-reach',
  description: 'Sends an HTTP request to a listener the host runs in place of the orchestrator.',
  timeoutMs: 20_000,
  script: `${PRELUDE}
let reached = false;
try { await fetch(args.orchestratorUrl, { signal: AbortSignal.timeout(3000) }); reached = true; } catch {}
report({ reached });
`,
  args: (fx) => ({ orchestratorUrl: fx.orchestratorUrl }),
  assess(report, _fx, host) {
    const ran = parseProbeReport(report.stdout) !== null;
    return {
      invariant: this.invariant,
      contained: ran && host.orchestratorRequests === 0,
      recorded: (report.observations.egressAttempts ?? 0) > 0,
      detail: ran
        ? `requests seen by host listener: ${host.orchestratorRequests}`
        : 'probe did not report',
    };
  },
};

const OUTSIDE_SCRATCH = ['/', '/etc', '/tmp', '/usr/local/lib', '/witness'];

const writes: Probe = {
  invariant: 'no-writes-outside-scratch',
  description: 'Writes a file to /scratch (control) and to paths outside it.',
  timeoutMs: 20_000,
  script: `${PRELUDE}
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const tryWrite = async (dir) => {
  try { await writeFile(join(dir, 'affidavit-probe-' + process.pid), 'x'); return true; } catch { return false; }
};
const outside = {};
for (const dir of args.outside) outside[dir] = await tryWrite(dir);
report({ scratch: await tryWrite('/scratch'), outside });
`,
  args: () => ({ outside: OUTSIDE_SCRATCH }),
  assess(report) {
    const r = parseProbeReport(report.stdout);
    const recorded = (report.observations.deniedWrites ?? 0) > 0;
    if (r === null)
      return {
        invariant: this.invariant,
        contained: false,
        recorded,
        detail: 'probe did not report',
      };
    const outside = (
      typeof r.outside === 'object' && r.outside !== null ? r.outside : {}
    ) as Record<string, unknown>;
    const written = OUTSIDE_SCRATCH.filter((d) => outside[d] !== false);
    // Without a writable scratch the probe proves nothing, so the control must succeed.
    const contained = r.scratch === true && written.length === 0;
    return {
      invariant: this.invariant,
      contained,
      recorded,
      detail:
        r.scratch !== true
          ? 'control failed: /scratch is not writable'
          : written.length === 0
            ? 'no write outside /scratch'
            : `wrote outside /scratch: ${written.join(', ')}`,
    };
  },
};

export const PROCESS_ATTEMPTS = 1000;

const processes: Probe = {
  invariant: 'bounded-processes',
  description: `Starts up to ${PROCESS_ATTEMPTS} sleeping child processes, then kills them.`,
  timeoutMs: 60_000,
  script: `${PRELUDE}
import { spawn } from 'node:child_process';
const kids = [];
let failed = false;
for (let i = 0; i < args.attempts; i++) {
  try {
    const c = spawn('sleep', ['30'], { stdio: 'ignore' });
    await new Promise((ok, fail) => { c.once('spawn', ok); c.once('error', fail); });
    kids.push(c);
  } catch { failed = true; break; }
}
for (const k of kids) k.kill('SIGKILL');
report({ started: kids.length, failed });
`,
  args: () => ({ attempts: PROCESS_ATTEMPTS }),
  assess(report) {
    const r = parseProbeReport(report.stdout);
    const recorded = report.observations.pidsLimitHit === true;
    if (r === null) {
      // Stopped by some limit before reporting still bounds it, but only if it actually ran.
      const ran = probeStarted(report);
      return {
        invariant: this.invariant,
        contained: ran,
        recorded,
        detail: ran ? 'probe stopped before reporting' : 'probe never started',
      };
    }
    const started = typeof r.started === 'number' ? r.started : PROCESS_ATTEMPTS;
    return {
      invariant: this.invariant,
      contained: r.failed === true && started < PROCESS_ATTEMPTS,
      recorded,
      detail: `children started before refusal: ${started} of ${PROCESS_ATTEMPTS}`,
    };
  },
};

/** Above the 1 GiB the Phase 1 runner declares, so swap headroom shows up as a breach. */
export const MEMORY_TARGET_MB = 1536;

const memory: Probe = {
  invariant: 'bounded-memory',
  description: `Allocates and touches memory in 64 MiB steps up to ${MEMORY_TARGET_MB} MiB.`,
  timeoutMs: 60_000,
  script: `${PRELUDE}
const chunks = [];
let mb = 0;
while (mb < args.targetMb) { chunks.push(Buffer.alloc(64 * 1024 * 1024, 1)); mb += 64; }
report({ allocatedMb: mb });
`,
  args: () => ({ targetMb: MEMORY_TARGET_MB }),
  assess(report) {
    const r = parseProbeReport(report.stdout);
    return {
      invariant: this.invariant,
      contained: r === null && probeStarted(report),
      recorded: report.observations.oomKilled === true,
      detail: !probeStarted(report)
        ? 'probe never started'
        : r === null
          ? `stopped before ${MEMORY_TARGET_MB} MiB`
          : `allocated ${String(r.allocatedMb)} MiB`,
    };
  },
};

/** How long after its timeout a runner may take to stop the jail. */
export const WALL_CLOCK_GRACE_MS = 5_000;

const wallClock: Probe = {
  invariant: 'bounded-wall-clock',
  description: 'Never exits on its own.',
  timeoutMs: 5_000,
  script: `${PRELUDE}
setInterval(() => {}, 1000);
`,
  args: () => ({}),
  assess(report) {
    const contained =
      probeStarted(report) && report.durationMs <= this.timeoutMs + WALL_CLOCK_GRACE_MS;
    return {
      invariant: this.invariant,
      contained,
      recorded: report.observations.timedOut === true,
      detail: `stopped after ${report.durationMs} ms (timeout ${this.timeoutMs} ms)`,
    };
  },
};

export const PROBES: readonly Probe[] = [
  egress,
  credential,
  evidence,
  orchestrator,
  writes,
  processes,
  memory,
  wallClock,
];
