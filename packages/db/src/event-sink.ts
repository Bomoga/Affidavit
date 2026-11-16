import {
  TrialEvent as TrialEventSchema,
  type CaseId,
  type EventSink,
  type TrialEvent,
} from '@affidavit/contracts';
import { and, asc, eq, gt } from 'drizzle-orm';
import type pg from 'pg';
import * as t from './schema.js';
import { pgErrorCode, withTenant } from './tenant.js';

/**
 * Postgres EventSink for one tenant. Idempotent on (caseId, seq): the first write wins and a
 * repeat is a no-op. Ballot and escalation events also fill their own tables, in the same
 * transaction, only when the event row is new.
 */
export class PgEventSink implements EventSink {
  constructor(
    private readonly pool: pg.Pool,
    readonly tenantId: string,
  ) {}

  async emit(eventIn: TrialEvent): Promise<void> {
    const event = TrialEventSchema.parse(eventIn);
    // A payload that names another case must not land in this case's side tables.
    const inner =
      event.type === 'escalated' || event.type === 'budget-exhausted'
        ? event.payload.escalation.caseId
        : event.type === 'verdict-written'
          ? event.payload.verdict.caseId
          : event.caseId;
    if (inner !== event.caseId) {
      throw new Error(`event for case ${event.caseId} carries a payload for case ${inner}`);
    }
    try {
      await withTenant(this.pool, this.tenantId, async (tx) => {
        const inserted = await tx
          .insert(t.events)
          .values({
            tenantId: this.tenantId,
            caseId: event.caseId,
            seq: event.seq,
            type: event.type,
            event,
          })
          .onConflictDoNothing()
          .returning({ seq: t.events.seq });
        if (inserted.length === 0) return;
        if (event.type === 'ballot-cast') {
          await tx.insert(t.ballots).values({
            tenantId: this.tenantId,
            caseId: event.caseId,
            seq: event.seq,
            jurorId: event.payload.ballot.jurorId,
            question: event.payload.ballot.question,
            ballot: event.payload.ballot,
          });
        } else if (event.type === 'escalated' || event.type === 'budget-exhausted') {
          const { escalation } = event.payload;
          await tx.insert(t.escalations).values({
            tenantId: this.tenantId,
            caseId: event.caseId,
            seq: event.seq,
            reason: escalation.reason,
            detail: escalation.detail,
            escalation,
          });
        }
      });
    } catch (err) {
      // 23503: the (tenant_id, case_id) foreign key found no case, or the case is another tenant's.
      if (pgErrorCode(err) === '23503')
        throw new Error(`unknown case ${event.caseId}`, { cause: err });
      throw err;
    }
  }

  /** Beyond the port: a case's events in seq order, optionally only those after `afterSeq`. */
  async events(caseId: CaseId, afterSeq = -1): Promise<TrialEvent[]> {
    return withTenant(this.pool, this.tenantId, async (tx) => {
      const rows = await tx
        .select({ event: t.events.event })
        .from(t.events)
        .where(
          and(
            eq(t.events.tenantId, this.tenantId),
            eq(t.events.caseId, caseId),
            gt(t.events.seq, afterSeq),
          ),
        )
        .orderBy(asc(t.events.seq));
      return rows.map((r) => TrialEventSchema.parse(r.event));
    });
  }
}
