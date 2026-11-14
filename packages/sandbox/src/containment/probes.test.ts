import { describe, expect, it } from 'vitest';
import {
  MEMORY_TARGET_MB,
  PROBE_MARKER,
  PROBES,
  PROCESS_ATTEMPTS,
  STARTED_MARKER,
  WALL_CLOCK_GRACE_MS,
  parseProbeReport,
} from './probes.js';
import {
  INVARIANTS,
  type HostChecks,
  type HostFixtures,
  type Invariant,
  type JailRunReport,
  type Observations,
  type Probe,
} from './types.js';

const fx: HostFixtures = {
  credentialCanary: 'cred-canary-0123456789',
  credentialPath: '/host/credential',
  evidenceCanary: 'evidence-canary-0123456789',
  evidenceDir: '/host/evidence',
  orchestratorUrl: 'http://172.17.0.1:9/',
};
const cleanHost: HostChecks = { orchestratorRequests: 0, evidenceDirUnchanged: true };

function probe(invariant: Invariant): Probe {
  const p = PROBES.find((x) => x.invariant === invariant);
  if (!p) throw new Error(`no probe for ${invariant}`);
  return p;
}

function report(lines: string[], observations: Observations = {}, durationMs = 100): JailRunReport {
  return { exitCode: 0, durationMs, stdout: lines.join('\n'), stderr: '', observations };
}

const marker = (o: unknown): string => PROBE_MARKER + JSON.stringify(o);

describe('probe set', () => {
  it('has exactly one probe per invariant', () => {
    expect(PROBES.map((p) => p.invariant).sort()).toEqual([...INVARIANTS].sort());
  });

  it('starts every script with the start marker before anything else runs', () => {
    for (const p of PROBES) {
      expect(p.script.trimStart().startsWith(`console.log('${STARTED_MARKER}')`)).toBe(true);
    }
  });

  it('never puts a canary into the arguments sent into the jail', () => {
    for (const p of PROBES) {
      const sent = JSON.stringify(p.args(fx));
      expect(sent).not.toContain(fx.credentialCanary);
      expect(sent).not.toContain(fx.evidenceCanary);
    }
  });
});

describe('parseProbeReport', () => {
  it('reads the last marker line', () => {
    expect(parseProbeReport(`noise\n${marker({ a: 1 })}\n${marker({ a: 2 })}\n`)).toEqual({ a: 2 });
  });

  it.each([
    ['no marker', 'just output'],
    ['malformed json', `${PROBE_MARKER}{not json`],
    ['an array', marker([1, 2])],
    ['a primitive', marker(3)],
    ['oversized output', `${'x'.repeat(1024 * 1024 + 1)}\n${marker({ a: 1 })}`],
  ])('returns null for %s', (_label, stdout) => {
    expect(parseProbeReport(stdout)).toBeNull();
  });
});

/** For each probe: a run where the jail held and the runner saw it, and one where it broke. */
const cases: Record<
  Invariant,
  { held: [JailRunReport, HostChecks]; breached: [JailRunReport, HostChecks] }
> = {
  'no-egress': {
    held: [
      report([STARTED_MARKER, marker({ resolved: false, connected: false })], {
        egressAttempts: 2,
      }),
      cleanHost,
    ],
    breached: [report([STARTED_MARKER, marker({ resolved: true, connected: true })]), cleanHost],
  },
  'no-credential-access': {
    held: [report([STARTED_MARKER, '{}', marker({ done: true })], { deniedReads: 1 }), cleanHost],
    breached: [report([STARTED_MARKER, fx.credentialCanary, marker({ done: true })]), cleanHost],
  },
  'no-evidence-store-access': {
    held: [
      report([STARTED_MARKER, '', marker({ wrote: false })], { deniedReads: 1, deniedWrites: 1 }),
      cleanHost,
    ],
    breached: [
      report([STARTED_MARKER, fx.evidenceCanary, marker({ wrote: true })]),
      { orchestratorRequests: 0, evidenceDirUnchanged: false },
    ],
  },
  'no-orchestrator-reach': {
    held: [report([STARTED_MARKER, marker({ reached: false })], { egressAttempts: 1 }), cleanHost],
    breached: [
      report([STARTED_MARKER, marker({ reached: true })]),
      { orchestratorRequests: 1, evidenceDirUnchanged: true },
    ],
  },
  'no-writes-outside-scratch': {
    held: [
      report(
        [
          STARTED_MARKER,
          marker({
            scratch: true,
            outside: {
              '/': false,
              '/etc': false,
              '/tmp': false,
              '/usr/local/lib': false,
              '/witness': false,
            },
          }),
        ],
        { deniedWrites: 5 },
      ),
      cleanHost,
    ],
    breached: [
      report([STARTED_MARKER, marker({ scratch: true, outside: { '/': false, '/tmp': true } })]),
      cleanHost,
    ],
  },
  'bounded-processes': {
    held: [
      report([STARTED_MARKER, marker({ started: 200, failed: true })], { pidsLimitHit: true }),
      cleanHost,
    ],
    breached: [
      report([STARTED_MARKER, marker({ started: PROCESS_ATTEMPTS, failed: false })]),
      cleanHost,
    ],
  },
  'bounded-memory': {
    held: [report([STARTED_MARKER], { oomKilled: true }), cleanHost],
    breached: [report([STARTED_MARKER, marker({ allocatedMb: MEMORY_TARGET_MB })]), cleanHost],
  },
  'bounded-wall-clock': {
    held: [report([STARTED_MARKER], { timedOut: true }, 5_200), cleanHost],
    breached: [report([STARTED_MARKER], {}, 5_000 + WALL_CLOCK_GRACE_MS + 1), cleanHost],
  },
};

describe.each(INVARIANTS)('%s probe', (invariant) => {
  const p = probe(invariant);
  const c = cases[invariant];

  it('is contained and recorded when the jail holds and the runner sees the attempt', () => {
    const o = p.assess(c.held[0], fx, c.held[1]);
    expect(o).toMatchObject({ contained: true, recorded: true });
  });

  it('is not contained when the boundary breaks', () => {
    expect(p.assess(c.breached[0], fx, c.breached[1]).contained).toBe(false);
  });

  it('is not recorded when the runner observed nothing', () => {
    const silent = { ...c.held[0], observations: {} };
    expect(p.assess(silent, fx, c.held[1]).recorded).toBe(false);
  });

  it('is never contained when the probe did not start', () => {
    const neverRan = { ...c.held[0], stdout: '', exitCode: 127 };
    expect(p.assess(neverRan, fx, c.held[1]).contained).toBe(false);
  });
});

describe('no-writes-outside-scratch', () => {
  it('fails the control when /scratch is not writable', () => {
    const o = probe('no-writes-outside-scratch').assess(
      report([STARTED_MARKER, marker({ scratch: false, outside: {} })]),
      fx,
      cleanHost,
    );
    expect(o.contained).toBe(false);
    expect(o.detail).toContain('control failed');
  });
});

describe('no-credential-access', () => {
  it('catches a canary that leaks through stderr', () => {
    const r = { ...report([STARTED_MARKER, marker({ done: true })]), stderr: fx.credentialCanary };
    expect(probe('no-credential-access').assess(r, fx, cleanHost).contained).toBe(false);
  });
});
