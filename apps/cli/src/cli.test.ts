import { readFileSync } from 'node:fs';
import { CaseFile, TrialEvent, samples, type CaseStage } from '@affidavit/contracts';
import { describe, expect, it } from 'vitest';
import { run, watchCase, type CliDeps } from './commands.js';
import { ExitCode } from './exit.js';
import { renderEvent, sanitize } from './render.js';
import { buildCaseFile, toCliError, type CasePort } from './runtime.js';

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;

const fixtureEvents = JSON.parse(
  readFileSync(
    new URL('../../../fixtures/trials/nodegoat-sqli-001.events.json', import.meta.url),
    'utf8',
  ),
) as { events?: unknown[] } | unknown[];
const events = (Array.isArray(fixtureEvents) ? fixtureEvents : (fixtureEvents.events ?? [])).map(
  (e) => TrialEvent.parse(e),
);

const SECRET_URL = 'postgres://affidavit_app:hunter2secret@127.0.0.1:5432/affidavit';
const ENV = {
  AFFIDAVIT_APP_DATABASE_URL: SECRET_URL,
  AFFIDAVIT_TENANT_ID: 'tenant-cli',
  AFFIDAVIT_INTAKE_IMPL: 'fake',
};

function harness(opts: {
  env?: Record<string, string | undefined>;
  feed?: (caseId: string) => ReturnType<typeof TrialEvent.parse>[];
  stage?: CaseStage | Error;
  openError?: Error;
  replay?: CliDeps['replay'];
}) {
  const out: string[] = [];
  const err: string[] = [];
  const started: CaseFile[] = [];
  let clock = 0;
  const port: CasePort = {
    startCase: (file) => {
      started.push(file);
      return Promise.resolve();
    },
    stage: () =>
      opts.stage instanceof Error
        ? Promise.reject(opts.stage)
        : Promise.resolve(opts.stage ?? 'defense'),
    events: (id, after) => {
      const all = (opts.feed ? opts.feed(id) : events).map(
        (e) => ({ ...e, caseId: id }) as typeof e,
      );
      return Promise.resolve(all.filter((e) => e.seq > after));
    },
    close: () => Promise.resolve(),
  };
  const deps: CliDeps = {
    env: opts.env ?? ENV,
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    openPort: () => (opts.openError ? Promise.reject(opts.openError) : Promise.resolve(port)),
    sleep: () => {
      clock += 1000;
      return Promise.resolve();
    },
    now: () => clock,
    ...('replay' in opts ? { replay: opts.replay } : {}),
  };
  return { deps, out, err, started };
}

describe('sanitize and renderEvent', () => {
  it('strips ANSI CSI, OSC, DCS and stray escapes, and control characters', () => {
    const hostile = `a${ESC}[31mred${ESC}[0m b${ESC}]0;owned${BEL}c${ESC}Pdcs${ESC}\\d${ESC}x\r\n\tz\u0000\u009b31m`;
    const s = sanitize(hostile);
    expect(CONTROL.test(s)).toBe(false);
    expect(s).not.toContain('owned');
    expect(s).not.toContain('dcs');
    expect(s).toBe('ared bcd z');
  });

  it('removes nested escapes that would re-form a sequence', () => {
    const s = sanitize(`${ESC}${ESC}[0m[31mtext`);
    expect(s.includes(ESC)).toBe(false);
  });

  it('strips bidi overrides, isolates and zero-width characters', () => {
    const s = sanitize('safe\u202eevil\u2066x\u200b\ufeffy');
    expect(CONTROL.test(s)).toBe(false);
    expect(/[\u200b\ufeff]/u.test(s)).toBe(false);
  });

  it('strips Unicode tag characters and filler characters, replaces lone surrogates', () => {
    const tag = String.fromCodePoint(0xe0041, 0xe0042, 0xe007f);
    expect(sanitize(`a${tag}b`)).toBe('a b');
    for (const cp of [0x3164, 0x115f, 0xffa0]) {
      expect(sanitize(`x${String.fromCodePoint(cp)}y`)).toBe('x y');
    }
    const high = String.fromCharCode(0xd83d);
    const low = String.fromCharCode(0xde00);
    const fffd = String.fromCharCode(0xfffd);
    expect(sanitize(`a${high}b`)).toBe(`a${fffd}b`);
    expect(sanitize(`a${low}b`)).toBe(`a${fffd}b`);
    // A valid pair is kept.
    expect(sanitize(`a${high}${low}b`)).toBe(`a${high}${low}b`);
  });

  it('caps length, on code points', () => {
    const s = sanitize('\u{1F600}'.repeat(500), 50);
    expect(Array.from(s)).toHaveLength(50);
    expect(s.endsWith('...')).toBe(true);
  });

  it('renders every fixture event on one clean line', () => {
    for (const e of events) {
      const line = renderEvent(e);
      expect(line).not.toMatch(/[\n\r]/);
      expect(CONTROL.test(line)).toBe(false);
      expect(line.startsWith(`#${String(e.seq).padStart(3, '0')}`)).toBe(true);
    }
  });

  it('neutralizes hostile text inside event payloads and caps the line', () => {
    const base = TrialEvent.parse(events.find((e) => e.type === 'verdict-written'));
    if (base.type !== 'verdict-written') throw new Error('fixture');
    const hostile = TrialEvent.parse({
      ...base,
      payload: {
        verdict: {
          ...base.payload.verdict,
          summary: `${ESC}[2J${ESC}]0;pwned${BEL}line1\nline2 ${'x'.repeat(5000)}`,
        },
      },
    });
    const line = renderEvent(hostile);
    expect(CONTROL.test(line)).toBe(false);
    expect(line).not.toContain('pwned');
    expect(line.length).toBeLessThanOrEqual(240);
    const esc = TrialEvent.parse({
      ...(samples.TrialEvent as object),
      type: 'escalated',
      payload: {
        escalation: {
          schemaVersion: 1,
          caseId: (samples.TrialEvent as { caseId: string }).caseId,
          reason: 'split-jury',
          detail: `${ESC}[31mdetail\u202e`,
        },
      },
    });
    expect(CONTROL.test(renderEvent(esc))).toBe(false);
  });

  it('renders a verify-result event and neutralizes a hostile patch id in it', () => {
    const base = TrialEvent.parse(events.find((e) => e.type === 'verify-result'));
    if (base.type !== 'verify-result') throw new Error('fixture');
    expect(renderEvent(base)).toContain('exhibit-patch-001 familyFlipped=true suitePassed=true');
    const hostile = TrialEvent.parse({
      ...base,
      payload: {
        result: {
          ...base.payload.result,
          patchExhibitId: `${ESC}]0;pwned${BEL}patch
${'y'.repeat(5000)}`,
        },
      },
    });
    const line = renderEvent(hostile);
    expect(CONTROL.test(line)).toBe(false);
    expect(line).not.toContain('pwned');
    expect(line.length).toBeLessThanOrEqual(240);
  });
});

describe('argument parsing and exit codes', () => {
  it('prints help with the exit codes and the fake-intake warning, exit 0', async () => {
    const h = harness({});
    expect(await run(['--help'], h.deps)).toBe(ExitCode.OK);
    const text = h.out.join('\n');
    expect(text).toContain('Exit codes:');
    expect(text).toContain('FAKE');
    expect(text).not.toContain('\u2014');
    const s = harness({});
    expect(await run(['scan', '--help'], s.deps)).toBe(ExitCode.OK);
    expect(s.out.join('\n')).toContain('FAKE INTAKE');
  });

  it('rejects unknown commands, missing arguments and bad options with exit 2', async () => {
    for (const argv of [
      ['nope'],
      ['scan'],
      ['status'],
      ['replay'],
      ['scan', 'x', '--timeout', 'abc'],
      ['status', 'c', '--tail', '0'],
      ['scan', 'x', '--poll-ms', '1'],
    ]) {
      const h = harness({});
      expect(await run(argv, h.deps), argv.join(' ')).toBe(ExitCode.USAGE);
    }
  });

  it('scan: control characters in the target are a usage error', async () => {
    const h = harness({});
    expect(await run(['scan', `a${ESC}[31mb`], h.deps)).toBe(ExitCode.USAGE);
    expect(h.started).toHaveLength(0);
  });

  it('scan: refuses unless AFFIDAVIT_INTAKE_IMPL=fake', async () => {
    const unset = harness({ env: { ...ENV, AFFIDAVIT_INTAKE_IMPL: undefined } });
    expect(await run(['scan', 'repo'], unset.deps)).toBe(ExitCode.CONFIG);
    const real = harness({ env: { ...ENV, AFFIDAVIT_INTAKE_IMPL: 'real' } });
    expect(await run(['scan', 'repo'], real.deps)).toBe(ExitCode.NOT_IMPLEMENTED);
    expect(real.err.join('\n')).toContain('not implemented');
    expect(unset.started.length + real.started.length).toBe(0);
  });

  it('scan: missing config is exit 3 and never prints the database URL', async () => {
    const h = harness({ env: { AFFIDAVIT_INTAKE_IMPL: 'fake' } });
    expect(await run(['scan', 'repo'], h.deps)).toBe(ExitCode.CONFIG);
    const bad = harness({
      env: { ...ENV, AFFIDAVIT_APP_DATABASE_URL: 'http://user:hunter2secret@x' },
    });
    expect(await run(['scan', 'repo'], bad.deps)).toBe(ExitCode.CONFIG);
    expect([...h.err, ...bad.err].join('\n')).not.toContain('hunter2secret');
  });

  it('scan: streams the stream and exits 0 on verdict-written', async () => {
    const h = harness({});
    expect(await run(['scan', 'github.com/example/app'], h.deps)).toBe(ExitCode.OK);
    expect(h.out[0]).toContain('FAKE INTAKE');
    // The fixture stream, event for event: exact rendered lines, and seq, type, stage and actor.
    const printed = h.out.filter((l) => l.startsWith('#'));
    expect(printed).toEqual(events.map((e) => renderEvent(e)));
    expect(
      printed.map((l) => {
        const [seq, stage, actor, type] = l.slice(1).split(/\s+/);
        return [Number(seq), type, stage, actor];
      }),
    ).toEqual(events.map((e) => [e.seq, e.type, e.stage, e.actor]));
    expect(events).toHaveLength(20);
    expect(events.filter((e) => e.type === 'verify-result')).toHaveLength(1);
    expect(h.started).toHaveLength(1);
    expect(h.started[0]?.target.repo).toBe('github.com/example/app');
    expect(h.started[0]?.tenantId).toBe('tenant-cli');
  });

  it('scan: escalated and budget-exhausted end with their own codes', async () => {
    const mk = (type: 'escalated' | 'budget-exhausted') => () => [
      TrialEvent.parse({
        ...(samples.TrialEvent as object),
        seq: 0,
        type,
        payload: {
          escalation: {
            schemaVersion: 1,
            caseId: (samples.TrialEvent as { caseId: string }).caseId,
            reason: type === 'escalated' ? 'split-jury' : 'budget-exhausted',
            detail: 'd',
          },
        },
      }),
    ];
    const a = harness({ feed: mk('escalated') });
    expect(await run(['scan', 'r'], a.deps)).toBe(ExitCode.ESCALATED);
    const b = harness({ feed: mk('budget-exhausted') });
    expect(await run(['scan', 'r'], b.deps)).toBe(ExitCode.BUDGET_EXHAUSTED);
  });

  it('scan: times out with exit 5 when no terminal event arrives', async () => {
    const h = harness({ feed: () => events.slice(0, 3) });
    expect(await run(['scan', 'r', '--timeout', '3'], h.deps)).toBe(ExitCode.TIMEOUT);
    expect(h.out.filter((l) => l.startsWith('#'))).toHaveLength(3);
    expect(h.err.join('\n')).toContain('affidavit status');
  });

  it('scan: an abort signal stops the watch with 130', async () => {
    const h = harness({ feed: () => events.slice(0, 2) });
    const c = new AbortController();
    c.abort();
    expect(await run(['scan', 'r'], { ...h.deps, signal: c.signal })).toBe(ExitCode.INTERRUPTED);
  });

  it('scan: a database error is exit 7 and its URL never reaches the output', async () => {
    const e = Object.assign(new Error(`connect failed for ${SECRET_URL} hunter2secret`), {
      code: 'ECONNREFUSED',
    });
    const h = harness({ openError: e });
    expect(await run(['scan', 'r'], h.deps)).toBe(ExitCode.UNAVAILABLE);
    const all = [...h.out, ...h.err].join('\n');
    expect(all).not.toContain('hunter2secret');
    expect(all).not.toContain('postgres://');
  });

  it('status: prints stage, state and the event tail; unknown case is exit 6', async () => {
    const h = harness({ stage: 'verdict' });
    expect(await run(['status', 'case-1', '--tail', '3'], h.deps)).toBe(ExitCode.OK);
    const text = h.out.join('\n');
    expect(text).toContain('stage verdict');
    expect(text).toContain('state finished (verdict-written)');
    expect(h.out.filter((l) => l.startsWith('  #'))).toHaveLength(3);
    const nf = harness({ stage: new Error('unknown case case-x') });
    expect(await run(['status', 'case-x'], nf.deps)).toBe(ExitCode.NOT_FOUND);
  });

  it('status: a running case says so', async () => {
    const h = harness({ feed: () => events.slice(0, 4), stage: 'map' });
    expect(await run(['status', 'case-1'], h.deps)).toBe(ExitCode.OK);
    expect(h.out.join('\n')).toContain('state running or waiting');
  });

  it('replay: not implemented (exit 4) until Lane 2 provides it, wired when it does', async () => {
    const none = harness({ replay: undefined });
    expect(await run(['replay', 'bundle.tar'], none.deps)).toBe(ExitCode.NOT_IMPLEMENTED);
    expect(none.err.join('\n')).toContain('not implemented');
    const seen: string[] = [];
    const ok = harness({
      replay: (p) => {
        seen.push(p);
        return Promise.resolve(0);
      },
    });
    expect(await run(['replay', 'bundle.tar'], ok.deps)).toBe(ExitCode.OK);
    expect(seen).toEqual(['bundle.tar']);
  });
});

describe('robustness: usage errors, unexpected errors, hung queries, SIGINT', () => {
  const hungPort = (): CasePort => ({
    startCase: () => Promise.resolve(),
    stage: () => new Promise(() => undefined),
    events: () => new Promise(() => undefined),
    close: () => Promise.resolve(),
  });

  it('usage errors are sanitized before they reach the terminal', async () => {
    const h = harness({});
    expect(await run([`--bad${ESC}[31m${ESC}]0;pwned${BEL}`], h.deps)).toBe(ExitCode.USAGE);
    const text = h.err.join('\n');
    expect(text).toContain('unknown option');
    expect(text).not.toContain(ESC);
    expect(text).not.toContain(BEL);
    expect(text).not.toContain('pwned');
  });

  it('an unexpected error is exit 1 with a scrubbed message', async () => {
    const st = harness({ stage: new Error(`boom ${SECRET_URL}`) });
    expect(await run(['status', 'case-1'], st.deps)).toBe(ExitCode.INTERNAL);
    expect(st.err.join('\n')).toContain('unexpected error');
    expect(st.err.join('\n')).not.toContain('hunter2secret');
    const sc = harness({
      feed: () => {
        throw new Error('bad row');
      },
    });
    expect(await run(['scan', 'r'], sc.deps)).toBe(ExitCode.INTERNAL);
  });

  it('SIGINT during the poll sleep stops scan with 130 after printing what it had', async () => {
    const h = harness({ feed: () => events.slice(0, 2) });
    const c = new AbortController();
    const code = await run(['scan', 'r'], {
      ...h.deps,
      signal: c.signal,
      sleep: () => {
        c.abort();
        return Promise.resolve();
      },
    });
    expect(code).toBe(ExitCode.INTERRUPTED);
    expect(h.out.filter((l) => l.startsWith('#'))).toHaveLength(2);
    expect(h.err.join('\n')).toContain('keeps running');
  });

  it('SIGINT while a database query hangs still stops scan and status', async () => {
    const h = harness({});
    const c = new AbortController();
    const scan = run(['scan', 'r'], {
      ...h.deps,
      openPort: () => Promise.resolve(hungPort()),
      signal: c.signal,
    });
    setTimeout(() => c.abort(), 20);
    expect(await scan).toBe(ExitCode.INTERRUPTED);
    const c2 = new AbortController();
    const status = run(['status', 'case-1'], {
      ...h.deps,
      openPort: () => Promise.resolve(hungPort()),
      signal: c2.signal,
    });
    setTimeout(() => c2.abort(), 20);
    expect(await status).toBe(ExitCode.INTERRUPTED);
  });

  it('a hung events query does not outlive the scan timeout', async () => {
    const h = harness({});
    const started = Date.now();
    const code = await run(['scan', 'r', '--timeout', '1'], {
      ...h.deps,
      openPort: () => Promise.resolve({ ...hungPort(), startCase: () => Promise.resolve() }),
      now: Date.now,
    });
    expect(code).toBe(ExitCode.TIMEOUT);
    expect(Date.now() - started).toBeLessThan(5000);
  });
});

describe('watchCase', () => {
  it('prints each event once and ignores events for another case', async () => {
    const seen: number[] = [];
    const port: CasePort = {
      startCase: () => Promise.resolve(),
      stage: () => Promise.resolve('intake'),
      events: (id, after) =>
        Promise.resolve(
          [
            ...events.map((e) => ({ ...e, caseId: 'other' }) as typeof e),
            ...events.map((e) => ({ ...e, caseId: id }) as typeof e),
          ].filter((e) => e.seq > after),
        ),
      close: () => Promise.resolve(),
    };
    let t = 0;
    const r = await watchCase(port, 'c1', {
      pollMs: 10,
      timeoutMs: 1000,
      sleep: () => Promise.resolve(),
      now: () => t++,
      onEvent: (e) => seen.push(e.seq),
    });
    expect(r.kind).toBe('terminal');
    expect(seen).toEqual(events.map((e) => e.seq));
  });
});

describe('case file and error mapping', () => {
  it('builds from the fixture with a fresh id, the tenant and the target', () => {
    const a = buildCaseFile('my/repo', 'tenant-x');
    const b = buildCaseFile('my/repo', 'tenant-x');
    expect(a.id).not.toBe(b.id);
    expect(a.id).not.toBe('case-nodegoat-sqli-001');
    expect(a.tenantId).toBe('tenant-x');
    expect(a.target.repo).toBe('my/repo');
    expect(a.candidate.id).toBe('cand-sqli-001');
  });

  it('redacts connection strings and listed secrets from error messages', () => {
    const e = toCliError(new Error(`bad ${SECRET_URL} and pw-12345`), ['pw-12345']);
    expect(e.message).not.toContain('postgres://');
    expect(e.message).not.toContain('pw-12345');
  });
});
