import {
  CaseFile as CaseFileSchema,
  TrialEvent,
  type CaseFile,
  type CaseFileSource,
  type CaseId,
  type CaseStage,
  type CaseStore,
  type EventSink,
  type Role,
} from '@affidavit/contracts';
import { cases, withTenant, type AppPool, type StagePayload } from '@affidavit/db';

/** What a stage core gets: ports already scoped to the job's tenant and guarded by its lease. */
export interface StageEnv {
  job: StagePayload;
  store: CaseStore;
  sink: EventSink;
  caseFiles: CaseFileSource;
  signal: AbortSignal;
}

/** Stage work only: do it, then move the case with `store.transition`. The wrapper does the rest. */
export type StageCore = (env: StageEnv) => Promise<void>;

type EventBody = {
  [K in TrialEvent['type']]: { type: K; payload: Extract<TrialEvent, { type: K }>['payload'] };
}[TrialEvent['type']];

/** Appends one schema-valid event for `stage`. The sequence number comes from the store. */
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
 * Stopgap CaseFileSource over the `cases` table, read as one tenant (row-level security does the
 * scoping; the filter on id is in memory). A db follow-up should replace it with a keyed read.
 */
export class PgCaseFileSource implements CaseFileSource {
  constructor(
    private readonly pool: AppPool,
    private readonly tenantId: string,
  ) {}

  next(): Promise<CaseFile | null> {
    return Promise.reject(new Error('PgCaseFileSource.next is not supported'));
  }

  async get(caseId: CaseId): Promise<CaseFile | null> {
    const rows = await withTenant(this.pool, this.tenantId, (tx) => tx.select().from(cases));
    const row = rows.find((r) => r.id === caseId && r.tenantId === this.tenantId);
    return row ? CaseFileSchema.parse(row.caseFile) : null;
  }
}
