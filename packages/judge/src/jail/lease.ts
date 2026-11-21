import { randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { hostname as osHostname } from 'node:os';
import { join } from 'node:path';

/**
 * Who owns which case networks on this host. Each worker process holds one lease file in a shared
 * lease directory, listing the run ids of the case networks it created and not yet removed, with
 * its host name, pid and a heartbeat. The startup sweep (`sweepOrphanedRuns`) removes only runs
 * whose owner is proven dead, so a starting worker never removes a live worker's targets: a safe
 * target removed mid-case would make a witness fail on the safe variant, which reads as a
 * differential pass (false proof).
 */
export const LEASE_SCHEMA = 'affidavit.worker-lease/v1';

export interface LeaseRecord {
  schema: typeof LEASE_SCHEMA;
  ownerId: string;
  hostname: string;
  pid: number;
  startedAt: number;
  heartbeatAt: number;
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
    opts: { hostname?: string; pid?: number; now?: () => number; heartbeatMs?: number } = {},
  ): Promise<WorkerLease> {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const now = opts.now ?? Date.now;
    const started = now();
    const ownerId = `${started.toString(36)}-${randomBytes(8).toString('hex')}`;
    const lease = new WorkerLease(
      join(dir, `${ownerId}.json`),
      {
        schema: LEASE_SCHEMA,
        ownerId,
        hostname: opts.hostname ?? osHostname(),
        pid: opts.pid ?? process.pid,
        startedAt: started,
        heartbeatAt: started,
        runIds: [],
      },
      now,
    );
    await lease.#write();
    const every = opts.heartbeatMs ?? 30_000;
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
      typeof o.startedAt !== 'number' ||
      typeof o.heartbeatAt !== 'number' ||
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
  warn(message: string): void;
  now?: () => number;
}

export interface SweepOutcome {
  /** Runs of a dead owner, removed. */
  removed: string[];
  /** Runs of an owner that is (or may be) alive, left alone. */
  kept: string[];
  /** Labelled runs no lease claims: ownership cannot be proven, so left alone. */
  unknown: string[];
  /** Runs of a dead owner whose removal failed; its lease file is kept for the next sweep. */
  failed: string[];
}

/**
 * Removes the case networks (and their containers) of workers that are proven dead: a lease on
 * this host name whose pid no longer exists. Everything else is left alone and reported: a live
 * owner's runs (even with a stale heartbeat: a pid that still exists may be a stalled worker, and
 * removing its safe target could make a witness read as differential proof), another host's
 * leases, unreadable lease files, and labelled runs no lease claims. Fail safe: when ownership
 * cannot be proven, nothing is removed. A dead owner's lease file is deleted once all its runs
 * are gone.
 */
export async function sweepOrphanedRuns(
  dir: string,
  owner: Pick<LeaseHandle, 'ownerId' | 'hostname'>,
  deps: SweepDeps,
  opts: { staleMs?: number } = {},
): Promise<SweepOutcome> {
  const now = deps.now ?? Date.now;
  const staleMs = opts.staleMs ?? 10 * 60_000;
  const out: SweepOutcome = { removed: [], kept: [], unknown: [], failed: [] };
  const onHost = new Set(await deps.listRuns());
  const claimed = new Set<string>();
  let names: string[];
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith('.json')).sort();
  } catch {
    deps.warn('the lease directory cannot be read: no run is swept');
    names = [];
  }
  const dead: { file: string; lease: LeaseRecord }[] = [];
  for (const name of names) {
    const file = join(dir, name);
    let lease: LeaseRecord | null;
    try {
      lease = parseLease(await readFile(file, 'utf8'));
    } catch {
      lease = null;
    }
    if (lease === null) {
      deps.warn(`lease file ${name} is unreadable: the runs it may hold are not swept`);
      continue;
    }
    for (const r of lease.runIds) claimed.add(r);
    if (lease.ownerId === owner.ownerId) {
      out.kept.push(...lease.runIds.filter((r) => onHost.has(r)));
      continue;
    }
    if (lease.hostname !== owner.hostname) {
      out.kept.push(...lease.runIds.filter((r) => onHost.has(r)));
      continue;
    }
    if (deps.isAlive(lease.pid)) {
      if (now() - lease.heartbeatAt > staleMs) {
        deps.warn(
          `worker lease ${lease.ownerId} has a stale heartbeat but its pid exists: its runs are not swept`,
        );
      }
      out.kept.push(...lease.runIds.filter((r) => onHost.has(r)));
      continue;
    }
    dead.push({ file, lease });
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
  out.unknown = [...onHost].filter((r) => !claimed.has(r)).sort();
  if (out.unknown.length > 0) {
    deps.warn(
      `${out.unknown.length} labelled case network(s) are claimed by no lease: ownership cannot be proven, so they are not swept`,
    );
  }
  return out;
}
