import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  LEASE_SCHEMA,
  WorkerLease,
  pidAlive,
  startTimeOfStat,
  sweepOrphanedRuns,
  type ProcessIdentity,
  type SweepDeps,
} from './lease.js';

const run = (c: string) => c.repeat(16);
const A1 = run('a');
const A2 = run('b');
const B1 = run('c');
const STRAY = run('d');
const HOST = 'sandbox-1';
const NS: ProcessIdentity = { pidNs: 'pid:[4026531836]', bootId: 'boot-1' };
const MIN = 60_000;
/** Sweep time: an hour after every lease below last beat (at t = 0). */
const LATE = 60 * MIN;

let dir = '';
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'affidavit-lease-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A Docker host with these labelled runs, and live pids with their start times. */
function host(runs: string[], alive: Record<number, string>, at = LATE) {
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
    isAlive: (pid) => pid in alive,
    procStart: (pid) => Promise.resolve(alive[pid] ?? null),
    identity: NS,
    warn: (m) => warnings.push(m),
    now: () => at,
  };
  return { deps, removed, warnings, present };
}

/** A lease that last beat at t = 0; its recorded start time defaults to `<pid>00`. */
const acquire = (
  pid: number,
  o: { hostname?: string; identity?: ProcessIdentity; start?: string; heartbeatMs?: number } = {},
) =>
  WorkerLease.acquire(dir, {
    pid,
    hostname: o.hostname ?? HOST,
    identity: o.identity ?? NS,
    procStart: o.start ?? `${pid}00`,
    heartbeatMs: o.heartbeatMs ?? 0,
    now: () => 0,
  });

/** The sweeping worker: pid 202, alive with start time 20200. */
const sweeper = () => acquire(202);

describe('WorkerLease', () => {
  it('records and forgets case network runs in its lease file, and deletes it on close', async () => {
    const lease = await acquire(101);
    await lease.addRun(A1);
    await lease.addRun(A2);
    await lease.removeRun(A1);
    expect(lease.runIds).toEqual([A2]);
    expect(readdirSync(dir)).toHaveLength(1);
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
    const b = await sweeper();
    // A's heartbeat is fresh: the sweep runs a minute after it.
    const h = host([A1, A2], { 101: '10100', 202: '20200' }, MIN);
    const out = await sweepOrphanedRuns(dir, b, h.deps);
    expect(h.removed).toEqual([]);
    expect(out.kept.sort()).toEqual([A1, A2]);
    expect([...h.present].sort()).toEqual([A1, A2]);
    await a.close();
    await b.close();
  });

  it('a dead owner in this pid namespace and boot, with a stale heartbeat, is swept', async () => {
    const dead = await acquire(101);
    await dead.addRun(A1);
    const b = await sweeper();
    const h = host([A1], { 202: '20200' });
    const out = await sweepOrphanedRuns(dir, b, h.deps);
    expect(out.removed).toEqual([A1]);
    expect(h.present.size).toBe(0);
    expect(readdirSync(dir)).toEqual([`${b.ownerId}.json`]);
    await b.close();
  });

  it('same hostname, another pid namespace: never swept, even if the pid looks dead', async () => {
    const other = await acquire(1, { identity: { ...NS, pidNs: 'pid:[4026532999]' } });
    await other.addRun(A1);
    const b = await sweeper();
    const h = host([A1], { 202: '20200' });
    const out = await sweepOrphanedRuns(dir, b, h.deps);
    expect(h.removed).toEqual([]);
    expect(out.kept).toEqual([A1]);
    await other.close();
    await b.close();
  });

  it('another boot, or an unknown namespace or boot, is never swept', async () => {
    for (const identity of [
      { ...NS, bootId: 'boot-2' },
      { ...NS, pidNs: null },
      { ...NS, bootId: null },
    ]) {
      const other = await acquire(101, { identity });
      await other.addRun(A1);
      const b = await sweeper();
      const h = host([A1], { 202: '20200' });
      const out = await sweepOrphanedRuns(dir, b, h.deps);
      expect(h.removed).toEqual([]);
      expect(out.kept).toEqual([A1]);
      await other.close();
      await b.close();
    }
    // A sweeper that cannot read its own identity proves nobody dead.
    const dead = await acquire(101);
    await dead.addRun(A1);
    const b = await sweeper();
    const h = host([A1], { 202: '20200' });
    await sweepOrphanedRuns(dir, b, { ...h.deps, identity: { pidNs: null, bootId: null } });
    expect(h.removed).toEqual([]);
    await dead.close();
    await b.close();
  });

  it('a recycled pid (another start time) is dead only once the heartbeat is also stale', async () => {
    const old = await acquire(101, { start: '555' });
    await old.addRun(A1);
    const b = await sweeper();
    const fresh = host([A1], { 101: '999', 202: '20200' }, MIN);
    await sweepOrphanedRuns(dir, b, fresh.deps);
    expect(fresh.removed).toEqual([]);
    const stale = host([A1], { 101: '999', 202: '20200' });
    const out = await sweepOrphanedRuns(dir, b, stale.deps);
    expect(out.removed).toEqual([A1]);
    await b.close();
  });

  it('a live pid with its recorded start time and a stale heartbeat is kept, with a warning', async () => {
    const stuck = await acquire(303);
    await stuck.addRun(A2);
    const b = await sweeper();
    const h = host([A2], { 202: '20200', 303: '30300' });
    const out = await sweepOrphanedRuns(dir, b, h.deps);
    expect(h.removed).toEqual([]);
    expect(out.kept).toEqual([A2]);
    expect(h.warnings.join('\n')).toMatch(/stale heartbeat but its pid is still the owner/);
    await stuck.close();
    await b.close();
  });

  it('a dead pid whose heartbeat is within the generous multiple of its interval is kept', async () => {
    // 10 x 2 minutes = 20 minutes; the sweep runs 15 minutes after the last beat.
    const slow = await acquire(101, { heartbeatMs: 2 * MIN });
    await slow.addRun(A1);
    const b = await sweeper();
    const h = host([A1], { 202: '20200' }, 15 * MIN);
    const out = await sweepOrphanedRuns(dir, b, h.deps);
    expect(h.removed).toEqual([]);
    expect(out.kept).toEqual([A1]);
    await slow.close();
    await b.close();
  });

  it('never touches its own runs or another host lease', async () => {
    const self = await sweeper();
    await self.addRun(B1);
    const other = await acquire(101, { hostname: 'sandbox-2' });
    await other.addRun(A1);
    const h = host([A1, B1], { 202: '20200' });
    const out = await sweepOrphanedRuns(dir, self, h.deps);
    expect(h.removed).toEqual([]);
    expect(out.kept.sort()).toEqual([A1, B1]);
    await other.close();
    await self.close();
  });

  it('never touches a labelled run no lease claims, unless forced', async () => {
    const b = await sweeper();
    const h = host([STRAY], { 202: '20200' });
    const out = await sweepOrphanedRuns(dir, b, h.deps);
    expect(h.removed).toEqual([]);
    expect(out.unknown).toEqual([STRAY]);
    expect(h.warnings.join('\n')).toMatch(/claimed by no lease/);
    const forced = await sweepOrphanedRuns(dir, b, h.deps, { forceUnclaimed: true });
    expect(forced.removed).toEqual([STRAY]);
    await b.close();
  });

  it('keeps a dead owner lease whose removal failed, so the next sweep retries', async () => {
    const dead = await acquire(101);
    await dead.addRun(A1);
    const b = await sweeper();
    const h = host([A1], { 202: '20200' });
    const out = await sweepOrphanedRuns(dir, b, {
      ...h.deps,
      removeRun: () => Promise.reject(new Error('busy')),
    });
    expect(out.failed).toEqual([A1]);
    expect(readdirSync(dir)).toHaveLength(2);
    await b.close();
  });

  it('an unreadable, forged or future-schema lease file stops the whole sweep', async () => {
    const lease = (o: Record<string, unknown>) =>
      JSON.stringify({
        schema: LEASE_SCHEMA,
        ownerId: 'x',
        hostname: HOST,
        pid: 1,
        pidNs: NS.pidNs,
        bootId: NS.bootId,
        procStart: '1',
        startedAt: 0,
        heartbeatAt: 0,
        heartbeatMs: 0,
        runIds: [],
        ...o,
      });
    for (const body of [
      '{"schema":',
      lease({ runIds: ['../x'] }),
      lease({ schema: 'affidavit.worker-lease/v2' }),
    ]) {
      const dead = await acquire(101);
      await dead.addRun(A1);
      writeFileSync(join(dir, 'odd.json'), body);
      const b = await sweeper();
      const h = host([A1, STRAY], { 202: '20200' });
      const out = await sweepOrphanedRuns(dir, b, h.deps, { forceUnclaimed: true });
      expect(out.aborted).toBe(true);
      expect(h.removed).toEqual([]);
      expect(h.warnings.join('\n')).toMatch(/unreadable or of another schema: no run is swept/);
      rmSync(join(dir, 'odd.json'));
      await dead.close();
      await b.close();
    }
  });
});

describe('process identity', () => {
  it('this process is alive', () => {
    expect(pidAlive(process.pid)).toBe(true);
  });

  it('reads field 22 of /proc/<pid>/stat, with spaces and parentheses in comm', () => {
    const fields = Array.from({ length: 50 }, (_, i) => String(i + 3));
    fields[22 - 3] = '987654';
    expect(startTimeOfStat(`42 (node (worker) x) ${fields.join(' ')}`)).toBe('987654');
    expect(startTimeOfStat('garbage')).toBeNull();
  });
});
