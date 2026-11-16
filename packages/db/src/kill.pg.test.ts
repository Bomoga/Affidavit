import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, expect, it } from 'vitest';
import { PgCaseStore } from './case-store.js';
import {
  enqueueStage,
  listFailedStageJobs,
  stageJobKey,
  stageJobState,
  type StagePayload,
} from './queue.js';
import { completeStageRun, failStageRun, resumeDecision, stageRunState } from './stage-runs.js';
import { BUDGET, describePg, sampleCase, useTestDatabase } from './test-support.js';

const A = 'tenant-kill';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Real kills: the worker and its handler run in a child process with their own app and worker
 * pools (src/kill-child.ts, via tsx), the process is SIGKILLed, and the lease runs out on its own
 * because nothing heartbeats any more. This file has its own database so no other test's queued
 * jobs can occupy the child.
 */
describePg('kill and resume with a real process kill', () => {
  const db = useTestDatabase([A]);
  let storeA: PgCaseStore;
  const children: { kill(): Promise<void> }[] = [];

  // A failed assertion must not leave a worker running to steal the next test's job.
  afterEach(async () => {
    for (const c of children.splice(0)) await c.kill().catch(() => undefined);
  });

  const pools = () => ({ appPool: db().app, workerPool: db().worker });
  const pay = (caseId: string, attempt = 1) =>
    ({ tenantId: A, caseId, stage: 'intake', attempt }) as StagePayload;

  beforeAll(() => {
    storeA = new PgCaseStore(db().app, A);
  });

  async function newCase() {
    const file = sampleCase(A);
    await storeA.open(file, BUDGET);
    return file;
  }

  function spawnChild(mode: string, caseId: string, leaseSeconds: number) {
    const cwd = fileURLToPath(new URL('..', import.meta.url));
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/kill-child.ts'], {
      cwd,
      env: {
        // The child gets only its own role URLs, never the superuser one.
        ...Object.fromEntries(
          Object.entries(process.env).filter(([k]) => k !== 'AFFIDAVIT_TEST_DATABASE_URL'),
        ),
        CHILD_MODE: mode,
        CHILD_CASE: caseId,
        CHILD_TENANT: A,
        CHILD_LEASE: String(leaseSeconds),
        CHILD_APP_URL: db().appUrl,
        CHILD_WORKER_URL: db().workerUrl,
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
      // Only the child's own events; Graphile Worker's log lines are noise here.
      lines.push(
        ...parts.map((s) => s.trim()).filter((s) => /^(STARTED|DONE|WORKED|READY)( |$)/.test(s)),
      );
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

  async function until(cond: () => boolean | Promise<boolean>, ms = 30_000): Promise<void> {
    const deadline = Date.now() + ms;
    while (!(await cond()) && Date.now() < deadline) await wait(150);
  }

  it('SIGKILL mid-handler: the attempt is never re-run, the lease expires on its own, the next attempt runs', async () => {
    const file = await newCase();
    const p = pay(file.id);
    await enqueueStage(db().app, p);
    const c1 = spawnChild('hang', file.id, 3);
    await until(() => c1.lines.includes('STARTED 1'));
    expect(c1.lines, c1.stderr()).toContain('STARTED 1');
    // While the process lives it heartbeats, so a 3 second lease outlives several seconds.
    await wait(4500);
    expect(await resumeDecision(pools(), p)).toBe('wait');
    await c1.kill();
    // Restart a worker. It must not run attempt 1 again.
    const c2 = spawnChild('complete', file.id, 3);
    await until(async () => (await resumeDecision(pools(), p)) === 'next-attempt');
    expect(await resumeDecision(pools(), p)).toBe('next-attempt');
    expect(c2.lines.filter((l) => l.startsWith('STARTED'))).toEqual([]);
    expect(await enqueueStage(db().app, p)).toBe(false);
    // Abandon the dead attempt and move on with attempt 2.
    expect(await failStageRun(db().app, p, 'lease expired')).toBe(true);
    const next = pay(file.id, 2);
    expect(await enqueueStage(db().app, next)).toBe(true);
    await until(() => c2.lines.includes('DONE 2'));
    expect(c2.lines, c2.stderr()).toEqual(['READY', 'STARTED 2', 'DONE 2']);
    expect(c1.lines.filter((l) => l.startsWith('STARTED'))).toEqual(['STARTED 1']);
    expect(await stageRunState(db().app, next)).toBe('completed');
    // The handler completed but the case is still at intake: not the same as finished.
    expect(await resumeDecision(pools(), next)).toBe('completed-not-advanced');
    await c2.kill();
  }, 120_000);

  it('SIGKILL after the work committed: the case left the stage, so the attempt is adopted once the lease expires, never re-run', async () => {
    const file = await newCase();
    const p = pay(file.id);
    await enqueueStage(db().app, p);
    const c1 = spawnChild('work-then-hang', file.id, 6);
    await until(() => c1.lines.includes('WORKED'));
    expect(c1.lines, c1.stderr()).toContain('WORKED');
    await c1.kill();
    expect(await storeA.stage(file.id)).toBe('map');
    // Under the live lease the orchestrator waits and cannot adopt.
    expect(await resumeDecision(pools(), p)).toBe('wait');
    expect(await completeStageRun(db().app, p)).toBe(false);
    await until(async () => (await resumeDecision(pools(), p)) === 'adopt-complete');
    expect(await resumeDecision(pools(), p)).toBe('adopt-complete');
    expect(await completeStageRun(db().app, p)).toBe(true);
    expect(await resumeDecision(pools(), p)).toBe('done');
    expect(c1.lines.filter((l) => l.startsWith('STARTED'))).toEqual(['STARTED 1']);
  }, 120_000);

  it('SIGKILL BEFORE the claim: a stale-locked job is surfaced and resume moves to the next attempt', async () => {
    const file = await newCase();
    const p = pay(file.id);
    const stale = { staleLockSeconds: 3 };
    await enqueueStage(db().app, p);
    const c1 = spawnChild('hang-claim', file.id, 3);
    await until(async () => (await stageJobState(db().worker, p, 3)) === 'running');
    await c1.kill();
    expect(await stageRunState(db().app, p)).toBe('unclaimed');
    // Locked, attempt used up, no error, no claim: enqueueStage cannot help (a silent stall)...
    expect(await enqueueStage(db().app, p)).toBe(false);
    // ...until the lock is old enough to call dead.
    await until(async () => (await stageJobState(db().worker, p, 3)) === 'stale');
    expect(await stageJobState(db().worker, p, 3)).toBe('stale');
    const listed = await listFailedStageJobs(db().worker, 3);
    expect(listed.find((j) => j.key === stageJobKey(p))?.reason).toBe('stale-lock');
    expect(await resumeDecision(pools(), p, stale)).toBe('next-attempt');
    const c2 = spawnChild('complete', file.id, 3);
    expect(await enqueueStage(db().app, pay(file.id, 2))).toBe(true);
    await until(() => c2.lines.includes('DONE 2'));
    expect(c2.lines, c2.stderr()).toEqual(['READY', 'STARTED 2', 'DONE 2']);
    await c2.kill();
  }, 120_000);
});
