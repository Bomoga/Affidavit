import {
  TERMINAL_STAGES,
  TrialEvent,
  type Budget,
  type CaseFile,
  type CaseFileSource,
  type CaseId,
  type CaseStage,
  type CaseStore,
  type EventSink,
  type Role,
  type StageCost,
} from '@affidavit/contracts';
import { sql } from 'drizzle-orm';
import { PgCaseStore } from './case-store.js';
import { PgEventSink } from './event-sink.js';
import {
  enqueueStage,
  leaseLost,
  listFailedStageJobs,
  MAX_FAILED_JOBS_PER_PAGE,
  parseStagePayload,
  type StageHandler,
  type StagePayload,
} from './queue.js';
import { completeStageRun, failStageRun, resumeDecision } from './stage-runs.js';
import {
  PgCaseFileSource,
  flagForReview,
  isFlaggedForReview,
  listOpenCases,
  REVIEW_REASONS,
  stageAttemptState,
  type OpenCaseCursor,
  type ReviewReason,
} from './stage-attempts.js';
import { withTenant, type AppPool, type WorkerPool } from './tenant.js';

/*
 * The stage orchestration: how a stage job is run (work, transition, next job, completion last),
 * and how a dead or lost one is recovered. apps/worker only wires configuration and the stage
 * work (real or fake) into it. See "Orchestration" in CLAUDE.md.
 */

// ---------------------------------------------------------------------------------------------
// Lease guard

/** Port writes are not fenced by the lease, so a handler whose lease is gone must not write. */
export class LeaseLostError extends Error {
  constructor() {
    super('lease lost: refusing a port write after the stage signal aborted');
    this.name = 'LeaseLostError';
  }
}

/** Refuses once the signal aborted or the lease's confirmed expiry has passed by the clock. */
function check(signal: AbortSignal): void {
  if (leaseLost(signal)) throw new LeaseLostError();
}

/** A CaseStore whose writes are refused once the job's signal aborted. Reads pass through. */
export class GuardedCaseStore implements CaseStore {
  /**
   * v1.2 (CR-T1). Present only when the inner store has it, so a store that cannot release still
   * reads as one that cannot (the charge stands). Lease-guarded like `chargeBudget`.
   */
  readonly releaseCharge?: CaseStore['releaseCharge'];

  constructor(
    private readonly inner: CaseStore,
    private readonly signal: AbortSignal,
  ) {
    const release = inner.releaseCharge?.bind(inner);
    if (release) {
      this.releaseCharge = (caseId, refund, reservationSeq) => {
        check(this.signal);
        return release(caseId, refund, reservationSeq);
      };
    }
  }
  open(caseFile: CaseFile, budget: Budget) {
    check(this.signal);
    return this.inner.open(caseFile, budget);
  }
  stage(caseId: CaseId) {
    return this.inner.stage(caseId);
  }
  transition(caseId: CaseId, to: CaseStage) {
    check(this.signal);
    return this.inner.transition(caseId, to);
  }
  chargeBudget(caseId: CaseId, cost: StageCost) {
    check(this.signal);
    return this.inner.chargeBudget(caseId, cost);
  }
  nextSeq(caseId: CaseId) {
    check(this.signal);
    return this.inner.nextSeq(caseId);
  }
  appendVerdict(verdict: Parameters<CaseStore['appendVerdict']>[0]) {
    check(this.signal);
    return this.inner.appendVerdict(verdict);
  }
  getVerdict(caseId: CaseId) {
    return this.inner.getVerdict(caseId);
  }
}

export class GuardedEventSink implements EventSink {
  constructor(
    private readonly inner: EventSink,
    private readonly signal: AbortSignal,
  ) {}
  emit(event: TrialEvent) {
    check(this.signal);
    return this.inner.emit(event);
  }
}

// ---------------------------------------------------------------------------------------------
// Stage work

/** What a stage core gets: ports scoped to the job's tenant and guarded by its lease. */
export interface StageEnv {
  job: StagePayload;
  store: CaseStore;
  sink: EventSink;
  caseFiles: CaseFileSource;
  signal: AbortSignal;
  /**
   * Events already recorded for a case during its CURRENT stage visit (seq at or after the visit's
   * entry), for idempotent emission: an event of an earlier visit does not count.
   */
  events(caseId: CaseId): Promise<TrialEvent[]>;
  /** A named point inside the work; a no-op unless a test hook is installed. */
  checkpoint(name: string): Promise<void>;
}

/** Stage work only: do it, then move the case with `store.transition`. The wrapper does the rest. */
export type StageCore = (env: StageEnv) => Promise<void>;

/** Test seams. Only kill/resume tests install them. */
export interface StageHooks {
  beforeStageWork?: (job: StagePayload) => Promise<void>;
  /** After the work and the case transition, before the next stage job is enqueued. */
  afterStageWork?: (job: StagePayload) => Promise<void>;
  checkpoint?: (job: StagePayload, name: string) => Promise<void>;
}

type EventBody = {
  [K in TrialEvent['type']]: { type: K; payload: Extract<TrialEvent, { type: K }>['payload'] };
}[TrialEvent['type']];

/** Appends one schema-valid event. The sequence number comes from the store. */
export async function record(
  env: Pick<StageEnv, 'store' | 'sink'>,
  caseId: CaseId,
  stage: CaseStage,
  actor: Role,
  body: EventBody,
): Promise<void> {
  const seq = await env.store.nextSeq(caseId);
  await env.sink.emit(
    TrialEvent.parse({
      schemaVersion: 1,
      caseId,
      seq,
      stage,
      at: new Date().toISOString(),
      actor,
      ...body,
    }),
  );
}

/**
 * `record`, unless an event of the same type, stage and payload is already stored for the current
 * visit (`env.events` only returns events at or after the visit's entry seq, so a revisit of a
 * stage emits its events again). Stage work that emits events BEFORE its transition uses this, so
 * a retry after a kill emits nothing twice and a kill after the transition has nothing left to emit.
 */
export async function recordOnce(
  env: Pick<StageEnv, 'store' | 'sink' | 'events'>,
  caseId: CaseId,
  stage: CaseStage,
  actor: Role,
  body: EventBody,
): Promise<boolean> {
  const payload = JSON.stringify(body.payload);
  const seen = await env.events(caseId);
  if (
    seen.some(
      (e) => e.type === body.type && e.stage === stage && JSON.stringify(e.payload) === payload,
    )
  ) {
    return false;
  }
  await record(env, caseId, stage, actor, body);
  return true;
}

/** A core returned but the case is still at the stage: the attempt did not do its job. */
export class StageDidNotAdvanceError extends Error {
  constructor(readonly stage: CaseStage) {
    super(`stage ${stage} finished its work without moving the case`);
    this.name = 'StageDidNotAdvanceError';
  }
}

/**
 * Stage work that a retry cannot help (for example a model safety refusal: a retry asks the same
 * model again). `stageHandler` flags this attempt's visit for review at once, so recovery neither
 * retries it nor sweeps it; the case stays where it is and is never dismissed. Any error with a
 * valid `reviewReason` property is treated the same way (`reviewReasonOf`).
 */
export class NeedsReviewError extends Error {
  constructor(
    readonly reviewReason: ReviewReason,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'NeedsReviewError';
  }
}

/** The review reason an error from stage work carries, or undefined for an ordinary failure. */
export function reviewReasonOf(err: unknown): ReviewReason | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const r = (err as { reviewReason?: unknown }).reviewReason;
  return REVIEW_REASONS.find((x) => x === r);
}

/**
 * Makes sure the case's current stage has a job for the current visit, enqueuing the next unused
 * attempt number if there is none. Safe to call from several processes: enqueueing is idempotent
 * on the attempt key. Returns the payload it enqueued, or null if a job already exists, the case
 * is terminal, or it was flagged for review.
 */
export async function ensureStageJob(
  appPool: AppPool,
  tenantId: string,
  caseId: string,
): Promise<StagePayload | null> {
  const s = await stageAttemptState(appPool, tenantId, caseId);
  if (TERMINAL_STAGES.includes(s.stage) || s.latestAttempt !== null) return null;
  if (await isFlaggedForReview(appPool, tenantId, caseId, s.stage, s.visit)) return null;
  const p = parseStagePayload({ tenantId, caseId, stage: s.stage, attempt: s.nextAttempt });
  return (await enqueueStage(appPool, p)) ? p : null;
}

/** A case's events from the entry of its current stage visit on (a read). */
export async function visitEvents(
  appPool: AppPool,
  sink: PgEventSink,
  tenantId: string,
  caseId: string,
): Promise<TrialEvent[]> {
  const s = await stageAttemptState(appPool, tenantId, caseId);
  return sink.events(caseId as CaseId, s.entrySeq - 1);
}

export interface StageHandlerOptions {
  appPool: AppPool;
  juryEnabled?: boolean;
  hooks?: StageHooks;
}

/**
 * Turns stage work into a queue handler, in the order this package requires: the work and its
 * case transition, then the next stage's job, then `ctx.complete(tx)` last. A core that does not
 * move the case fails the attempt. Every port write is guarded by the lease signal. A kill or
 * failure anywhere in between leaves the case at its new stage with no job; `reconcileOnce`
 * finds such a case and enqueues the stage it is at.
 */
export function stageHandler(core: StageCore, options: StageHandlerOptions): StageHandler {
  const { appPool, hooks } = options;
  return async (job, ctx) => {
    const pgStore = new PgCaseStore(appPool, job.tenantId, { juryEnabled: options.juryEnabled });
    const pgSink = new PgEventSink(appPool, job.tenantId);
    const store = new GuardedCaseStore(pgStore, ctx.signal);
    await hooks?.beforeStageWork?.(job);
    try {
      await core({
        job,
        store,
        sink: new GuardedEventSink(pgSink, ctx.signal),
        caseFiles: new PgCaseFileSource(appPool, job.tenantId),
        signal: ctx.signal,
        events: (caseId) => visitEvents(appPool, pgSink, job.tenantId, caseId),
        checkpoint: async (name) => {
          check(ctx.signal);
          await hooks?.checkpoint?.(job, name);
        },
      });
    } catch (err) {
      const reason = reviewReasonOf(err);
      if (reason !== undefined) {
        // Not retryable: flag this attempt's visit now (only while it is still the case's current
        // stage and latest attempt), then fail the attempt as usual.
        const s = await stageAttemptState(appPool, job.tenantId, job.caseId);
        if (s.stage === job.stage && s.latestAttempt === job.attempt) {
          const detail = err instanceof Error ? err.message : String(reason);
          await flagForReview(appPool, { ...job, visit: s.visit }, reason, detail);
        }
      }
      throw err;
    }
    await hooks?.afterStageWork?.(job);
    const now = await store.stage(job.caseId);
    if (now === job.stage) throw new StageDidNotAdvanceError(job.stage);
    check(ctx.signal);
    await ensureStageJob(appPool, job.tenantId, job.caseId);
    check(ctx.signal);
    await ctx.inTenantTx((tx) => ctx.complete(tx));
  };
}

// ---------------------------------------------------------------------------------------------
// Recovery

export interface ReconcileOptions {
  appPool: AppPool;
  workerPool: WorkerPool;
  staleLockSeconds: number;
  /** Total attempts of one stage, the first included. Beyond it a person has to look. */
  maxStageAttempts: number;
  juryEnabled?: boolean;
  /** Most open cases (and most failed jobs) examined per pass. */
  sweepLimit?: number;
  /**
   * Where the previous pass stopped, so the next one continues after it instead of starting at
   * the oldest again. Default: kept per worker pool for the life of the process.
   */
  cursors?: ReconcileCursors;
  log?: (message: string) => void;
}

export type ReconcileAction =
  | { kind: 'retried'; payload: StagePayload; nextAttempt: number }
  | { kind: 'adopted'; payload: StagePayload }
  | { kind: 'enqueued'; payload: StagePayload }
  /** Durable (review_flags). The case stays where it is; it is never dismissed. */
  | { kind: 'needs-review'; payload: StagePayload; reason: ReviewReason; why: string };

/** Keyset positions of the two scans. A scan that returns a short page starts over next pass. */
export interface ReconcileCursors {
  failedAfterId: string | null;
  openAfter: OpenCaseCursor | null;
}

const defaultCursors = new WeakMap<WorkerPool, ReconcileCursors>();

function cursorsFor(o: ReconcileOptions): ReconcileCursors {
  if (o.cursors) return o.cursors;
  let c = defaultCursors.get(o.workerPool);
  if (!c) {
    c = { failedAfterId: null, openAfter: null };
    defaultCursors.set(o.workerPool, c);
  }
  return c;
}

function parseKey(key: string): StagePayload | null {
  try {
    const parts: unknown = JSON.parse(key);
    if (!Array.isArray(parts) || parts.length !== 4) return null;
    const [tenantId, caseId, stage, attempt] = parts as unknown[];
    return parseStagePayload({ tenantId, caseId, stage, attempt });
  } catch {
    return null;
  }
}

/**
 * One recovery pass. (1) Queue jobs that will never run again (failed, or locked by a dead
 * worker) get `resumeDecision`: abandon and retry as the next unused attempt, or adopt an attempt
 * whose case already moved on. (2) Every open case is swept: one whose current stage has no job
 * (a handler failed after its transition, a kill before the next enqueue, a case opened but
 * never enqueued) gets one; one whose attempt completed without advancing is retried.
 * Safe from several workers at once; enqueueing is idempotent on the attempt key.
 */
export async function reconcileOnce(o: ReconcileOptions): Promise<ReconcileAction[]> {
  const actions: ReconcileAction[] = [];
  const guard = async (what: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (err) {
      o.log?.(
        `reconcile failed for ${what}: ${err instanceof Error ? err.message : 'unknown error'}`,
      );
    }
  };
  const limit = o.sweepLimit ?? 500;
  const cursors = cursorsFor(o);
  const failed = await listFailedStageJobs(o.workerPool, o.staleLockSeconds, {
    limit,
    afterId: cursors.failedAfterId,
  });
  const lastFailed = failed[failed.length - 1];
  cursors.failedAfterId =
    lastFailed && failed.length >= Math.min(limit, MAX_FAILED_JOBS_PER_PAGE) ? lastFailed.id : null;
  for (const job of failed) {
    const p = parseKey(job.key);
    if (!p) {
      o.log?.('ignoring a queue job with an unreadable key');
      continue;
    }
    await guard(job.key, () => reconcileAttempt(o, p, actions));
  }
  const open = await listOpenCases(o.workerPool, limit, {
    after: cursors.openAfter,
    staleLockSeconds: o.staleLockSeconds,
  });
  const lastOpen = open[open.length - 1];
  cursors.openAfter =
    lastOpen && open.length >= Math.min(limit, 1000)
      ? { tenantId: lastOpen.tenantId, caseId: lastOpen.caseId }
      : null;
  for (const c of open) {
    await guard(`case ${c.caseId}`, () => reconcileCase(o, c.tenantId, c.caseId, actions));
  }
  return actions;
}

async function reconcileCase(
  o: ReconcileOptions,
  tenantId: string,
  caseId: string,
  actions: ReconcileAction[],
): Promise<void> {
  const s = await stageAttemptState(o.appPool, tenantId, caseId);
  if (TERMINAL_STAGES.includes(s.stage)) return;
  if (s.latestAttempt === null) {
    const p = await ensureStageJob(o.appPool, tenantId, caseId);
    if (p) actions.push({ kind: 'enqueued', payload: p });
    return;
  }
  await reconcileAttempt(
    o,
    parseStagePayload({ tenantId, caseId, stage: s.stage, attempt: s.latestAttempt }),
    actions,
  );
}

async function reconcileAttempt(
  o: ReconcileOptions,
  p: StagePayload,
  actions: ReconcileAction[],
): Promise<void> {
  const pools = { appPool: o.appPool, workerPool: o.workerPool };
  const action = await resumeDecision(pools, p, { staleLockSeconds: o.staleLockSeconds });
  if (action === 'adopt-complete') {
    if (await completeStageRun(o.appPool, p)) actions.push({ kind: 'adopted', payload: p });
    await reconcileCase(o, p.tenantId, p.caseId, actions);
    return;
  }
  if (action === 'start') {
    if (await enqueueStage(o.appPool, p)) actions.push({ kind: 'enqueued', payload: p });
    return;
  }
  if (action === 'next-attempt' || action === 'completed-not-advanced') {
    await retry(o, p, actions);
  }
}

/**
 * Runs `fn` while holding a Postgres advisory lock for this case and stage (its own key space, not
 * the one enqueue_stage and claim_stage_run use, which would deadlock with the enqueue inside
 * `fn`). Concurrent reconcilers queue up here; each re-reads the state under the lock, so only the
 * first one retries, charges and enqueues.
 *
 * Pool requirement: this holds one app-pool connection, idle in a transaction, for as long as `fn`
 * runs, and `fn` takes further connections from the SAME pool (each store and queue call checks
 * one out). With R reconcilers at once the pool needs more than R connections, or all of them can
 * be held by lock holders waiting for another one and nothing proceeds. `reconcileOnce` handles
 * one case at a time and the worker runs one pass at a time, so reconcile alone needs 2; handlers
 * on the same pool need theirs on top (concurrency plus heartbeats). Passing the held client into
 * `fn` would remove the requirement but means threading a transaction through every store and
 * queue call; not done. A test pins that a pool of 2 is enough for one reconciler.
 */
async function withReconcileLock<T>(
  appPool: AppPool,
  p: StagePayload,
  fn: () => Promise<T>,
): Promise<T> {
  const key = JSON.stringify(['reconcile', p.tenantId, p.caseId, p.stage]);
  return withTenant(appPool, p.tenantId, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
    return fn();
  });
}

async function retry(
  o: ReconcileOptions,
  p: StagePayload,
  actions: ReconcileAction[],
): Promise<void> {
  await withReconcileLock(o.appPool, p, async () => {
    const s = await stageAttemptState(o.appPool, p.tenantId, p.caseId);
    // Superseded: the case moved on, or a later attempt of this visit exists (another reconciler
    // that held the lock before us, say).
    if (s.stage !== p.stage || s.latestAttempt !== p.attempt) return;
    if (await isFlaggedForReview(o.appPool, p.tenantId, p.caseId, p.stage, s.visit)) return;
    const review = async (reason: ReviewReason, why: string) => {
      if (await flagForReview(o.appPool, { ...p, visit: s.visit }, reason, why)) {
        actions.push({ kind: 'needs-review', payload: p, reason, why });
      }
    };
    // Attempts of THIS visit only: an appeal that returns to the stage starts a fresh budget.
    if (s.visitAttempts >= o.maxStageAttempts) {
      await review(
        'attempts-exhausted',
        `stage ${p.stage} used ${s.visitAttempts} of ${o.maxStageAttempts} attempts in this visit`,
      );
      return;
    }
    // The dead attempt must be abandoned BEFORE the next one is enqueued, or the claim refuses it.
    await failStageRun(o.appPool, p, 'abandoned by reconcile: lease expired or job failed');
    const next = { ...p, attempt: s.nextAttempt };
    const store = new PgCaseStore(o.appPool, p.tenantId, { juryEnabled: o.juryEnabled });
    const charge: StageCost = {
      stage: p.stage,
      inputTokens: 0,
      outputTokens: 0,
      usd: 0,
      wallMs: 0,
      attempt: next.attempt,
    };
    if ((await store.chargeBudget(p.caseId, charge)).exhausted) {
      await review('budget-exhausted', 'case budget is exhausted');
      return;
    }
    if (await enqueueStage(o.appPool, next)) {
      actions.push({ kind: 'retried', payload: p, nextAttempt: next.attempt });
    }
  });
}

/**
 * Registers a case at `intake`, records the first event and enqueues the first stage job. Not
 * atomic: a crash after `open` leaves a case at intake with no job, which `reconcileOnce` finds
 * and repairs. `afterOpen` is a test seam.
 */
export async function startCase(
  appPool: AppPool,
  caseFile: CaseFile,
  budget: Budget,
  options: { juryEnabled?: boolean; afterOpen?: () => Promise<void> } = {},
): Promise<void> {
  const store = new PgCaseStore(appPool, caseFile.tenantId, { juryEnabled: options.juryEnabled });
  await store.open(caseFile, budget);
  await options.afterOpen?.();
  const sink = new PgEventSink(appPool, caseFile.tenantId);
  await recordOnce(
    { store, sink, events: (id) => visitEvents(appPool, sink, caseFile.tenantId, id) },
    caseFile.id,
    'intake',
    'stenographer',
    {
      type: 'stage-entered',
      payload: {},
    },
  );
  await ensureStageJob(appPool, caseFile.tenantId, caseFile.id);
}

/**
 * Registers a case for an F3 hold (discovery matched a dismissal rule at or above the escalation
 * floor) and flags it for a person, with no stage job: the case stays at intake, is never
 * dismissed, and the recovery sweep leaves it alone (a flagged visit is not swept). `detail` is
 * fixed text from arraignment, never repository content. Idempotent: running it again for the
 * same case file records nothing new. Returns true when the flag is new.
 */
export async function openHeldCase(
  appPool: AppPool,
  caseFile: CaseFile,
  budget: Budget,
  detail: string,
  options: { juryEnabled?: boolean } = {},
): Promise<boolean> {
  const store = new PgCaseStore(appPool, caseFile.tenantId, { juryEnabled: options.juryEnabled });
  const exists = await withTenant(appPool, caseFile.tenantId, async (tx) => {
    const r = await tx.execute(
      sql`select 1 from public.cases where tenant_id = ${caseFile.tenantId} and id = ${caseFile.id}`,
    );
    return r.rows.length > 0;
  });
  if (!exists) await store.open(caseFile, budget);
  const sink = new PgEventSink(appPool, caseFile.tenantId);
  await recordOnce(
    { store, sink, events: (id) => visitEvents(appPool, sink, caseFile.tenantId, id) },
    caseFile.id,
    'intake',
    'stenographer',
    { type: 'stage-entered', payload: {} },
  );
  const s = await stageAttemptState(appPool, caseFile.tenantId, caseFile.id);
  return flagForReview(
    appPool,
    {
      tenantId: caseFile.tenantId,
      caseId: caseFile.id,
      stage: s.stage,
      attempt: s.nextAttempt,
      visit: s.visit,
    },
    'f3-hold',
    detail,
  );
}
