import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LEASE_SCHEMA, WorkerLease, pidAlive, sweepOrphanedRuns, type SweepDeps } from './lease.js';

const run = (c: string) => c.repeat(16);
const A1 = run('a');
const A2 = run('b');
const B1 = run('c');
const STRAY = run('d');
const HOST = 'sandbox-1';

let dir = '';
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'affidavit-lease-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A Docker host with these labelled runs, and a set of live pids. */
function host(runs: string[], alive: number[]) {
  const present = new Set(runs);
  const removed: string[] = [];
  const warnings: string[] = [];
  const deps: SweepDeps = {
    listRuns: () => Promise.resolve([...present]),
    removeRun: (r) => {
      removed.push(r);
      present.delete(r);
      return Promise.resolve();
    },
    isAlive: (pid) => alive.includes(pid),
    warn: (m) => warnings.push(m),
  };
  return { deps, removed, warnings, present };
}

const acquire = (pid: number, hostname = HOST) =>
  WorkerLease.acquire(dir, { pid, hostname, heartbeatMs: 0 });

describe('WorkerLease', () => {
  it('records and forgets case network runs in its lease file, and deletes it on close', async () => {
    const lease = await acquire(101);
    await lease.addRun(A1);
    await lease.addRun(A2);
    await lease.removeRun(A1);
    expect(lease.runIds).toEqual([A2]);
    const files = readdirSync(dir);
    expect(files).toHaveLength(1);
    await lease.close();
    expect(readdirSync(dir)).toEqual([]);
  });

  it('refuses something that is not a run id', async () => {
    const lease = await acquire(101);
    await expect(lease.addRun('../../etc')).rejects.toThrow(/run id/);
    await lease.close();
  });
});

describe('sweepOrphanedRuns', () => {
  it('two workers: A is live and mid-case, B starts and sweeps; A keeps every resource', async () => {
    const a = await acquire(101);
    await a.addRun(A1);
    await a.addRun(A2);
    const b = await acquire(202);
    const h = host([A1, A2], [101, 202]);
    const out = await sweepOrphanedRuns(dir, b, h.deps);
    expect(h.removed).toEqual([]);
    expect(out.kept.sort()).toEqual([A1, A2]);
    expect([...h.present].sort()).toEqual([A1, A2]);
    await a.close();
    await b.close();
  });

  it('a dead owner on this host is swept and its lease file removed', async () => {
    const dead = await acquire(101);
    await dead.addRun(A1);
    const b = await acquire(202);
    const h = host([A1], [202]);
    const out = await sweepOrphanedRuns(dir, b, h.deps);
    expect(out.removed).toEqual([A1]);
    expect(h.present.size).toBe(0);
    expect(readdirSync(dir)).toEqual([`${b.ownerId}.json`]);
    await b.close();
  });

  it('never touches a labelled run no lease claims (ownership cannot be proven)', async () => {
    const b = await acquire(202);
    const h = host([STRAY], [202]);
    const out = await sweepOrphanedRuns(dir, b, h.deps);
    expect(h.removed).toEqual([]);
    expect(out.unknown).toEqual([STRAY]);
    expect(h.warnings.join('\n')).toMatch(/claimed by no lease/);
    await b.close();
  });

  it("never touches its own runs, another host's lease, or a live pid with a stale heartbeat", async () => {
    const self = await acquire(202);
    await self.addRun(B1);
    const other = await acquire(101, 'sandbox-2');
    await other.addRun(A1);
    let t = 0;
    const stale = await WorkerLease.acquire(dir, {
      pid: 303,
      hostname: HOST,
      heartbeatMs: 0,
      now: () => t,
    });
    await stale.addRun(A2);
    const h = host([A1, A2, B1], [202, 303]);
    t = 0;
    const out = await sweepOrphanedRuns(dir, self, { ...h.deps, now: () => 60 * 60_000 });
    expect(h.removed).toEqual([]);
    expect(out.kept.sort()).toEqual([A1, A2, B1]);
    expect(h.warnings.join('\n')).toMatch(/stale heartbeat but its pid exists/);
    for (const l of [self, other, stale]) await l.close();
  });

  it('keeps a dead owner lease whose removal failed, so the next sweep retries', async () => {
    const dead = await acquire(101);
    await dead.addRun(A1);
    const b = await acquire(202);
    const h = host([A1], [202]);
    const out = await sweepOrphanedRuns(dir, b, {
      ...h.deps,
      removeRun: () => Promise.reject(new Error('busy')),
    });
    expect(out.failed).toEqual([A1]);
    expect(readdirSync(dir)).toHaveLength(2);
    await b.close();
  });

  it('an unreadable lease file sweeps nothing it could hold', async () => {
    writeFileSync(join(dir, 'broken.json'), '{"schema":');
    writeFileSync(
      join(dir, 'forged.json'),
      JSON.stringify({
        schema: LEASE_SCHEMA,
        ownerId: 'x',
        hostname: HOST,
        pid: 1,
        startedAt: 0,
        heartbeatAt: 0,
        runIds: ['../x'],
      }),
    );
    const b = await acquire(202);
    const h = host([A1], [202]);
    const out = await sweepOrphanedRuns(dir, b, h.deps);
    expect(h.removed).toEqual([]);
    expect(out.unknown).toEqual([A1]);
    expect(h.warnings.join('\n')).toMatch(/unreadable/);
    await b.close();
  });
});

describe('pidAlive', () => {
  it('this process is alive', () => {
    expect(pidAlive(process.pid)).toBe(true);
  });
});
