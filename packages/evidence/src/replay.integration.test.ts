import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PROBE_IMAGE,
  RUN_LABEL,
  createCaseNetwork,
  removeCaseNetwork,
  startJailedService,
  type CaseNetwork,
} from '@affidavit/sandbox';
import {
  DEFAULT_POLICY,
  JailExecutor,
  Judge,
  buildRunnerImage,
  type ExecutionVariant,
  type TargetEndpoint,
} from '@affidavit/judge';
import { Exhibit, Witness } from '@affidavit/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildBundle, type ExhibitRecord } from './bundle.js';
import { REPLAY_EXIT, replay, replayBundle } from './replay.js';
import { readTar, writeTar } from './tar.js';
import { bundleInput, caseFile, verdict } from './test-helpers.js';

// Needs a sandbox host (docs/lanes/lane2/sandbox-runner.md). Run with
// `pnpm --filter @affidavit/evidence test:sandbox-host`; skipped in plain `pnpm test`.
const onSandboxHost = process.env.AFFIDAVIT_SANDBOX_HOST === '1';

/** Same stand-in target as the jail tests: the vulnerable variant breaks on a quote. */
const stubTarget = (vulnerable: boolean) => `
require('http').createServer((req, res) => {
  const id = new URL(req.url, 'http://x').searchParams.get('id') ?? '';
  if (req.url === '/health') return res.end('ok');
  if (${vulnerable} && id.includes("'")) { res.statusCode = 500; return res.end('SQL syntax error'); }
  if (!/^[0-9]+$/.test(id)) { res.statusCode = 400; return res.end('bad id'); }
  res.end('item ' + id);
}).listen(4000);
`;

const HEADER = `import { expect } from 'vitest';
import { witness } from '@affidavit/witness';
`;

const SQLI_WITNESS = `${HEADER}
witness<{ payload: string }>(async ({ payload }, { target }) => {
  const res = await fetch(\`\${target!.url}/item?id=\${encodeURIComponent(payload)}\`);
  expect(res.status).toBe(500);
  expect(await res.text()).toContain('SQL syntax error');
});
`;

/** Passes on both variants, so the differential rule must reject it, on replay too. */
const NOT_DIFFERENTIAL = `${HEADER}
witness<{ payload: string }>(async (_p, { target }) => {
  const res = await fetch(\`\${target!.url}/health\`);
  expect(res.ok).toBe(true);
});
`;

const COUNTEREXAMPLE_CODE = `${HEADER}
witness<{ payload: string }>(async ({ payload }, { target }) => {
  const res = await fetch(\`\${target!.url}/item?id=1\${encodeURIComponent(payload)}\`);
  expect(res.status).toBe(500);
});
`;

const PAYLOADS = ["'", "1' OR '1'='1", "1'--"];

const witness = (id: string, template: string) =>
  Witness.parse({
    schemaVersion: 1,
    id,
    caseId: 'case-nodegoat-sqli-001',
    cls: 'injection',
    template,
    params: [{ name: 'payload', values: PAYLOADS }],
    author: 'defense',
    sha256: '1'.repeat(64),
  });

const POLICY = { ...DEFAULT_POLICY, hardTimeoutMs: 30_000, timeBudgetMs: 20_000 };

const leftovers = (kind: 'ps' | 'network') =>
  execFileSync(
    'docker',
    kind === 'ps'
      ? ['ps', '--all', '--quiet', '--filter', `label=${RUN_LABEL}`]
      : ['network', 'ls', '--quiet', '--filter', `label=${RUN_LABEL}`],
    { encoding: 'utf8' },
  ).trim();

describe.runIf(onSandboxHost)('L2-08 replay on a sandbox host', { timeout: 600_000 }, () => {
  let workRoot = '';
  let runnerImage = '';
  const nets: CaseNetwork[] = [];

  /** Boots a fresh pair of targets on fresh case networks, as a second machine would. */
  async function freshJudge(): Promise<Judge> {
    // Keyed by every variant an executor may be asked for (`patched` included since L2-07); only
    // vulnerable and safe are booted here.
    const endpoints = new Map<ExecutionVariant, TargetEndpoint>();
    for (const variant of ['vulnerable', 'safe'] as const) {
      const net = await createCaseNetwork();
      nets.push(net);
      const svc = await startJailedService(net, {
        image: PROBE_IMAGE,
        command: ['node', '-e', stubTarget(variant === 'vulnerable')],
        alias: 'target',
        readiness: [
          'node',
          '-e',
          "fetch('http://127.0.0.1:4000/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))",
        ],
      });
      endpoints.set(variant, { net, hosts: { target: svc.ip }, url: 'http://target:4000' });
    }
    return new Judge(
      new JailExecutor({
        workRoot,
        runnerImage,
        targets: { endpoint: (req) => Promise.resolve(endpoints.get(req.variant) ?? null) },
      }),
      POLICY,
    );
  }

  let bundleBytes: Uint8Array = new Uint8Array();
  let recorded: ExhibitRecord[] = [];

  beforeAll(async () => {
    workRoot = mkdtempSync(join(tmpdir(), 'affidavit-replay-it-'));
    runnerImage = await buildRunnerImage();

    // The original trial: record what the Judge decided.
    const judge = await freshJudge();
    const cf = caseFile();
    const w = witness('witness-sqli-001', SQLI_WITNESS);
    const weak = witness('witness-weak-001', NOT_DIFFERENTIAL);
    const counter = Exhibit.parse({
      schemaVersion: 1,
      id: 'submitted-counter',
      caseId: cf.id,
      author: 'prosecution',
      kind: 'counterexample',
      code: COUNTEREXAMPLE_CODE,
      sha256: '2'.repeat(64),
    });
    const wRes = await judge.runWitness(cf, w, ['vulnerable', 'safe']);
    const weakRes = await judge.runWitness(cf, weak, ['vulnerable', 'safe']);
    const cRes = await judge.runCounterexample(cf, w, counter);
    expect(wRes.admissible).toBe(true);
    expect(weakRes.rejectedBy).toBe('differential');
    expect(cRes.admissible).toBe(true);
    recorded = [
      { schemaVersion: 1, kind: 'witness', witness: w, result: wRes },
      { schemaVersion: 1, kind: 'witness', witness: weak, result: weakRes },
      {
        schemaVersion: 1,
        kind: 'counterexample',
        witnessExhibitId: wRes.exhibitId,
        counterexample: counter,
        result: cRes,
      },
    ];
    const built = await buildBundle(
      bundleInput({
        exhibits: recorded,
        verdict: {
          ...verdict(),
          outcome: 'proven-unfixed',
          exhibits: [wRes.exhibitId],
        },
      }),
    );
    bundleBytes = built.bytes;
  }, 600_000);

  afterAll(async () => {
    try {
      for (const net of nets) await removeCaseNetwork(net);
    } finally {
      rmSync(workRoot, { recursive: true, force: true });
    }
    expect(leftovers('ps')).toBe('');
    expect(leftovers('network')).toBe('');
  }, 120_000);

  it('replays with a fresh Judge and fresh targets to identical admissibility outcomes', async () => {
    const report = await replay(bundleBytes, { judge: await freshJudge() });
    expect(report.integrity.ok).toBe(true);
    expect('exhibits' in report && report.exhibits.map((e) => e.status)).toEqual([
      'match',
      'match',
      'match',
    ]);
    expect(report.ok).toBe(true);
  });

  it('replays through the CLI entry point from a file', async () => {
    const path = join(workRoot, 'bundle.tar');
    writeFileSync(path, bundleBytes);
    const lines: string[] = [];
    const code = await replayBundle(path, { judge: await freshJudge(), out: (l) => lines.push(l) });
    expect(code).toBe(REPLAY_EXIT.MATCH);
    expect(lines.at(-1)).toBe('replay: same outcomes');
  });

  it('refuses a bundle whose witness code was changed, naming the exhibit, before running it', async () => {
    const files = await readTar(bundleBytes);
    const first = recorded[0];
    if (first?.kind !== 'witness') throw new Error('expected the witness record first');
    const id = first.result.exhibitId;
    const name = `exhibits/${id}.json`;
    const swapped = Buffer.from(files.get(name)!)
      .toString('utf8')
      .replace('toBe(500)', 'toBe(200)');
    files.set(name, new Uint8Array(Buffer.from(swapped)));
    const tampered = await writeTar([...files].map(([n, bytes]) => ({ name: n, bytes })));
    const report = await replay(tampered, { judge: await freshJudge() });
    expect(report.ok).toBe(false);
    expect(report.integrity).toMatchObject({ ok: false, exhibitId: id });
  });
});
