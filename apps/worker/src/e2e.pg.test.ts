import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { CaseFile, samples } from '@affidavit/contracts';
import {
  APP_ROLE,
  OWNER_ROLE,
  WORKER_ROLE,
  applyMigrations,
  bootstrapRoles,
  PgCaseStore,
  enqueueStage,
  openPool,
  provisionTenant,
  setRolePassword,
  type AppPool,
} from '@affidavit/db';
import { afterAll, beforeAll, afterEach, describe, expect, it } from 'vitest';
import { loadConfig, type WorkerConfig } from './config.js';
import { startCase, startWorker, type RunningWorker } from './worker.js';

/**
 * End to end against a throwaway Postgres container that THIS file starts and removes (image from
 * the digest in docker/compose.yaml, random localhost port, no volume). The password comes only
 * from process env (AFFIDAVIT_TEST_POSTGRES_PASSWORD) and is handed to Docker by variable name,
 * so it is never on a command line or in a file. The role URLs for the worker are built in memory.
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
const TENANT = 'tenant-worker-e2e';
const STAGES = [
  'intake',
  'map',
  'arraign',
  'defense',
  'prosecution',
  'remedy',
  'verify',
  'jury',
  'verdict',
];
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function composeImage(): string {
  const file = fileURLToPath(new URL('../../../docker/compose.yaml', import.meta.url));
  const m = /image:\s*(postgres:16@sha256:[0-9a-f]{64})/.exec(readFileSync(file, 'utf8'));
  if (!m?.[1]) throw new Error('no pinned postgres image in docker/compose.yaml');
  return m[1];
}

describePg('worker composition root, fakes, real Postgres and Graphile Worker', () => {
  let container = '';
  let appUrl = '';
  let workerUrl = '';
  let appPool: AppPool;
  const running: RunningWorker[] = [];
  const children: { kill(): Promise<void> }[] = [];

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
    container = `affidavit-l1-10-${randomBytes(4).toString('hex')}`;
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
    // The image restarts the server after its init scripts; only the final one listens on TCP.
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
    for (const c of children.splice(0)) await c.kill().catch(() => undefined);
    for (const w of running.splice(0)) await w.stop().catch(() => undefined);
  });

  afterAll(async () => {
    await appPool?.end().catch(() => undefined);
    // Only the container this file created.
    if (container) await run('docker', ['rm', '-f', container]).catch(() => undefined);
  }, 60_000);

  const env = (extra: Record<string, string> = {}) => ({
    AFFIDAVIT_APP_DATABASE_URL: appUrl,
    AFFIDAVIT_WORKER_DATABASE_URL: workerUrl,
    AFFIDAVIT_LEASE_SECONDS: '3',
    AFFIDAVIT_STALE_LOCK_SECONDS: '3',
    AFFIDAVIT_RECONCILE_INTERVAL_MS: '1000',
    AFFIDAVIT_POLL_INTERVAL_MS: '100',
    AFFIDAVIT_CONCURRENCY: '2',
    ...extra,
  });
  const config = (): WorkerConfig => loadConfig(env());

  async function newCase(): Promise<string> {
    const base = CaseFile.parse(samples.CaseFile);
    const id = `case-e2e-${randomBytes(4).toString('hex')}`;
    const file = CaseFile.parse({ ...base, id, tenantId: TENANT });
    await startCase(appPool, file, {
      maxInputTokens: 1_000_000,
      maxOutputTokens: 200_000,
      maxUsd: 5,
    });
    return id;
  }

  const stageOf = async (id: string) =>
    (await psql(`select stage from cases where id='${id}'`))[0]?.[0];

  async function until(cond: () => boolean | Promise<boolean>, ms = 90_000): Promise<void> {
    const deadline = Date.now() + ms;
    while (!(await cond()) && Date.now() < deadline) await wait(200);
  }

  /** Stage history, events and attempts: proves each stage ran once, not just that the end state is right. */
  async function expectNoDuplicateStage(id: string, abandoned: string[] = []) {
    const history = (
      await psql(`select stage from stages where case_id='${id}' order by ordinal`)
    ).map((r) => r[0]);
    expect(history).toEqual(STAGES);

    const events = await psql(
      `select type, event->>'stage', event->'payload'->>'from', event->'payload'->>'to' from events where case_id='${id}' order by seq`,
    );
    const entered = events.filter((e) => e[0] === 'stage-entered').map((e) => e[1]);
    expect(entered).toEqual(STAGES);
    const exited = events.filter((e) => e[0] === 'stage-exited').map((e) => e[1]);
    expect(exited).toEqual(STAGES.slice(0, -1));
    expect(events.filter((e) => e[0] === 'verdict-written')).toHaveLength(1);
    expect(events.filter((e) => e[0] === 'exhibit-result')).toHaveLength(1);
    // The per-case sequence has no gaps and no repeats.
    const seqs = (await psql(`select seq from events where case_id='${id}' order by seq`)).map(
      (r) => Number(r[0]),
    );
    expect(seqs).toEqual(seqs.map((_, i) => i));

    const verdicts = await psql(`select count(*) from verdicts where case_id='${id}'`);
    expect(verdicts[0]?.[0]).toBe('1');

    const runs = await psql(
      `select stage, attempt, (completed_at is not null), (failed_at is not null) from stage_runs where case_id='${id}' order by stage, attempt`,
    );
    for (const stage of STAGES.slice(0, -1)) {
      const completed = runs.filter((r) => r[0] === stage && r[2] === 't');
      expect(completed, `completed attempts of ${stage}`).toHaveLength(1);
    }
    // Attempts that were abandoned are failed, never completed, and never ran twice.
    for (const a of abandoned) {
      expect(runs.filter((r) => r[0] === a && r[3] === 't')).toHaveLength(1);
    }
    expect(runs.some((r) => r[0] === 'verdict')).toBe(false);
  }

  function spawnChild(extra: Record<string, string>) {
    const cwd = fileURLToPath(new URL('..', import.meta.url));
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/test-child.ts'], {
      cwd,
      env: {
        // Only the role URLs, never the admin password.
        ...Object.fromEntries(
          Object.entries(process.env).filter(([k]) => k !== 'AFFIDAVIT_TEST_POSTGRES_PASSWORD'),
        ),
        ...env(),
        ...extra,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const lines: string[] = [];
    let stderr = '';
    let buf = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d: string) => {
      buf += d;
      const parts = buf.split('\n');
      buf = parts.pop() ?? '';
      lines.push(...parts.map((s) => s.trim()).filter((s) => /^(READY|STARTED|HUNG)( |$)/.test(s)));
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d: string) => (stderr += d));
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    const handle = {
      lines,
      stderr: () => stderr,
      async kill() {
        child.kill('SIGKILL');
        await exited;
      },
    };
    children.push(handle);
    return handle;
  }

  it('moves a case from intake to verdict through every stage exactly once', async () => {
    const w = await startWorker(config(), { log: () => undefined });
    running.push(w);
    const id = await newCase();
    await until(async () => (await stageOf(id)) === 'verdict');
    expect(await stageOf(id)).toBe('verdict');
    // Let the last attempt finish completing.
    await until(
      async () =>
        (
          await psql(
            `select count(*) from stage_runs where case_id='${id}' and completed_at is null and failed_at is null`,
          )
        )[0]?.[0] === '0',
      20_000,
    );
    await expectNoDuplicateStage(id);
    // No retry ever happened.
    expect(
      (await psql(`select count(*) from stage_runs where case_id='${id}' and attempt > 1`))[0]?.[0],
    ).toBe('0');
  });

  it('SIGKILL mid-stage: the restarted worker abandons the dead attempt, runs attempt 2, and no stage repeats', async () => {
    const id = await newCase();
    const first = spawnChild({ CHILD_HANG_BEFORE: 'map:1' });
    await until(() => first.lines.includes('HUNG map 1'));
    expect(first.lines, first.stderr()).toContain('HUNG map 1');
    expect(await stageOf(id)).toBe('map');
    await first.kill();

    const second = spawnChild({});
    await until(() => first.lines.length > 0 && second.lines.includes('READY'));
    await until(async () => (await stageOf(id)) === 'verdict');
    expect(await stageOf(id), second.stderr()).toBe('verdict');
    await until(
      async () =>
        (
          await psql(
            `select count(*) from stage_runs where case_id='${id}' and completed_at is null and failed_at is null`,
          )
        )[0]?.[0] === '0',
      20_000,
    );

    // The killed attempt was never started again; the retry is attempt 2 of map only.
    expect(first.lines.filter((l) => l.startsWith('STARTED'))).toEqual([
      'STARTED intake 1',
      'STARTED map 1',
    ]);
    expect(second.lines.filter((l) => l.startsWith('STARTED')).slice(0, 1)).toEqual([
      'STARTED map 2',
    ]);
    expect(second.lines).not.toContain('STARTED map 1');
    expect(second.lines).not.toContain('STARTED intake 1');
    const attempts = await psql(
      `select stage, attempt, (completed_at is not null), (failed_at is not null) from stage_runs where case_id='${id}' and attempt > 1`,
    );
    expect(attempts).toEqual([['map', '2', 't', 'f']]);
    // The retry was charged before it ran (a zero-amount row naming attempt 2).
    expect(
      (
        await psql(
          `select count(*) from cost_rows where case_id='${id}' and attempt=2 and stage='map'`,
        )
      )[0]?.[0],
    ).toBe('1');
    await expectNoDuplicateStage(id, ['map']);
  });

  it('SIGKILL after the case moved on but before the next job: the attempt is adopted, the next stage enqueued once', async () => {
    const id = await newCase();
    const first = spawnChild({ CHILD_HANG_AFTER: 'arraign:1' });
    await until(() => first.lines.includes('HUNG arraign 1'));
    expect(first.lines, first.stderr()).toContain('HUNG arraign 1');
    expect(await stageOf(id)).toBe('defense');
    await first.kill();

    const second = spawnChild({});
    await until(async () => (await stageOf(id)) === 'verdict');
    expect(await stageOf(id), second.stderr()).toBe('verdict');
    await until(
      async () =>
        (
          await psql(
            `select count(*) from stage_runs where case_id='${id}' and completed_at is null and failed_at is null`,
          )
        )[0]?.[0] === '0',
      20_000,
    );

    expect(second.lines.filter((l) => /^STARTED (intake|map|arraign) /.test(l))).toEqual([]);
    expect(second.lines).toContain('STARTED defense 1');
    expect(
      (await psql(`select count(*) from stage_runs where case_id='${id}' and attempt > 1`))[0]?.[0],
    ).toBe('0');
    await expectNoDuplicateStage(id);
  });

  const open = async (id: string) =>
    (
      await psql(
        `select count(*) from stage_runs where case_id='${id}' and completed_at is null and failed_at is null`,
      )
    )[0]?.[0] === '0';

  it.each([
    // Defense has emitted its events but not moved the case: the retry must emit nothing twice.
    ['defense:1:after-events', 'defense'],
    // Defense has run the Judge but emitted nothing yet.
    ['defense:1:after-judge', 'defense'],
    // The verdict is written but its event is not: the retry must not trip the append-only verdict.
    ['jury:1:after-verdict', 'jury'],
  ])('SIGKILL at %s: the retry repeats no event and no stage', async (point, stage) => {
    const id = await newCase();
    const first = spawnChild({ CHILD_HANG_AT: point });
    await until(() => first.lines.some((l) => l.startsWith('HUNG')));
    expect(
      first.lines.some((l) => l.startsWith('HUNG')),
      first.stderr(),
    ).toBe(true);
    await first.kill();
    const second = spawnChild({});
    await until(async () => (await stageOf(id)) === 'verdict');
    expect(await stageOf(id), second.stderr()).toBe('verdict');
    await until(() => open(id), 20_000);
    expect(second.lines).toContain(`STARTED ${stage} 2`);
    await expectNoDuplicateStage(id, [stage]);
  });

  it('SIGKILL inside startCase (after open, before the first job): recovery enqueues intake once and the first event is not lost', async () => {
    const id = `case-e2e-${randomBytes(4).toString('hex')}`;
    const file = CaseFile.parse({ ...CaseFile.parse(samples.CaseFile), id, tenantId: TENANT });
    const crashed = spawnChild({ CHILD_START_CASE: JSON.stringify(file) });
    await until(() => crashed.lines.includes('HUNG startCase'));
    expect(crashed.lines, crashed.stderr()).toContain('HUNG startCase');
    await crashed.kill();
    expect(await stageOf(id)).toBe('intake');
    expect((await psql(`select count(*) from stage_jobs where case_id='${id}'`))[0]?.[0]).toBe('0');
    const second = spawnChild({});
    await until(async () => (await stageOf(id)) === 'verdict');
    expect(await stageOf(id), second.stderr()).toBe('verdict');
    await until(() => open(id), 20_000);
    await expectNoDuplicateStage(id);
  });

  it('a revisited stage runs under a new attempt number instead of failing to enqueue', async () => {
    const file = CaseFile.parse({
      ...CaseFile.parse(samples.CaseFile),
      id: `case-e2e-${randomBytes(4).toString('hex')}`,
      tenantId: TENANT,
    });
    const store = new PgCaseStore(appPool, TENANT);
    await store.open(file, { maxInputTokens: 1_000_000, maxOutputTokens: 200_000, maxUsd: 5 });
    for (const s of ['map', 'arraign', 'defense', 'prosecution', 'remedy'] as const) {
      await store.transition(file.id, s);
    }
    // The first visit to remedy was enqueued but never ran; then verify appealed back to remedy.
    await enqueueStage(appPool, { tenantId: TENANT, caseId: file.id, stage: 'remedy', attempt: 1 });
    await store.transition(file.id, 'verify');
    await store.transition(file.id, 'remedy');
    const w = await startWorker(config(), { log: () => undefined });
    running.push(w);
    await until(async () => (await stageOf(file.id)) === 'verdict');
    expect(await stageOf(file.id)).toBe('verdict');
    await until(() => open(file.id), 20_000);
    const runs = await psql(
      `select stage, attempt, (completed_at is not null) from stage_runs where case_id='${file.id}' and stage='remedy' order by attempt`,
    );
    // The stale attempt 1 never ran (the claim refuses it); the new visit ran as attempt 2.
    expect(runs).toEqual([['remedy', '2', 't']]);
  });
});
