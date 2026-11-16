import { CaseStage } from '@affidavit/contracts';
import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  doublePrecision,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

/**
 * Every table carries `tenant_id`. Row-level security (enabled, forced, and the tenant policies)
 * is declared in the hand-written security migration, because Drizzle cannot express FORCE.
 * Every foreign key includes `tenant_id`, so a row can never reference another tenant's row.
 */
const tenantId = () => text('tenant_id').notNull();
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

const stageList = sql.raw(CaseStage.options.map((s) => `'${s}'`).join(', '));

export const tenants = pgTable('tenants', {
  tenantId: text('tenant_id').primaryKey(),
  name: text('name'),
  createdAt: createdAt(),
}).enableRLS();

export const repos = pgTable(
  'repos',
  {
    tenantId: tenantId(),
    id: text('id').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.id] }),
    foreignKey({ columns: [t.tenantId], foreignColumns: [tenants.tenantId] }),
  ],
).enableRLS();

export const cases = pgTable(
  'cases',
  {
    tenantId: tenantId(),
    id: text('id').notNull(),
    repoId: text('repo_id').notNull(),
    /** The validated CaseFile, as handed over at open. */
    caseFile: jsonb('case_file').notNull(),
    stage: text('stage').notNull().default('intake'),
    candidateScore: doublePrecision('candidate_score').notNull(),
    escalationFloor: doublePrecision('escalation_floor').notNull(),
    remainingInputTokens: bigint('remaining_input_tokens', { mode: 'number' }).notNull(),
    remainingOutputTokens: bigint('remaining_output_tokens', { mode: 'number' }).notNull(),
    remainingUsd: numeric('remaining_usd', { precision: 24, scale: 6 }).notNull(),
    exhausted: boolean('exhausted').notNull().default(false),
    appeals: integer('appeals').notNull().default(0),
    /** Next event seq to hand out. */
    seq: integer('seq').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.id] }),
    foreignKey({ columns: [t.tenantId, t.repoId], foreignColumns: [repos.tenantId, repos.id] }),
    check('cases_stage_valid', sql`${t.stage} in (${stageList})`),
    // The columns the store and the SQL guards act on must agree with the validated case file, so
    // F3 cannot be dodged by a row whose score or floor column differs from its case file.
    check(
      'cases_file_matches',
      sql`${t.caseFile}->>'id' = ${t.id}
        and ${t.caseFile}->>'tenantId' = ${t.tenantId}
        and (${t.caseFile}->'candidate'->>'score')::double precision = ${t.candidateScore}
        and (${t.caseFile}->>'escalationFloor')::double precision = ${t.escalationFloor}`,
    ),
    check('cases_budget_finite', sql`${t.remainingUsd} <> 'NaN'::numeric`),
  ],
).enableRLS();

const caseRef = (t: { tenantId: AnyPgColumn; caseId: AnyPgColumn }) =>
  foreignKey({ columns: [t.tenantId, t.caseId], foreignColumns: [cases.tenantId, cases.id] });

/** One row per stage a case entered, in order. */
export const stages = pgTable(
  'stages',
  {
    tenantId: tenantId(),
    caseId: text('case_id').notNull(),
    ordinal: integer('ordinal').notNull(),
    stage: text('stage').notNull(),
    enteredAt: timestamp('entered_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.caseId, t.ordinal] }),
    caseRef(t),
    check('stages_stage_valid', sql`${t.stage} in (${stageList})`),
  ],
).enableRLS();

export const exhibits = pgTable(
  'exhibits',
  {
    tenantId: tenantId(),
    caseId: text('case_id').notNull(),
    id: text('id').notNull(),
    kind: text('kind').notNull(),
    author: text('author').notNull(),
    sha256: text('sha256').notNull(),
    exhibit: jsonb('exhibit').notNull(),
    /** The Judge's ExhibitResult, set once it exists. The only mutable column. */
    result: jsonb('result'),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.caseId, t.id] }),
    caseRef(t),
    check('exhibits_kind_valid', sql`${t.kind} in ('witness', 'counterexample', 'patch')`),
    // The blob must say what the columns say, and a result is an object about this exhibit (a JSON
    // null would otherwise freeze the write-once column).
    check(
      'exhibits_blob_matches',
      sql`${t.exhibit}->>'id' = ${t.id} and ${t.exhibit}->>'caseId' = ${t.caseId}
        and ${t.exhibit}->>'kind' = ${t.kind} and ${t.exhibit}->>'author' = ${t.author}
        and ${t.exhibit}->>'sha256' = ${t.sha256}`,
    ),
    check(
      'exhibits_result_valid',
      sql`${t.result} is null or (jsonb_typeof(${t.result}) = 'object' and ${t.result}->>'exhibitId' = ${t.id})`,
    ),
  ],
).enableRLS();

/** Keyed by the seq of the `ballot-cast` event that recorded it. */
export const ballots = pgTable(
  'ballots',
  {
    tenantId: tenantId(),
    caseId: text('case_id').notNull(),
    seq: integer('seq').notNull(),
    jurorId: text('juror_id').notNull(),
    question: text('question').notNull(),
    ballot: jsonb('ballot').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.caseId, t.seq] }),
    caseRef(t),
    check(
      'ballots_blob_matches',
      sql`${t.ballot}->>'jurorId' = ${t.jurorId} and ${t.ballot}->>'question' = ${t.question}`,
    ),
  ],
).enableRLS();

/** Append-only: the application role has no UPDATE or DELETE grant, and a trigger backs it up. */
export const verdicts = pgTable(
  'verdicts',
  {
    tenantId: tenantId(),
    caseId: text('case_id').notNull(),
    outcome: text('outcome').notNull(),
    verdict: jsonb('verdict').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.caseId] }),
    caseRef(t),
    check(
      'verdicts_blob_matches',
      sql`${t.verdict}->>'caseId' = ${t.caseId} and ${t.verdict}->>'outcome' = ${t.outcome}`,
    ),
  ],
).enableRLS();

export const costRows = pgTable(
  'cost_rows',
  {
    tenantId: tenantId(),
    caseId: text('case_id').notNull(),
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().notNull(),
    stage: text('stage').notNull(),
    attempt: integer('attempt').notNull(),
    inputTokens: bigint('input_tokens', { mode: 'number' }).notNull(),
    outputTokens: bigint('output_tokens', { mode: 'number' }).notNull(),
    usd: numeric('usd', { precision: 24, scale: 9 }).notNull(),
    wallMs: bigint('wall_ms', { mode: 'number' }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.caseId, t.id] }),
    caseRef(t),
    check('cost_rows_stage_valid', sql`${t.stage} in (${stageList})`),
    check(
      'cost_rows_values_valid',
      sql`${t.attempt} >= 1 and ${t.inputTokens} >= 0 and ${t.outputTokens} >= 0 and ${t.usd} >= 0 and ${t.usd} <> 'NaN'::numeric and ${t.wallMs} >= 0`,
    ),
  ],
).enableRLS();

/** Keyed by the seq of the `escalated` or `budget-exhausted` event that recorded it. */
export const escalations = pgTable(
  'escalations',
  {
    tenantId: tenantId(),
    caseId: text('case_id').notNull(),
    seq: integer('seq').notNull(),
    reason: text('reason').notNull(),
    detail: text('detail').notNull(),
    escalation: jsonb('escalation').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.caseId, t.seq] }),
    caseRef(t),
    check(
      'escalations_blob_matches',
      sql`${t.escalation}->>'caseId' = ${t.caseId} and ${t.escalation}->>'reason' = ${t.reason}`,
    ),
  ],
).enableRLS();

/** TrialEvent log, idempotent on (case_id, seq). Append-only like verdicts. */
export const events = pgTable(
  'events',
  {
    tenantId: tenantId(),
    caseId: text('case_id').notNull(),
    seq: integer('seq').notNull(),
    type: text('type').notNull(),
    event: jsonb('event').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.caseId, t.seq] }),
    caseRef(t),
    index('events_case_idx').on(t.tenantId, t.caseId),
    check(
      'events_blob_matches',
      sql`${t.event}->>'type' = ${t.type} and ${t.event}->>'caseId' = ${t.caseId}
        and (${t.event}->>'seq')::int = ${t.seq}`,
    ),
  ],
).enableRLS();

/**
 * Durable record that a stage attempt was enqueued, written by enqueue_stage() (the only writer).
 * The claim function checks a job payload against this record, so a forged or rewritten queue job
 * is refused at claim. Insert-only.
 */
export const stageJobs = pgTable(
  'stage_jobs',
  {
    tenantId: tenantId(),
    caseId: text('case_id').notNull(),
    stage: text('stage').notNull(),
    attempt: integer('attempt').notNull(),
    /** The stage-history ordinal of the case when this was enqueued: one visit to a stage. */
    visit: integer('visit').notNull(),
    enqueuedAt: timestamp('enqueued_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.caseId, t.stage, t.attempt] }),
    caseRef(t),
    check('stage_jobs_stage_valid', sql`${t.stage} in (${stageList})`),
    check('stage_jobs_attempt_valid', sql`${t.attempt} >= 1`),
  ],
).enableRLS();

/**
 * Durable record that a stage attempt was claimed, written only by claim_stage_run() after it
 * verified the job against stage_jobs. An attempt runs at most once even after Graphile Worker
 * has deleted its finished job. The claim carries a lease (worker_id, heartbeat_at,
 * lease_expires_at). `completed_at` (written in the handler's own final transaction when it can)
 * and `failed_at` plus `error` are each write-once and exclusive. A row with neither, past its
 * lease, is an attempt whose worker died.
 */
export const stageRuns = pgTable(
  'stage_runs',
  {
    tenantId: tenantId(),
    caseId: text('case_id').notNull(),
    stage: text('stage').notNull(),
    attempt: integer('attempt').notNull(),
    /** The stage visit (stage-history ordinal) this attempt belongs to, copied from stage_jobs. */
    visit: integer('visit').notNull(),
    workerId: text('worker_id').notNull(),
    /**
     * Secret handed only to the claimer. Heartbeat, completion and a holder's failure need it, so
     * another caller with the application role cannot act on someone else's lease. Not readable
     * by the application role (column-level grants omit it).
     */
    leaseToken: text('lease_token')
      .notNull()
      .default(sql`gen_random_uuid()::text`),
    claimedAt: timestamp('claimed_at', { withTimezone: true }).notNull().defaultNow(),
    heartbeatAt: timestamp('heartbeat_at', { withTimezone: true }).notNull().defaultNow(),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }).notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    failedAt: timestamp('failed_at', { withTimezone: true }),
    error: text('error'),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.caseId, t.stage, t.attempt] }),
    caseRef(t),
    check('stage_runs_stage_valid', sql`${t.stage} in (${stageList})`),
    check('stage_runs_attempt_valid', sql`${t.attempt} >= 1`),
  ],
).enableRLS();
