import {
  CaseFile as CaseFileSchema,
  CaseId as CaseIdSchema,
  CaseStage as CaseStageSchema,
  type CaseStage,
} from '@affidavit/contracts';
import { PgCaseStore, PgEventSink, startCase, withTenant, type AppPool } from '@affidavit/db';
import {
  UnknownTenantError,
  type CaseBackend,
  type CaseView,
  type TenantCases,
} from './backend.js';

const isUnknownCase = (err: unknown) => err instanceof Error && /^unknown case /.test(err.message);
const isUnknownTenant = (err: unknown) =>
  err instanceof Error && /^unknown tenant /.test(err.message);

/**
 * Postgres backend. Every call goes through the `affidavit_app` pool (checked by `openPool`) with
 * the tenant set per transaction, so row-level security applies; another tenant's case reads as
 * missing. POST /cases goes through `startCase`, which opens the case and enqueues intake; a
 * worker must be running for the case to move.
 */
export class PgCaseBackend implements CaseBackend {
  constructor(
    private readonly pool: AppPool,
    private readonly options: { juryEnabled?: boolean; ownsPool?: boolean } = {},
  ) {}

  forTenant(tenantId: string): TenantCases {
    const store = new PgCaseStore(this.pool, tenantId, { juryEnabled: this.options.juryEnabled });
    const sink = new PgEventSink(this.pool, tenantId);
    const stage = async (caseId: string): Promise<CaseStage | null> => {
      try {
        return await store.stage(CaseIdSchema.parse(caseId));
      } catch (err) {
        if (isUnknownCase(err)) return null;
        throw err;
      }
    };
    return {
      create: async (caseFile, budget) => {
        try {
          await startCase(this.pool, caseFile, budget, { juryEnabled: this.options.juryEnabled });
        } catch (err) {
          if (isUnknownTenant(err)) throw new UnknownTenantError();
          throw err;
        }
      },
      get: async (caseId) => {
        const row = await withTenant(this.pool, tenantId, (tx) =>
          tx.query.cases.findFirst({
            columns: { stage: true, caseFile: true },
            where: (c, { and, eq }) => and(eq(c.tenantId, tenantId), eq(c.id, caseId)),
          }),
        );
        if (!row) return null;
        const view: CaseView = {
          caseId,
          stage: CaseStageSchema.parse(row.stage),
          caseFile: CaseFileSchema.parse(row.caseFile),
        };
        const verdict = await store.getVerdict(CaseIdSchema.parse(caseId)).catch((err: unknown) => {
          if (isUnknownCase(err)) return null;
          throw err;
        });
        if (verdict) view.verdict = verdict;
        return view;
      },
      stage,
      events: async (caseId, afterSeq, limit) => {
        if ((await stage(caseId)) === null) return null;
        return sink.events(CaseIdSchema.parse(caseId), afterSeq, limit);
      },
    };
  }

  /** Reads the tenant's own row under RLS (the app role sees only the tenant it set). */
  async isProvisioned(tenantId: string): Promise<boolean> {
    const row = await withTenant(this.pool, tenantId, (tx) =>
      tx.query.tenants.findFirst({
        columns: { tenantId: true },
        where: (t, { eq }) => eq(t.tenantId, tenantId),
      }),
    );
    return row !== undefined;
  }

  async close(): Promise<void> {
    if (this.options.ownsPool) await this.pool.end();
  }
}
