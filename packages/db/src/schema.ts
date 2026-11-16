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
  (t) => [primaryKey({ columns: [t.tenantId, t.caseId, t.seq] }), caseRef(t)],
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
  (t) => [primaryKey({ columns: [t.tenantId, t.caseId] }), caseRef(t)],
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
  (t) => [primaryKey({ columns: [t.tenantId, t.caseId, t.seq] }), caseRef(t)],
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
  ],
).enableRLS();
