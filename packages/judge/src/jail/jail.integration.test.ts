import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_TRACE_ROOT,
  PROBE_IMAGE,
  RUN_LABEL,
  createCaseNetwork,
  removeCaseNetwork,
  startJailedService,
  type CaseNetwork,
} from '@affidavit/sandbox';
import { Exhibit, Witness, type ParamSpace } from '@affidavit/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ExecutionRequest } from '../executor.js';
import { Judge, counterexampleExhibitId, patchExhibitId } from '../judge.js';
import { DEFAULT_POLICY } from '../rules.js';
import {
  GATE_PATCH_DIFF,
  PATCHED,
  RecordingRescan,
  ScriptedWorkbench,
  gateCaseFile,
  gateWitness,
  patchExhibit,
} from '../test-helpers.js';
import { JailExecutor, type JailExecutorOptions, type TargetEndpoint } from './executor.js';
import { buildRunnerImage } from './harness.js';
import { runWitnessJail } from './jail.js';

// Needs a sandbox host (docs/lanes/lane2/sandbox-runner.md). Run with
// `pnpm --filter @affidavit/judge test:sandbox-host`; skipped in plain `pnpm test`.
const onSandboxHost = process.env.AFFIDAVIT_SANDBOX_HOST === '1';

/**
 * Stand-in targets, keyed by name. The vulnerable variant breaks on a quote and the safe one
 * rejects it. `patched` is a correct fix; `patched-partial` blocks one payload and still breaks
 * on the others, like a fix that special-cases the witness's input.
 */
const BREAKS_ON = {
  vulnerable: `id.includes("'")`,
  safe: 'false',
  patched: 'false',
  'patched-partial': `id.includes("'") && id !== "1'--"`,
} as const;
type StubName = keyof typeof BREAKS_ON;

const stubTarget = (name: StubName) => `
require('http').createServer((req, res) => {
  const id = new URL(req.url, 'http://x').searchParams.get('id') ?? '';
  if (req.url === '/health') return res.end('ok');
  if (${BREAKS_ON[name]}) { res.statusCode = 500; return res.end('SQL syntax error'); }
  if (!/^[0-9]+$/.test(id)) { res.statusCode = 400; return res.end('bad id'); }
  res.end('item ' + id);
}).listen(4000);
`;

const HEADER = `import { expect } from 'vitest';
import { witness } from '@affidavit/witness';
`;

/** The hand-written witness family, in the L2-05 format: every quote payload hits the SQL error. */
const SQLI_WITNESS = `${HEADER}
interface Params { payload: string }

witness<Params>(async ({ payload }, { target }) => {
  const res = await fetch(\`\${target!.url}/item?id=\${encodeURIComponent(payload)}\`);
  expect(res.status).toBe(500);
  expect(await res.text()).toContain('SQL syntax error');
});
`;

const PAYLOADS = ["'", "1' OR '1'='1", "1'--"];

const witness = (template: string, params: ParamSpace = [{ name: 'payload', values: PAYLOADS }]) =>
  Witness.parse({ ...gateWitness(), template, params });

const leftovers = (kind: 'ps' | 'network') =>
  execFileSync(
    'docker',
    kind === 'ps'
      ? ['ps', '--all', '--quiet', '--filter', `label=${RUN_LABEL}`]
      : ['network', 'ls', '--quiet', '--filter', `label=${RUN_LABEL}`],
    { encoding: 'utf8' },
  ).trim();

const POLICY = { ...DEFAULT_POLICY, hardTimeoutMs: 30_000, timeBudgetMs: 20_000 };

describe.runIf(onSandboxHost)('witness jail on a sandbox host', { timeout: 300_000 }, () => {
  let workRoot = '';
  let runnerImage = '';
  const endpoints = new Map<StubName, TargetEndpoint>();
  /** Which stub the patched target is; the commit stands in for "the patch that was built". */
  let patchedStub: StubName = 'patched';
  const stubFor = (req: ExecutionRequest): StubName =>
    req.variant === 'patched' ? patchedStub : req.variant;
  const nets: CaseNetwork[] = [];
  let tracesBefore = 0;

  const executorOpts = (over: Partial<JailExecutorOptions> = {}): JailExecutorOptions => ({
    workRoot,
    runnerImage,
    targets: { endpoint: (req) => Promise.resolve(endpoints.get(stubFor(req)) ?? null) },
    ...over,
  });
  const judge = (over: Partial<JailExecutorOptions> = {}) =>
    new Judge(new JailExecutor(executorOpts(over)), POLICY);
  const run = (template: string, params?: ParamSpace) =>
    judge().runWitness(gateCaseFile(), witness(template, params), ['vulnerable']);

  /** Runs the runner once without a target and returns the raw artifact. */
  const runnerArtifact = async (source: string, params: ParamSpace) =>
    (
      await runWitnessJail(
        {
          source,
          input: { schemaVersion: 1, params, target: null, testTimeoutMs: 20_000 },
          timeoutMs: 30_000,
        },
        { workRoot, runnerImage },
        65_536,
      )
    ).artifact;

  beforeAll(async () => {
    // Not in the describe body: Vitest runs that even when the suite is skipped.
    workRoot = mkdtempSync(join(tmpdir(), 'affidavit-jail-it-'));
    runnerImage = await buildRunnerImage();
    tracesBefore = readdirSync(DEFAULT_TRACE_ROOT).length;
    for (const variant of Object.keys(BREAKS_ON) as StubName[]) {
      const net = await createCaseNetwork();
      nets.push(net);
      const svc = await startJailedService(net, {
        image: PROBE_IMAGE,
        command: ['node', '-e', stubTarget(variant)],
        alias: 'target',
        readiness: [
          'node',
          '-e',
          "fetch('http://127.0.0.1:4000/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))",
        ],
      });
      endpoints.set(variant, { net, hosts: { target: svc.ip }, url: 'http://target:4000' });
    }
  });

  afterAll(async () => {
    try {
      for (const net of nets) await removeCaseNetwork(net);
    } finally {
      rmSync(workRoot, { recursive: true, force: true });
    }
    expect(leftovers('ps')).toBe('');
    expect(leftovers('network')).toBe('');
    expect(readdirSync(DEFAULT_TRACE_ROOT).length).toBe(tracesBefore);
  });

  describe('L2-05: the runner and the witness format', () => {
    it('runs every parameter, last one fastest, and reports each one', async () => {
      const raw = await runnerArtifact(
        `${HEADER}
         witness<{ a: number; b: string }>(({ a, b }) => {
           expect(a === 2 && b === 'y').toBe(false);
           expect(b).not.toBe('z');
         });`,
        [
          { name: 'a', values: [1, 2] },
          { name: 'b', values: ['x', 'y', 'z'] },
        ],
      );
      // (1,x) (1,y) (1,z) (2,x) (2,y) (2,z)
      expect(JSON.parse(raw ?? 'null')).toEqual({
        schemaVersion: 1,
        results: [true, true, false, true, false, false].map((passed, paramIndex) => ({
          paramIndex,
          passed,
        })),
      });
    });

    it('runs an empty ParamSpace once', async () => {
      const raw = await runnerArtifact(`${HEADER} witness(() => {});`, []);
      expect(JSON.parse(raw ?? 'null')).toEqual({
        schemaVersion: 1,
        results: [{ paramIndex: 0, passed: true }],
      });
    });

    it.each([
      ['never calls witness()', `${HEADER} expect(1).toBe(1);`],
      ['calls witness() twice', `${HEADER} witness(() => {}); witness(() => {});`],
      ['does not compile', `${HEADER} witness(() => { const x = ; });`],
      [
        'adds a forged parameter test',
        `${HEADER} import { test } from 'vitest'; witness(() => {}); test('affidavit param 7', () => {});`,
      ],
      [
        'duplicates a parameter test',
        `${HEADER} import { test } from 'vitest'; witness(() => {}); test('affidavit param 0', () => {});`,
      ],
    ])('writes no artifact when the witness %s', async (_label, source) => {
      expect(await runnerArtifact(source, [{ name: 'p', values: [1] }])).toBeNull();
    });
  });

  it('admits a witness family on the differential rule, end to end in the jail', async () => {
    const r = await run(SQLI_WITNESS);
    expect(r).toMatchObject({
      admissible: true,
      vulnPass: true,
      safeVariantFail: true,
      egressAttempts: 0,
    });
    expect(r.rejectedBy).toBeUndefined();
    expect(r.runs).toHaveLength(6);
    expect(r.familyResults).toEqual(
      PAYLOADS.map((_, paramIndex) => ({ paramIndex, passed: true })),
    );
  });

  describe('L2-07: verifyPatch in the jail', () => {
    const verify = async (stub: StubName, counterexamples: Exhibit[] = []) => {
      patchedStub = stub;
      const workbench = new ScriptedWorkbench();
      const rescan = new RecordingRescan();
      const judge = new Judge(new JailExecutor(executorOpts()), POLICY, { workbench, rescan });
      const r = await judge.verifyPatch(
        gateCaseFile(),
        patchExhibit(GATE_PATCH_DIFF),
        witness(SQLI_WITNESS),
        counterexamples,
      );
      expect(workbench.released).toBe(1);
      expect(rescan.paths).toEqual([PATCHED.workspacePath]);
      return r;
    };
    const counter = (code: string): Exhibit =>
      Exhibit.parse({
        schemaVersion: 1,
        id: 'exhibit-counter-it',
        caseId: gateCaseFile().id,
        author: 'prosecution',
        kind: 'counterexample',
        code,
        sha256: '9'.repeat(64),
      });

    it('flips the whole witness family on a patched target', async () => {
      expect(await verify('patched')).toEqual({
        schemaVersion: 1,
        patchExhibitId: patchExhibitId(patchExhibit(GATE_PATCH_DIFF)),
        familyFlipped: true,
        suitePassed: true,
        rescanClean: true,
        counterexamples: [],
      });
    });

    it('uses only admissible counterexamples against the patch', async () => {
      // The SQLi family as a counterexample is admissible (passes vulnerable, fails safe) and
      // beats the partial fix. The health check passes on every variant, so it is not used.
      const sqli = counter(SQLI_WITNESS);
      const health = counter(
        `${HEADER} witness(async (_p, { target }) => {
           expect((await fetch(target!.url + '/health')).ok).toBe(true);
         });`,
      );
      const params = witness(SQLI_WITNESS).params;
      const r = await verify('patched-partial', [sqli, health]);
      expect(r.counterexamples).toEqual([
        { exhibitId: counterexampleExhibitId(sqli, params), survived: true },
        { exhibitId: counterexampleExhibitId(health, params), survived: false },
      ]);
    });

    it('does not flip when the patch only blocks one payload', async () => {
      expect(await verify('patched-partial')).toMatchObject({
        familyFlipped: false,
        rejectedBy: 'differential',
      });
    });
  });

  it('creates case networks with IPv6 off and only IPv4 subnets', () => {
    for (const net of nets) {
      const out = execFileSync(
        'docker',
        [
          'network',
          'inspect',
          '--format',
          '{{.EnableIPv6}} {{range .IPAM.Config}}{{.Subnet}} {{end}}',
          net.name,
        ],
        { encoding: 'utf8' },
      ).trim();
      const [ipv6, ...subnets] = out.split(/\s+/);
      expect(ipv6).toBe('false');
      expect(subnets.every((s) => !s.includes(':'))).toBe(true);
    }
  });

  it("rejects a witness that queries Docker's embedded DNS resolver (no-egress)", async () => {
    const r = await run(
      `${HEADER}
        import dns from 'node:dns/promises';
        witness(async () => { await dns.resolve4('example.com').catch(() => {}); });`,
    );
    expect(r).toMatchObject({ admissible: false, rejectedBy: 'no-egress' });
    expect(r.egressAttempts).toBeGreaterThan(0);
  });

  it('rejects a witness that passes on both variants (differential)', async () => {
    const r = await run(
      `${HEADER} witness(async (_p, { target }) => {
         expect((await fetch(target!.url + '/health')).ok).toBe(true);
       });`,
    );
    expect(r).toMatchObject({ admissible: false, rejectedBy: 'differential' });
  });

  it('rejects a witness that also tries to reach the internet (no-egress)', async () => {
    const r = await run(
      SQLI_WITNESS.replace(
        'witness<Params>(async ({ payload }, { target }) => {',
        `witness<Params>(async ({ payload }, { target }) => {
           await fetch('http://1.1.1.1/', { signal: AbortSignal.timeout(2000) }).catch(() => {});`,
      ),
    );
    expect(r).toMatchObject({ admissible: false, rejectedBy: 'no-egress' });
    expect(r.egressAttempts).toBeGreaterThan(0);
  });

  it('rejects a witness that floods the trace past its cap, without crashing', async () => {
    const r = await judge({ maxTraceBytes: 4 * 1024 * 1024 }).runWitness(
      gateCaseFile(),
      witness(`${HEADER}
        import fs from 'node:fs';
        witness(() => { for (;;) { try { fs.openSync('/nope'); } catch {} } });`),
      ['vulnerable'],
    );
    expect(r).toMatchObject({ admissible: false });
    expect(['completes', 'no-egress']).toContain(r.rejectedBy);
  });

  it('rejects a witness that renames its process to hide from the trace (no-egress)', async () => {
    const r = await run(`process.title = 'a b';\n${SQLI_WITNESS}`);
    expect(r).toMatchObject({ admissible: false, rejectedBy: 'no-egress', egressAttempts: 0 });
  });

  it.each([
    ['malformed', `'not json'`],
    ['oversized', `JSON.stringify({ schemaVersion: 1, pad: 'x'.repeat(200000) })`],
  ])(
    'rejects a %s artifact the witness forges before killing the runner (schema)',
    async (_kind, body) => {
      const r = await run(
        `${HEADER}
       import { writeFileSync } from 'node:fs';
       witness(() => { writeFileSync('/out/result.json', ${body}); process.kill(process.ppid, 'SIGKILL'); });`,
      );
      expect(r).toMatchObject({ admissible: false, rejectedBy: 'schema' });
    },
  );

  it('cannot touch the result mount or the witness except by writing the one file', async () => {
    const r = await run(
      `${HEADER}
       import fs from 'node:fs';
       const tries = [
         () => fs.writeFileSync('/out/other', 'x'),
         () => fs.mkdirSync('/out/d'),
         () => fs.unlinkSync('/out/result.json'),
         () => fs.symlinkSync('/etc/passwd', '/out/link'),
         () => fs.writeFileSync('/runner/witness/witness.test.ts', 'x'),
         () => fs.writeFileSync('/runner/run.mjs', 'x'),
         () => fs.writeFileSync('/scratch/big', Buffer.alloc(2 * 1024 * 1024)),
       ];
       witness(() => {
         for (const t of tries) expect(() => t()).toThrow();
       });`,
      [{ name: 'p', values: [1] }],
    );
    // Every attempt failed inside the jail, so the family "passed" on both variants.
    expect(r.rejectedBy).toBe('differential');
    expect(r.safeVariantFail).toBe(false);
    expect(r.runs.every((run) => run.passed)).toBe(true);
  });

  it('gives the witness no route to any address of the host', async () => {
    const seen: string[] = [];
    const server: Server = createServer((req, res) => {
      seen.push(req.url ?? '');
      res.end('host');
    });
    await new Promise<void>((ok) => server.listen(0, '0.0.0.0', ok));
    const port = (server.address() as { port: number }).port;
    const hostIps = Object.values(networkInterfaces())
      .flat()
      .filter((a) => a?.family === 'IPv4' && !a.internal)
      .map((a) => a?.address ?? '');
    try {
      const r = await run(
        `${HEADER} witness<{ ip: string }>(async ({ ip }) => {
           const reached = await fetch('http://' + ip + ':${port}/', { signal: AbortSignal.timeout(2500) })
             .then(() => true, () => false);
           expect(reached).toBe(false);
         });`,
        [{ name: 'ip', values: hostIps }],
      );
      expect(seen).toEqual([]);
      expect(r.egressAttempts).toBeGreaterThan(0); // every try is recorded as egress
    } finally {
      server.close();
    }
  });
});
