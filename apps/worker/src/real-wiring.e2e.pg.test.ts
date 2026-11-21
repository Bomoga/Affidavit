import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  CaseFile,
  ExhibitResult,
  VerifyResult,
  samples,
  type CaseStage,
  type ModelPort,
} from '@affidavit/contracts';
import {
  APP_ROLE,
  OWNER_ROLE,
  WORKER_ROLE,
  applyMigrations,
  bootstrapRoles,
  openPool,
  provisionTenant,
  setRolePassword,
  type AppPool,
} from '@affidavit/db';
import type { DiscoverCaseInput, DiscoverCaseOutcome } from '@affidavit/discovery';
import { FakeJudge, readFixtureJson, sha256Hex } from '@affidavit/testing';
import { witnessExhibitId, witnessSha256 } from '@affidavit/trial';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';
import { startCase, startWorker, type RunningWorker } from './worker.js';

/**
 * The REAL wiring (AFFIDAVIT_INTAKE_IMPL, AFFIDAVIT_TRIAL_IMPL and AFFIDAVIT_JUDGE_IMPL all
 * `real`) on real Postgres and Graphile Worker, with fakes injected only through the documented
 * seams (`StartOptions.components`): discovery reproduces the stored case file, the model replays
 * scripted submissions, and the Judge is the scripted FakeJudge. Everything between those seams
 * (prerequisite gating, the real intake cores, the trial orchestrator and handlers, stage scoping,
 * the stage queue) is the production code. Same container rules as e2e.pg.test.ts.
 */
const PASSWORD = process.env.AFFIDAVIT_TEST_POSTGRES_PASSWORD;
const SKIP =
  'SKIPPED: set AFFIDAVIT_TEST_POSTGRES_PASSWORD to a fresh random value (Docker is required) and run `pnpm --filter @affidavit/worker test:pg`.';
const describePg = PASSWORD
  ? describe
  : (name: string, fn: () => void) => {
      console.warn(`[@affidavit/worker test:pg] ${name}: ${SKIP}`);
      describe.skip(`${name} (${SKIP})`, fn);
    };

const run = promisify(execFile);
const TENANT = 'tenant-real-wiring-e2e';
const STAGES: CaseStage[] = [
  'intake',
  'map',
  'arraign',
  'defense',
  'prosecution',
  'remedy',
  'verify',
  'verdict',
];
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const W = { template: 'witness template', params: [{ name: 'n', values: [1, 2] }] };
const FILE = 'app/data/allocations-dao.js';
const DIFF = `--- a/${FILE}\n+++ b/${FILE}\n@@ -1,1 +1,1 @@\n-q(id)\n+q("?", [id])\n`;
const ADMITTED = ExhibitResult.parse(readFixtureJson('exhibit-results/admissible.json'));
const PASS = VerifyResult.parse({
  ...(readFixtureJson('exhibit-results/verify-pass.json') as object),
  counterexamples: [],
});

type TurnRequest = Parameters<ModelPort['runTurn']>[0];
type TurnResult = Awaited<ReturnType<ModelPort['runTurn']>>;

/** Scripted submissions per prompt id: what a recorded model run would return. */
class ScriptedModel implements ModelPort {
  readonly requests: string[] = [];
  constructor(private readonly script: Record<string, TurnResult[]>) {}
  runTurn(req: TurnRequest): Promise<TurnResult> {
    this.requests.push(req.promptId);
    const next = this.script[req.promptId]?.shift();
    if (!next) return Promise.reject(new Error(`no scripted turn for ${req.promptId}`));
    return Promise.resolve(next);
  }
}

const turnCost = (stage: CaseStage) => ({
  stage,
  attempt: 1,
  inputTokens: 10,
  outputTokens: 5,
  usd: 0.01,
  wallMs: 1,
});

function composeImage(): string {
  const file = fileURLToPath(new URL('../../../docker/compose.yaml', import.meta.url));
  const m = /image:\s*(postgres:16@sha256:[0-9a-f]{64})/.exec(readFileSync(file, 'utf8'));
  if (!m?.[1]) throw new Error('no pinned postgres image in docker/compose.yaml');
  return m[1];
}

describePg('worker real wiring, injected fakes, real Postgres and Graphile Worker', () => {
  let container = '';
  let appUrl = '';
  let workerUrl = '';
  let appPool: AppPool;
  const running: RunningWorker[] = [];

  const psql = async (sql: string): Promise<string[][]> => {
    const { stdout } = await run('docker', [
      'exec',
      container,
      'psql',
      '-U',
      'affidavit',
      '-d',
      'affidavit',
      '-At',
      '-F',
      '|',
      '-c',
      sql,
    ]);
    return stdout
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => l.split('|'));
  };

  beforeAll(async () => {
    container = `affidavit-l1-10b-${randomBytes(4).toString('hex')}`;
    await run(
      'docker',
      [
        'run',
        '-d',
        '--name',
        container,
        '-e',
        'POSTGRES_PASSWORD',
        '-e',
        'POSTGRES_USER=affidavit',
        '-e',
        'POSTGRES_DB=affidavit',
        '-p',
        '127.0.0.1::5432',
        composeImage(),
      ],
      { env: { ...process.env, POSTGRES_PASSWORD: PASSWORD } },
    );
    for (let i = 0; i < 120; i++) {
      try {
        await run('docker', [
          'exec',
          container,
          'pg_isready',
          '-h',
          '127.0.0.1',
          '-U',
          'affidavit',
        ]);
        break;
      } catch {
        await wait(500);
      }
    }
    const { stdout } = await run('docker', ['port', container, '5432/tcp']);
    const port = /:(\d+)\s*$/m.exec(stdout.split('\n')[0] ?? '')?.[1];
    if (!port) throw new Error('could not read the container port');
    const url = (user: string, password: string) =>
      `postgres://${user}:${password}@127.0.0.1:${port}/affidavit`;
    const adminUrl = url('affidavit', PASSWORD ?? '');
    const ownerPw = randomBytes(18).toString('hex');
    const appPw = randomBytes(18).toString('hex');
    const workerPw = randomBytes(18).toString('hex');
    await bootstrapRoles(adminUrl);
    await setRolePassword(adminUrl, OWNER_ROLE, ownerPw);
    await applyMigrations(url(OWNER_ROLE, ownerPw));
    await provisionTenant(url(OWNER_ROLE, ownerPw), TENANT);
    await setRolePassword(adminUrl, APP_ROLE, appPw);
    await setRolePassword(adminUrl, WORKER_ROLE, workerPw);
    appUrl = url(APP_ROLE, appPw);
    workerUrl = url(WORKER_ROLE, workerPw);
    appPool = await openPool(appUrl, APP_ROLE);
  }, 180_000);

  afterEach(async () => {
    for (const w of running.splice(0)) await w.stop().catch(() => undefined);
  });

  afterAll(async () => {
    await appPool?.end().catch(() => undefined);
    if (container) await run('docker', ['rm', '-f', container]).catch(() => undefined);
  }, 60_000);

  const realEnv = () => ({
    AFFIDAVIT_APP_DATABASE_URL: appUrl,
    AFFIDAVIT_WORKER_DATABASE_URL: workerUrl,
    AFFIDAVIT_LEASE_SECONDS: '3',
    AFFIDAVIT_STALE_LOCK_SECONDS: '3',
    AFFIDAVIT_RECONCILE_INTERVAL_MS: '1000',
    AFFIDAVIT_POLL_INTERVAL_MS: '100',
    AFFIDAVIT_CONCURRENCY: '2',
    AFFIDAVIT_INTAKE_IMPL: 'real',
    AFFIDAVIT_TRIAL_IMPL: 'real',
    AFFIDAVIT_JUDGE_IMPL: 'real',
    AFFIDAVIT_JURY_ENABLED: 'false',
    AFFIDAVIT_INTAKE_WORK_ROOT: '/srv/affidavit/intake',
    AFFIDAVIT_REPO_SOURCES: JSON.stringify({
      [CaseFile.parse(samples.CaseFile).target.repo]: '/srv/repo',
    }),
    AFFIDAVIT_JUDGE_WORK_ROOT: '/srv/affidavit/judge',
    AFFIDAVIT_WITNESS_RUNNER_IMAGE: `sha256:${'b'.repeat(64)}`,
    AFFIDAVIT_EVIDENCE_DIR: '/srv/affidavit/evidence',
    AFFIDAVIT_SIGNER_SOCKET: '/run/affidavit/signer.sock',
  });

  const stageOf = async (id: string) =>
    (await psql(`select stage from cases where id='${id}'`))[0]?.[0];

  async function until(cond: () => boolean | Promise<boolean>, ms = 90_000): Promise<void> {
    const deadline = Date.now() + ms;
    while (!(await cond()) && Date.now() < deadline) await wait(200);
  }

  it('moves a case from intake to verdict, each stage once, through the real cores', async () => {
    const id = `case-real-${randomBytes(4).toString('hex')}`;
    const file = CaseFile.parse({ ...CaseFile.parse(samples.CaseFile), id, tenantId: TENANT });
    const discoverCalls: DiscoverCaseInput[] = [];
    const discover = (input: DiscoverCaseInput): Promise<DiscoverCaseOutcome> => {
      discoverCalls.push(input);
      return Promise.resolve({
        kind: 'case-file',
        caseFile: file,
        withheld: [],
        scanPartial: false,
      });
    };
    const fake = new FakeJudge({
      witnessResults: { [witnessSha256(W.template, W.params)]: ADMITTED },
      verifyResults: { [sha256Hex(DIFF)]: PASS },
    });
    // The Judge stamps the exhibit id it ran, as the real one does.
    const judge = {
      runCounterexample: fake.runCounterexample.bind(fake),
      verifyPatch: fake.verifyPatch.bind(fake),
      runWitness: async (...a: Parameters<FakeJudge['runWitness']>) => ({
        ...(await fake.runWitness(...a)),
        exhibitId: witnessExhibitId(a[0].id, a[1].template, a[1].params),
      }),
    };
    const model = new ScriptedModel({
      defense: [{ outcome: 'submitted', submission: W, cost: turnCost('defense') }],
      prosecution: [{ outcome: 'no-submission', cost: turnCost('prosecution') }],
      remedy: [{ outcome: 'submitted', submission: { diff: DIFF }, cost: turnCost('remedy') }],
    });

    const w = await startWorker(loadConfig(realEnv()), {
      log: () => undefined,
      // No host is probed for an injected part; the trial part has no host prerequisite.
      components: { env: realEnv(), discover, judge, model, log: () => undefined },
    });
    running.push(w);
    await startCase(appPool, file, {
      maxInputTokens: 1_000_000,
      maxOutputTokens: 200_000,
      maxUsd: 5,
    });

    await until(async () => (await stageOf(id)) === 'verdict');
    expect(await stageOf(id)).toBe('verdict');
    await until(
      async () =>
        (
          await psql(
            `select count(*) from stage_runs where case_id='${id}' and completed_at is null and failed_at is null`,
          )
        )[0]?.[0] === '0',
      20_000,
    );

    const history = (
      await psql(`select stage from stages where case_id='${id}' order by ordinal`)
    ).map((r) => r[0]);
    expect(history).toEqual(STAGES);
    const events = await psql(
      `select type, event->>'stage' from events where case_id='${id}' order by seq`,
    );
    expect(events.filter((e) => e[0] === 'stage-entered').map((e) => e[1])).toEqual(STAGES);
    expect(events.filter((e) => e[0] === 'stage-exited').map((e) => e[1])).toEqual(
      STAGES.slice(0, -1),
    );
    expect(events.filter((e) => e[0] === 'verdict-written')).toHaveLength(1);
    const seqs = (await psql(`select seq from events where case_id='${id}' order by seq`)).map(
      (r) => Number(r[0]),
    );
    expect(seqs).toEqual(seqs.map((_, i) => i));
    expect(
      (await psql(`select outcome from verdicts where case_id='${id}'`)).map((r) => r[0]),
    ).toEqual(['proven-fixed']);
    const runs = await psql(
      `select stage, attempt, (completed_at is not null) from stage_runs where case_id='${id}' order by stage, attempt`,
    );
    for (const stage of STAGES.slice(0, -1)) {
      expect(
        runs.filter((r) => r[0] === stage && r[2] === 't'),
        stage,
      ).toHaveLength(1);
    }
    expect(runs.filter((r) => Number(r[1]) > 1)).toEqual([]);
    // Discovery ran once (the three Lane 1 stages share it) and was asked for the stored candidate.
    expect(discoverCalls).toHaveLength(1);
    expect(discoverCalls[0]?.candidateId).toBe(file.candidate.id);
    expect(model.requests).toEqual(['defense', 'prosecution', 'remedy']);
  });
});
