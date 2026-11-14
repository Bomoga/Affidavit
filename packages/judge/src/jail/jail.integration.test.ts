import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_TRACE_ROOT,
  RUN_LABEL,
  createCaseNetwork,
  removeCaseNetwork,
  startJailedService,
  type CaseNetwork,
} from '@affidavit/sandbox';
import { Witness } from '@affidavit/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EvidenceVariant } from '../executor.js';
import { Judge } from '../judge.js';
import { DEFAULT_POLICY } from '../rules.js';
import { gateCaseFile, gateWitness } from '../test-helpers.js';
import { JailExecutor, type TargetEndpoint } from './executor.js';
import { RUNNER_IMAGE } from './harness.js';

// Needs a sandbox host (docs/lanes/lane2/sandbox-runner.md). Run with
// `pnpm --filter @affidavit/judge test:sandbox-host`; skipped in plain `pnpm test`.
const onSandboxHost = process.env.AFFIDAVIT_SANDBOX_HOST === '1';

/** A stand-in target: the vulnerable variant breaks on a quote, the safe one rejects it. */
const stubTarget = (vulnerable: boolean) => `
require('http').createServer((req, res) => {
  const id = new URL(req.url, 'http://x').searchParams.get('id') ?? '';
  if (req.url === '/health') return res.end('ok');
  if (${vulnerable} && id.includes("'")) { res.statusCode = 500; return res.end('SQL syntax error'); }
  if (!/^[0-9]+$/.test(id)) { res.statusCode = 400; return res.end('bad id'); }
  res.end('item ' + id);
}).listen(4000);
`;

/** The hand-written witness family: every quote payload must hit the SQL error. */
const SQLI_WITNESS = `
export default async ({ payload }, { target }) => {
  const res = await fetch(target.url + '/item?id=' + encodeURIComponent(payload));
  return res.status === 500 && (await res.text()).includes('SQL syntax error');
};
`;

const witness = (template: string, values: unknown[] = ["'", "1' OR '1'='1", "1'--"]): Witness =>
  Witness.parse({
    ...gateWitness(),
    template,
    params: [{ name: 'payload', values }],
  });

const leftovers = (kind: 'ps' | 'network') =>
  execFileSync(
    'docker',
    kind === 'ps'
      ? ['ps', '--all', '--quiet', '--filter', `label=${RUN_LABEL}`]
      : ['network', 'ls', '--quiet', '--filter', `label=${RUN_LABEL}`],
    { encoding: 'utf8' },
  ).trim();

describe.runIf(onSandboxHost)('witness jail on a sandbox host', { timeout: 300_000 }, () => {
  let workRoot = '';
  const endpoints = new Map<EvidenceVariant, TargetEndpoint>();
  const nets: CaseNetwork[] = [];
  let judge: Judge;
  let tracesBefore = 0;

  beforeAll(async () => {
    // Not in the describe body: Vitest runs that even when the suite is skipped.
    workRoot = mkdtempSync(join(tmpdir(), 'affidavit-jail-it-'));
    tracesBefore = readdirSync(DEFAULT_TRACE_ROOT).length;
    for (const variant of ['vulnerable', 'safe'] as const) {
      const net = await createCaseNetwork();
      nets.push(net);
      const svc = await startJailedService(net, {
        image: RUNNER_IMAGE,
        command: ['node', '-e', stubTarget(variant === 'vulnerable')],
        alias: 'target',
        readiness: [
          'node',
          '-e',
          "fetch('http://127.0.0.1:4000/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))",
        ],
      });
      endpoints.set(variant, {
        net,
        hosts: { target: svc.ip },
        url: 'http://target:4000',
      });
    }
    const executor = new JailExecutor({
      workRoot,
      targets: { endpoint: (req) => Promise.resolve(endpoints.get(req.variant) ?? null) },
    });
    judge = new Judge(executor, { ...DEFAULT_POLICY, hardTimeoutMs: 30_000, timeBudgetMs: 20_000 });
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

  it('admits a witness family on the differential rule, end to end in the jail', async () => {
    const r = await judge.runWitness(gateCaseFile(), witness(SQLI_WITNESS), ['vulnerable']);
    expect(r).toMatchObject({
      admissible: true,
      vulnPass: true,
      safeVariantFail: true,
      egressAttempts: 0,
    });
    expect(r.rejectedBy).toBeUndefined();
    expect(r.runs).toHaveLength(6);
    expect(r.familyResults).toEqual([
      { paramIndex: 0, passed: true },
      { paramIndex: 1, passed: true },
      { paramIndex: 2, passed: true },
    ]);
  });

  it('rejects a witness that passes on both variants (differential)', async () => {
    const r = await judge.runWitness(
      gateCaseFile(),
      witness(`export default async (_p, { target }) => (await fetch(target.url + '/health')).ok;`),
      ['vulnerable'],
    );
    expect(r).toMatchObject({ admissible: false, rejectedBy: 'differential' });
  });

  it('rejects a witness that also tries to reach the internet (no-egress)', async () => {
    const r = await judge.runWitness(
      gateCaseFile(),
      witness(
        `${SQLI_WITNESS.replace('export default', 'const real =')}
         export default async (p, ctx) => {
           await fetch('http://1.1.1.1/', { signal: AbortSignal.timeout(2000) }).catch(() => {});
           return real(p, ctx);
         };`,
      ),
      ['vulnerable'],
    );
    expect(r).toMatchObject({ admissible: false, rejectedBy: 'no-egress' });
    expect(r.egressAttempts).toBeGreaterThan(0);
  });

  it('rejects a witness that floods the trace past its cap (no-egress), without crashing', async () => {
    const flooding = new Judge(
      new JailExecutor({
        workRoot,
        maxTraceBytes: 4 * 1024 * 1024,
        targets: { endpoint: (req) => Promise.resolve(endpoints.get(req.variant) ?? null) },
      }),
      { ...DEFAULT_POLICY, hardTimeoutMs: 30_000, timeBudgetMs: 20_000 },
    );
    const r = await flooding.runWitness(
      gateCaseFile(),
      witness(`import fs from 'node:fs';
        export default () => { for (;;) { try { fs.openSync('/nope'); } catch {} } };`),
      ['vulnerable'],
    );
    expect(r).toMatchObject({ admissible: false });
    expect(['completes', 'no-egress']).toContain(r.rejectedBy);
  });

  it('rejects a witness that renames its process to hide from the trace (no-egress)', async () => {
    const r = await judge.runWitness(
      gateCaseFile(),
      witness(`process.title = 'a b';\n${SQLI_WITNESS}`),
      ['vulnerable'],
    );
    expect(r).toMatchObject({ admissible: false, rejectedBy: 'no-egress', egressAttempts: 0 });
  });

  it.each([
    ['malformed', `'not json'`],
    ['oversized', `JSON.stringify({ schemaVersion: 1, pad: 'x'.repeat(200000) })`],
  ])('rejects a %s artifact written by the witness itself (schema)', async (_kind, body) => {
    const r = await judge.runWitness(
      gateCaseFile(),
      witness(
        `import { writeFileSync } from 'node:fs';
         export default () => { writeFileSync('/out/result.json', ${body}); process.exit(0); };`,
      ),
      ['vulnerable'],
    );
    expect(r).toMatchObject({ admissible: false, rejectedBy: 'schema' });
  });

  it('cannot touch the result mount except by writing the one file', async () => {
    const r = await judge.runWitness(
      gateCaseFile(),
      witness(
        `import fs from 'node:fs';
         const tries = [
           () => fs.writeFileSync('/out/other', 'x'),
           () => fs.mkdirSync('/out/d'),
           () => fs.unlinkSync('/out/result.json'),
           () => fs.symlinkSync('/etc/passwd', '/out/link'),
           () => fs.writeFileSync('/witness/witness.mjs', 'x'),
           () => fs.writeFileSync('/scratch/big', Buffer.alloc(2 * 1024 * 1024)),
         ];
         export default () => tries.every((t) => { try { t(); return false; } catch { return true; } });`,
        [1],
      ),
      ['vulnerable'],
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
      const r = await judge.runWitness(
        gateCaseFile(),
        witness(
          `export default async ({ payload }) => {
             const ok = await fetch('http://' + payload + ':${port}/', { signal: AbortSignal.timeout(2500) })
               .then(() => true, () => false);
             return !ok;
           };`,
          hostIps,
        ),
        ['vulnerable'],
      );
      expect(seen).toEqual([]);
      expect(r.egressAttempts).toBeGreaterThan(0); // every try is recorded as egress
    } finally {
      server.close();
    }
  });
});
