import { randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, readlink, rename, rm, writeFile } from 'node:fs/promises';
import { hostname as osHostname } from 'node:os';
import { join } from 'node:path';

/**
 * Who owns which case networks on this host. Each worker process holds one lease file in a shared
 * lease directory, listing the run ids of the case networks it created and not yet removed, with
 * its host name, process identity (pid, pid namespace, boot id, process start time and a random
 * instance id, `ownerId`) and a heartbeat. The startup sweep (`sweepOrphanedRuns`) removes only
 * runs whose owner is proven dead, so a starting worker never removes a live worker's targets: a
 * safe target removed mid-case would make a witness fail on the safe variant, which reads as a
 * differential pass (false proof).
 */
export const LEASE_SCHEMA = 'affidavit.worker-lease/v1';

/** Where a process lives: a pid means something only within one pid namespace and one boot. */
export interface ProcessIdentity {
  /** `/proc/self/ns/pid` link target, for example `pid:[4026531836]`; null when unknown. */
  pidNs: string | null;
  /** `/proc/sys/kernel/random/boot_id`; null when unknown. */
  bootId: string | null;
}

export interface LeaseRecord {
  schema: typeof LEASE_SCHEMA;
  /** Random per-process instance id (also the file name). */
  ownerId: string;
  hostname: string;
  pid: number;
  pidNs: string | null;
  bootId: string | null;
  /** Field 22 of `/proc/<pid>/stat` (start time in clock ticks since boot); null when unknown. */
  procStart: string | null;
  startedAt: number;
  heartbeatAt: number;
  /** The heartbeat interval this owner promised (0: none). */
  heartbeatMs: number;
  runIds: string[];
}

/** What `CaseTargets` needs from a lease: record a case network when made, forget it when gone. */
export interface RunLedger {
  addRun(runId: string): Promise<void>;
  removeRun(runId: string): Promise<void>;
}

export interface LeaseHandle extends RunLedger {
  readonly ownerId: string;
  readonly hostname: string;
  close(): Promise<void>;
}

const RUN_ID = /^[0-9a-f]{16}$/;
const DEFAULT_HEARTBEAT_MS = 30_000;

async function readTrimmed(path: string): Promise<string | null> {
  try {
    const t = (await readFile(path, 'utf8')).trim();
    return t === '' ? null : t;
  } catch {
    return null;
  }
}

/** This process's pid namespace and boot id, from procfs (null fields off Linux). */
export async function procIdentity(): Promise<ProcessIdentity> {
  let pidNs: string | null;
  try {
    pidNs = await readlink('/proc/self/ns/pid');
  } catch {
    pidNs = null;
  }
  return { pidNs, bootId: await readTrimmed('/proc/sys/kernel/random/boot_id') };
}

/** Field 22 of `/proc/<pid>/stat` (start time), or null if the pid is gone or procfs is absent. */
export async function procStartTime(pid: number): Promise<string | null> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  const stat = await readTrimmed(`/proc/${pid}/stat`);
  return stat === null ? null : startTimeOfStat(stat);
}

/** Field 22 of a `/proc/<pid>/stat` line. comm (field 2) may hold spaces and `)`. */
export function startTimeOfStat(stat: string): string | null {
  const close = stat.lastIndexOf(')');
  if (close < 0) return null;
  const rest = stat.slice(close + 2).split(' ');
  const start = rest[22 - 3];
  return start !== undefined && /^\d+$/.test(start) ? start : null;
}

/** A worker's lease file. Writes are atomic (temp file, then rename) and serialized. */
export class WorkerLease implements LeaseHandle {
  readonly #file: string;
  readonly #record: LeaseRecord;
  readonly #now: () => number;
  #queue: Promise<void> = Promise.resolve();
  #timer: ReturnType<typeof setInterval> | undefined;
  #closed = false;

  private constructor(file: string, record: LeaseRecord, now: () => number) {
    this.#file = file;
    this.#record = record;
    this.#now = now;
  }

  get ownerId(): string {
    return this.#record.ownerId;
  }

  get hostname(): string {
    return this.#record.hostname;
  }

  get runIds(): readonly string[] {
    return [...this.#record.runIds];
  }

  /** Creates this process's lease file in `dir` (made 0700 if missing) and starts its heartbeat. */
  static async acquire(
    dir: string,
    opts: {
      hostname?: string;
      pid?: number;
      identity?: ProcessIdentity;
      procStart?: string | null;
      now?: () => number;
      heartbeatMs?: number;
    } = {},
  ): Promise<WorkerLease> {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const now = opts.now ?? Date.now;
    const started = now();
    const ownerId = `${started.toString(36)}-${randomBytes(8).toString('hex')}`;
    const pid = opts.pid ?? process.pid;
    const identity = opts.identity ?? (await procIdentity());
    const every = opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    const lease = new WorkerLease(
      join(dir, `${ownerId}.json`),
      {
        schema: LEASE_SCHEMA,
        ownerId,
        hostname: opts.hostname ?? osHostname(),
        pid,
        pidNs: identity.pidNs,
        bootId: identity.bootId,
        procStart: opts.procStart !== undefined ? opts.procStart : await procStartTime(pid),
        startedAt: started,
        heartbeatAt: started,
        heartbeatMs: every,
        runIds: [],
      },
      now,
    );
    await lease.#write();
    if (every > 0) {
      lease.#timer = setInterval(() => void lease.heartbeat().catch(() => undefined), every);
      lease.#timer.unref();
    }
    return lease;
  }

  addRun(runId: string): Promise<void> {
    if (!RUN_ID.test(runId)) return Promise.reject(new Error('not a case network run id'));
    if (!this.#record.runIds.includes(runId)) this.#record.runIds.push(runId);
    return this.#write();
  }

  removeRun(runId: string): Promise<void> {
    this.#record.runIds = this.#record.runIds.filter((r) => r !== runId);
    return this.#write();
  }

  heartbeat(): Promise<void> {
    return this.#write();
  }

  /** Stops the heartbeat and deletes the lease file. Call after every case network is removed. */
  async close(): Promise<void> {
    this.#closed = true;
    if (this.#timer !== undefined) clearInterval(this.#timer);
    await this.#queue;
    await rm(this.#file, { force: true });
  }

  #write(): Promise<void> {
    const next = this.#queue.then(async () => {
      if (this.#closed) return;
      this.#record.heartbeatAt = this.#now();
      const tmp = `${this.#file}.${randomBytes(4).toString('hex')}.tmp`;
      await writeFile(tmp, JSON.stringify(this.#record), { mode: 0o600 });
      await rename(tmp, this.#file);
    });
    this.#queue = next.catch(() => undefined);
    return next;
  }
}

const nullableString = (v: unknown): boolean => v === null || typeof v === 'string';

/** A lease of exactly this schema, or null (unreadable, unparsable, another or future schema). */
function parseLease(text: string): LeaseRecord | null {
  try {
    const o = JSON.parse(text) as Partial<LeaseRecord>;
    if (
      o.schema !== LEASE_SCHEMA ||
      typeof o.ownerId !== 'string' ||
      typeof o.hostname !== 'string' ||
      typeof o.pid !== 'number' ||
      !Number.isSafeInteger(o.pid) ||
      o.pid <= 0 ||
      !nullableString(o.pidNs) ||
      !nullableString(o.bootId) ||
      !nullableString(o.procStart) ||
      typeof o.startedAt !== 'number' ||
      typeof o.heartbeatAt !== 'number' ||
      typeof o.heartbeatMs !== 'number' ||
      !Number.isFinite(o.heartbeatMs) ||
      o.heartbeatMs < 0 ||
      !Array.isArray(o.runIds) ||
      !o.runIds.every((r) => typeof r === 'string' && RUN_ID.test(r))
    ) {
      return null;
    }
    return o as LeaseRecord;
  } catch {
    return null;
  }
}

/** True unless signalling `pid` reports it does not exist (EPERM means it exists). */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

export interface SweepDeps {
  /** Run ids of every labelled case network on this Docker host (`listCaseNetworkRuns`). */
  listRuns(): Promise<string[]>;
  /** Removes one run's case network and every container labelled with its run id. */
  removeRun(runId: string): Promise<void>;
  isAlive(pid: number): boolean;
  /** Start time of a live pid in the sweeper's namespace (`procStartTime`). */
  procStart(pid: number): Promise<string | null>;
  /** The sweeper's own pid namespace and boot id (`procIdentity`). */
  identity: ProcessIdentity;
  warn(message: string): void;
  now?: () => number;
}

export interface SweepOptions {
  /**
   * A heartbeat counts as stale only after `max(minStaleMs, staleFactor x the owner's interval)`
   * (defaults 10 minutes and 10). No owner is ever treated as dead before that.
   */
  minStaleMs?: number;
  staleFactor?: number;
  /**
   * Also remove labelled runs no lease claims (`AFFIDAVIT_SWEEP_ORPHANS=force`). Operator-only:
   * a live worker's network exists for a moment before its lease records it.
   */
  forceUnclaimed?: boolean;
}

export interface SweepOutcome {
  /** Runs of a proven-dead owner (or, with `forceUnclaimed`, of no owner), removed. */
  removed: string[];
  /** Runs of an owner that is (or may be) alive, left alone. */
  kept: string[];
  /** Labelled runs no lease claims, left alone (ownership cannot be proven). */
  unknown: string[];
  /** Runs whose removal failed; a dead owner's lease file is kept for the next sweep. */
  failed: string[];
  /** True when a lease could not be read, so nothing at all was swept. */
  aborted: boolean;
}

type Verdict = { dead: true } | { dead: false; why: string };

async function ownerVerdict(
  lease: LeaseRecord,
  owner: Pick<LeaseHandle, 'ownerId' | 'hostname'>,
  deps: SweepDeps,
  now: number,
  opts: Required<Pick<SweepOptions, 'minStaleMs' | 'staleFactor'>>,
): Promise<Verdict> {
  if (lease.ownerId === owner.ownerId) return { dead: false, why: 'this worker' };
  if (lease.hostname !== owner.hostname) return { dead: false, why: 'another host' };
  const { pidNs, bootId } = deps.identity;
  if (pidNs === null || lease.pidNs === null || lease.pidNs !== pidNs) {
    return { dead: false, why: 'another or unknown pid namespace' };
  }
  if (bootId === null || lease.bootId === null || lease.bootId !== bootId) {
    return { dead: false, why: 'another or unknown boot' };
  }
  const staleAfter = Math.max(opts.minStaleMs, opts.staleFactor * lease.heartbeatMs);
  if (now - lease.heartbeatAt <= staleAfter) return { dead: false, why: 'fresh heartbeat' };
  if (!deps.isAlive(lease.pid)) return { dead: true };
  // The pid exists: it is the owner unless it is a different process (recycled pid).
  const start = await deps.procStart(lease.pid);
  if (lease.procStart !== null && start !== null && start !== lease.procStart)
    return { dead: true };
  return {
    dead: false,
    why: 'stale heartbeat but its pid is still the owner or cannot be told apart',
  };
}

/**
 * Removes the case networks (and their containers) of workers proven dead. An owner is dead only
 * when its lease is on this host name, in this pid namespace and this boot, its heartbeat is
 * stale beyond a generous multiple of its interval, and its pid is gone or now belongs to a
 * process with another start time. Everything else is kept and reported. Any lease file that
 * cannot be read, parsed or is of another schema aborts the whole sweep: it may claim runs. Runs
 * no lease claims are left alone unless `forceUnclaimed`. A dead owner's lease file is deleted
 * once all its runs are gone.
 */
export async function sweepOrphanedRuns(
  dir: string,
  owner: Pick<LeaseHandle, 'ownerId' | 'hostname'>,
  deps: SweepDeps,
  opts: SweepOptions = {},
): Promise<SweepOutcome> {
  const now = (deps.now ?? Date.now)();
  const limits = {
    minStaleMs: opts.minStaleMs ?? 10 * 60_000,
    staleFactor: opts.staleFactor ?? 10,
  };
  const out: SweepOutcome = { removed: [], kept: [], unknown: [], failed: [], aborted: false };
  const abort = (why: string): SweepOutcome => {
    deps.warn(`${why}: no run is swept`);
    return { ...out, aborted: true };
  };
  let names: string[];
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith('.json')).sort();
  } catch {
    return abort('the lease directory cannot be read');
  }
  const leases: { file: string; lease: LeaseRecord }[] = [];
  for (const name of names) {
    const file = join(dir, name);
    let lease: LeaseRecord | null;
    try {
      lease = parseLease(await readFile(file, 'utf8'));
    } catch {
      lease = null;
    }
    if (lease === null) return abort(`lease file ${name} is unreadable or of another schema`);
    leases.push({ file, lease });
  }
  const onHost = new Set(await deps.listRuns());
  const claimed = new Set(leases.flatMap((l) => l.lease.runIds));
  const dead: typeof leases = [];
  for (const entry of leases) {
    const v = await ownerVerdict(entry.lease, owner, deps, now, limits);
    if (v.dead) {
      dead.push(entry);
      continue;
    }
    const held = entry.lease.runIds.filter((r) => onHost.has(r));
    out.kept.push(...held);
    if (held.length > 0 && v.why.startsWith('stale')) {
      deps.warn(`worker lease ${entry.lease.ownerId} has a ${v.why}: its runs are not swept`);
    }
  }
  for (const { file, lease } of dead) {
    let allGone = true;
    for (const r of lease.runIds) {
      if (!onHost.has(r)) continue;
      try {
        await deps.removeRun(r);
        out.removed.push(r);
      } catch {
        out.failed.push(r);
        allGone = false;
      }
    }
    if (allGone) await rm(file, { force: true });
  }
  const unclaimed = [...onHost].filter((r) => !claimed.has(r)).sort();
  if (opts.forceUnclaimed === true) {
    for (const r of unclaimed) {
      try {
        await deps.removeRun(r);
        out.removed.push(r);
      } catch {
        out.failed.push(r);
      }
    }
  } else {
    out.unknown = unclaimed;
    if (unclaimed.length > 0) {
      deps.warn(
        `${unclaimed.length} labelled case network(s) are claimed by no lease: ownership cannot be proven, so they are not swept`,
      );
    }
  }
  return out;
}
