import { CaseId, CaseStage, TenantId } from '@affidavit/contracts';
import type { TaskList, WorkerUtils } from 'graphile-worker';

/** What a stage job carries: ids only, never case content. */
export interface StagePayload {
  tenantId: string;
  caseId: CaseId;
  stage: CaseStage;
  /** Logical attempt, 1-based. A retry is a new attempt and must charge its budget first. */
  attempt: number;
}

/** One Graphile Worker task per case stage. */
export function stageTaskIdentifier(stage: CaseStage): string {
  return `case-stage:${CaseStage.parse(stage)}`;
}

export function parseStagePayload(input: unknown): StagePayload {
  if (typeof input !== 'object' || input === null)
    throw new Error('stage payload must be an object');
  const o = input as Record<string, unknown>;
  const attempt = o.attempt;
  if (typeof attempt !== 'number' || !Number.isInteger(attempt) || attempt < 1) {
    throw new Error('stage payload attempt must be an integer of at least 1');
  }
  return {
    tenantId: TenantId.parse(o.tenantId),
    caseId: CaseId.parse(o.caseId),
    stage: CaseStage.parse(o.stage),
    attempt,
  };
}

/**
 * Idempotency key: tenant, case, stage and attempt. The tenant is included because case ids are
 * only unique per tenant, and a shared key would let one tenant's job swallow another's. A JSON
 * array keeps the parts unambiguous whatever characters the ids contain.
 */
export function stageJobKey(p: StagePayload): string {
  return JSON.stringify([p.tenantId, p.caseId, p.stage, p.attempt]);
}

export interface EnqueueOptions {
  /** Graphile-level retries. Default 1: a retry is an explicit new attempt, not a silent rerun. */
  maxAttempts?: number;
  runAt?: Date;
}

/**
 * Enqueue the job for a case stage. Enqueueing the same key again while that job is still queued,
 * running, or failed does nothing (`unsafe_dedupe`), so callers may retry the enqueue freely.
 */
export async function enqueueStage(
  utils: Pick<WorkerUtils, 'addJob'>,
  payloadIn: StagePayload,
  options: EnqueueOptions = {},
): Promise<void> {
  const payload = parseStagePayload(payloadIn);
  await utils.addJob(stageTaskIdentifier(payload.stage), payload, {
    jobKey: stageJobKey(payload),
    jobKeyMode: 'unsafe_dedupe',
    maxAttempts: options.maxAttempts ?? 1,
    ...(options.runAt ? { runAt: options.runAt } : {}),
  });
}

export type StageHandler = (job: StagePayload) => Promise<void>;

/** Task list for `graphile-worker`'s `run`: one task per stage that has a handler. */
export function stageTaskList(handlers: Partial<Record<CaseStage, StageHandler>>): TaskList {
  const list: TaskList = {};
  for (const stage of CaseStage.options) {
    const handler = handlers[stage];
    if (!handler) continue;
    list[stageTaskIdentifier(stage)] = async (raw) => {
      const job = parseStagePayload(raw);
      if (job.stage !== stage) throw new Error(`payload stage ${job.stage} on task for ${stage}`);
      await handler(job);
    };
  }
  return list;
}
