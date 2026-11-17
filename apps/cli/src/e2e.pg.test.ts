import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { CaseId, TrialEvent } from '@affidavit/contracts';
import {
  APP_ROLE,
  OWNER_ROLE,
  WORKER_ROLE,
  PgEventSink,
  applyMigrations,
  bootstrapRoles,
  openPool,
  provisionTenant,
  setRolePassword,
  type AppPool,
} from '@affidavit/db';
import { loadConfig, startWorker, type RunningWorker } from '@affidavit/worker';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { run } from './commands.js';
import { ExitCode } from './exit.js';
import { renderEvent } from './render.js';

/**
 * End to end: the real CLI against a real worker (all fakes) on a throwaway Postgres container
 * that THIS file starts and removes (image from the digest in docker/compose.yaml, random
 * localhost port, no volume). The admin password comes only from process env
 * (AFFIDAVIT_TEST_POSTGRES_PASSWORD) and is handed to Docker by variable name, never on a command
 * line or in a file. The role URLs are built in memory.
 */
const PASSWORD = process.env.AFFIDAVIT_TEST_POSTGRES_PASSWORD;
const SKIP =
  'SKIPPED: set AFFIDAVIT_TEST_POSTGRES_PASSWORD to a fresh random value (Docker is required) and run `pnpm --filter @affidavit/cli test:pg`.';
const describePg = PASSWORD
  ? describe
  : (name: string, fn: () => void) => {
      console.warn(`[@affidavit/cli test:pg] ${name}: ${SKIP}`);
      describe.skip(`${name} (${SKIP})`, fn);
    };

const exec = promisify(execFile);
const TENANT = 'tenant-cli-e2e';
const OTHER_TENANT = 'tenant-cli-e2e-other';
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => Promise<boolean>, ms = 30_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await cond()) && Date.now() < deadline) await wait(200);
}

function composeImage(): string {
  const file = fileURLToPath(new URL('../../../docker/compose.yaml', import.meta.url));
  const m = /image:\s*(postgres:16@sha256:[0-9a-f]{64})/.exec(readFileSync(file, 'utf8'));
  if (!m?.[1]) throw new Error('no pinned postgres image in docker/compose.yaml');
  return m[1];
}

/**
 * Known divergence between fixtures/trials/nodegoat-sqli-001.events.json and what the fake worker
 * emits (a question for the lead, not changed here): the fake has no cost-charged and no remedy
 * exhibit-submitted, adds a jury stage, writes the verdict at stage jury (seq 17), and every stage
 * transition event has actor stenographer.
 */
const FIXTURE_ONLY = [
  '6 stage-entered defense defense',
  '9 cost-charged defense defense',
  '10 stage-exited defense defense',
  '11 stage-entered prosecution prosecution',
  '12 stage-exited prosecution prosecution',
  '13 stage-entered remedy remedy',
  '14 exhibit-submitted remedy remedy',
  '15 stage-exited remedy remedy',
  '16 stage-entered verify judge',
  '17 stage-exited verify judge',
  '18 verdict-written verdict stenographer',
];
const FAKE_ONLY = [
  '6 stage-entered defense stenographer',
  '9 stage-exited defense stenographer',
  '10 stage-entered prosecution stenographer',
  '11 stage-exited prosecution stenographer',
  '12 stage-entered remedy stenographer',
  '13 stage-exited remedy stenographer',
  '14 stage-entered verify stenographer',
  '15 stage-exited verify stenographer',
  '16 stage-entered jury stenographer',
  '17 verdict-written jury stenographer',
];

const fixture = JSON.parse(
  readFileSync(
    new URL('../../../fixtures/trials/nodegoat-sqli-001.events.json', import.meta.url),
    'utf8',
  ),
) as { events?: unknown[] } | unknown[];
const fixtureEvents = (Array.isArray(fixture) ? fixture : (fixture.events ?? [])).map((e) =>
  TrialEvent.parse(e),
);

describePg('affidavit CLI against a worker with all fakes and real Postgres', () => {
  let container = '';
  let appUrl = '';
  let workerUrl = '';
  let appPool: AppPool;
  let worker: RunningWorker;
  let scannedCaseId = '';

  beforeAll(async () => {
    container = `affidavit-l1-11-${randomBytes(4).toString('hex')}`;
    await exec(
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
        await exec('docker', [
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
    const { stdout } = await exec('docker', ['port', container, '5432/tcp']);
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
    await provisionTenant(url(OWNER_ROLE, ownerPw), OTHER_TENANT);
    await setRolePassword(adminUrl, APP_ROLE, appPw);
    await setRolePassword(adminUrl, WORKER_ROLE, workerPw);
    appUrl = url(APP_ROLE, appPw);
    workerUrl = url(WORKER_ROLE, workerPw);
    appPool = await openPool(appUrl, APP_ROLE);
    worker = await startWorker(
      loadConfig({
        AFFIDAVIT_APP_DATABASE_URL: appUrl,
        AFFIDAVIT_WORKER_DATABASE_URL: workerUrl,
        AFFIDAVIT_POLL_INTERVAL_MS: '100',
        AFFIDAVIT_CONCURRENCY: '2',
      }),
      { log: () => undefined },
    );
  }, 180_000);

  afterAll(async () => {
    await worker?.stop().catch(() => undefined);
    await appPool?.end().catch(() => undefined);
    // Only the container this file created.
    if (container) await exec('docker', ['rm', '-f', container]).catch(() => undefined);
  }, 60_000);

  const env = () => ({
    AFFIDAVIT_APP_DATABASE_URL: appUrl,
    AFFIDAVIT_TENANT_ID: TENANT,
    AFFIDAVIT_INTAKE_IMPL: 'fake',
  });

  function capture() {
    const out: string[] = [];
    const err: string[] = [];
    return {
      out,
      err,
      deps: { env: env(), out: (l: string) => out.push(l), err: (l: string) => err.push(l) },
    };
  }

  it('scan prints the case event stream end to end and exits 0; status then reads it back', async () => {
    const c = capture();
    const code = await run(
      ['scan', 'repo-nodegoat', '--poll-ms', '100', '--timeout', '90'],
      c.deps,
    );
    expect(c.err, c.err.join('\n')).toEqual([]);
    expect(code).toBe(ExitCode.OK);
    const idLine = c.out.find((l) => l.startsWith('case '));
    const caseId = /^case (\S+) enqueued/.exec(idLine ?? '')?.[1];
    expect(caseId).toMatch(/^case-cli-/);
    scannedCaseId = caseId ?? '';

    // What the fake worker emitted for this case, straight from the store. The CLI stops at the
    // first terminal event, so it prints the stream up to and including verdict-written; the fake
    // worker still has its last stage-exited and stage-entered events to write after that.
    const sink = new PgEventSink(appPool, TENANT);
    const stored = await sink.events(CaseId.parse(caseId), -1);
    const end = stored.findIndex((e) => e.type === 'verdict-written');
    expect(end).toBeGreaterThan(0);
    const printed = c.out.filter((l) => l.startsWith('#'));
    expect(printed).toEqual(stored.slice(0, end + 1).map((e) => renderEvent(e)));
    expect(stored.map((e) => e.seq)).toEqual(stored.map((_, i) => i));
    // Seq, type, stage and actor of every event the CLI printed. This is what the fake worker
    // emits; it differs from fixtures/trials/nodegoat-sqli-001.events.json (see the L1-11 PR):
    // no cost-charged, no remedy exhibit-submitted, a jury stage, and verdict-written at the
    // jury stage (seq 17) instead of the verdict stage (seq 18).
    const T = 'stenographer';
    expect(stored.slice(0, end + 1).map((e) => [e.seq, e.type, e.stage, e.actor])).toEqual([
      [0, 'stage-entered', 'intake', T],
      [1, 'stage-exited', 'intake', T],
      [2, 'stage-entered', 'map', T],
      [3, 'stage-exited', 'map', T],
      [4, 'stage-entered', 'arraign', T],
      [5, 'stage-exited', 'arraign', T],
      [6, 'stage-entered', 'defense', T],
      [7, 'exhibit-submitted', 'defense', 'defense'],
      [8, 'exhibit-result', 'defense', 'judge'],
      [9, 'stage-exited', 'defense', T],
      [10, 'stage-entered', 'prosecution', T],
      [11, 'stage-exited', 'prosecution', T],
      [12, 'stage-entered', 'remedy', T],
      [13, 'stage-exited', 'remedy', T],
      [14, 'stage-entered', 'verify', T],
      [15, 'stage-exited', 'verify', T],
      [16, 'stage-entered', 'jury', T],
      [17, 'verdict-written', 'jury', T],
    ]);
    // The exact divergence from the recorded fixture, pinned so any drift fails loudly.
    const key = (e: { seq: number; type: string; stage: string; actor: string }) =>
      `${e.seq} ${e.type} ${e.stage} ${e.actor}`;
    const fake = stored.slice(0, end + 1).map(key);
    const fix = fixtureEvents.map(key);
    expect(fix.filter((k) => !fake.includes(k))).toEqual(FIXTURE_ONLY);
    expect(fake.filter((k) => !fix.includes(k))).toEqual(FAKE_ONLY);
    const verdict = stored[end];
    expect(verdict?.type === 'verdict-written' && verdict.payload.verdict.summary).toContain(
      '[fake]',
    );
    expect(fixtureEvents.at(-1)?.type).toBe('verdict-written');
    // The worker finishes its last transition just after the verdict event.
    await until(async () => {
      const t = capture();
      await run(['status', caseId ?? ''], t.deps);
      return t.out.includes('stage verdict');
    });

    const s = capture();
    expect(await run(['status', caseId ?? '', '--tail', '4'], s.deps)).toBe(ExitCode.OK);
    const text = s.out.join('\n');
    expect(text).toContain('stage verdict');
    expect(text).toContain('state finished (verdict-written)');
    expect(s.out.filter((l) => l.startsWith('  #'))).toHaveLength(4);
  });

  it('status of an unknown case is exit 6, and another tenant cannot see a case', async () => {
    const c = capture();
    expect(await run(['status', 'case-does-not-exist'], c.deps)).toBe(ExitCode.NOT_FOUND);
    expect(c.err.join('\n')).not.toContain(appUrl);
  });

  it('another provisioned tenant cannot read a scanned case: exit 6 and no event lines', async () => {
    expect(scannedCaseId).toMatch(/^case-cli-/);
    const own = capture();
    expect(await run(['status', scannedCaseId], own.deps)).toBe(ExitCode.OK);
    const other = capture();
    other.deps.env = { ...env(), AFFIDAVIT_TENANT_ID: OTHER_TENANT };
    expect(await run(['status', scannedCaseId], other.deps)).toBe(ExitCode.NOT_FOUND);
    expect([...other.out, ...other.err].some((l) => l.includes('#0'))).toBe(false);
    expect(other.out).toEqual([]);
  });

  it('the process entry point works: scan exits 0 with plain output and no URL', async () => {
    const cwd = fileURLToPath(new URL('..', import.meta.url));
    const childEnv = Object.fromEntries(
      Object.entries(process.env).filter(([k]) => k !== 'AFFIDAVIT_TEST_POSTGRES_PASSWORD'),
    );
    const { stdout, stderr } = await exec(
      process.execPath,
      ['--import', 'tsx', 'src/main.ts', 'scan', 'repo-nodegoat', '--poll-ms', '100'],
      { cwd, env: { ...childEnv, ...env() } },
    );
    expect(stdout).toContain('verdict-written');
    // eslint-disable-next-line no-control-regex
    expect(/[\u001b]/.test(stdout + stderr)).toBe(false);
    expect(stdout + stderr).not.toContain('postgres://');
  });
});
