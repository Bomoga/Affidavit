import { afterEach, describe, expect, it, vi } from 'vitest';
import { PROBES } from './probes.js';
import { RUNNER_HANG_MS, renderMarkdown, runProbe, runSuite, type HostHarness } from './suite.js';
import type { HostFixtures, JailRunner, JailRunReport, Probe } from './types.js';

const fx: HostFixtures = {
  credentialCanary: 'c',
  credentialPath: '/c',
  evidenceCanary: 'e',
  evidenceDir: '/e',
  orchestratorUrl: 'http://127.0.0.1:9/',
};

function fakeHost(): HostHarness & { resets: number } {
  const h = {
    resets: 0,
    fixtures: () => fx,
    reset: () => {
      h.resets += 1;
      return Promise.resolve();
    },
    checks: () => Promise.resolve({ orchestratorRequests: 0, evidenceDirUnchanged: true }),
  };
  return h;
}

const report: JailRunReport = {
  exitCode: 0,
  durationMs: 1,
  stdout: '',
  stderr: '',
  observations: {},
};

function probe(contained: boolean, recorded: boolean): Probe {
  return {
    invariant: 'no-egress',
    description: 'test',
    timeoutMs: 1000,
    script: '',
    args: () => ({}),
    assess: () => ({ invariant: 'no-egress', contained, recorded, detail: 'd' }),
  };
}

const runner = (run: JailRunner['run']): JailRunner => ({ name: 'fake', run });

afterEach(() => {
  vi.useRealTimers();
});

describe('runProbe', () => {
  it('passes only when contained and recorded', async () => {
    const r = runner(() => Promise.resolve(report));
    expect((await runProbe(probe(true, true), r, fakeHost())).passed).toBe(true);
    expect((await runProbe(probe(true, false), r, fakeHost())).passed).toBe(false);
    expect((await runProbe(probe(false, true), r, fakeHost())).passed).toBe(false);
  });

  it('turns a runner error into a failed outcome instead of throwing', async () => {
    const r = runner(() => Promise.reject(new Error('daemon gone')));
    const o = await runProbe(probe(true, true), r, fakeHost());
    expect(o).toMatchObject({ contained: false, passed: false });
    expect(o.detail).toContain('daemon gone');
  });

  it('fails a runner that never returns', async () => {
    vi.useFakeTimers();
    const r = runner(() => new Promise(() => undefined));
    const pending = runProbe(probe(true, true), r, fakeHost());
    await vi.advanceTimersByTimeAsync(1000 + RUNNER_HANG_MS);
    expect(await pending).toMatchObject({ passed: false, detail: 'runner did not return' });
  });
});

describe('runSuite', () => {
  it('runs every probe once, resetting the host before each', async () => {
    const host = fakeHost();
    const seen: string[] = [];
    const r = runner((req) => {
      seen.push(req.script);
      return Promise.resolve(report);
    });
    const result = await runSuite(r, host);
    expect(seen).toEqual(PROBES.map((p) => p.script));
    expect(host.resets).toBe(PROBES.length);
    expect(result.outcomes).toHaveLength(PROBES.length);
  });

  it('is allPassed only when every probe passes', async () => {
    const r = runner(() => Promise.resolve(report));
    expect((await runSuite(r, fakeHost(), [probe(true, true)])).allPassed).toBe(true);
    expect((await runSuite(r, fakeHost(), [probe(true, true), probe(true, false)])).allPassed).toBe(
      false,
    );
  });

  it('an empty observation report never passes the real probes', async () => {
    const result = await runSuite(
      runner(() => Promise.resolve(report)),
      fakeHost(),
    );
    expect(result.outcomes.some((o) => o.passed)).toBe(false);
  });
});

describe('renderMarkdown', () => {
  it('escapes pipes in details so the table stays intact', () => {
    const md = renderMarkdown({
      runner: 'fake',
      allPassed: false,
      outcomes: [
        {
          invariant: 'no-egress',
          contained: false,
          recorded: false,
          passed: false,
          detail: 'a | b',
        },
      ],
    });
    expect(md).toContain('| no-egress | no | no | FAIL | a / b |');
  });
});

describe('host clock', () => {
  it('passes the time it measured around the runner call to assess', async () => {
    vi.useFakeTimers();
    let seen = -1;
    const p: Probe = {
      ...probe(true, true),
      assess: (_r, _fx, host) => {
        seen = host.elapsedMs;
        return { invariant: 'no-egress', contained: true, recorded: true, detail: 'd' };
      },
    };
    const slow = runner(
      () =>
        new Promise((resolve) => setTimeout(() => resolve({ ...report, durationMs: 1 }), 2_000)),
    );
    const pending = runProbe(p, slow, fakeHost());
    await vi.advanceTimersByTimeAsync(2_000);
    await pending;
    expect(seen).toBeGreaterThanOrEqual(2_000);
  });
});
