import { z } from 'zod';

/** Every boundary object carries this literal so a breaking change is detectable on read. */
export const SchemaVersion = z.literal(1);

export const Sha256 = z.string().regex(/^[0-9a-f]{64}$/, 'expected 64 lowercase hex characters');
export const CommitSha = z.string().regex(/^[0-9a-f]{40}$/, 'expected 40 lowercase hex characters');
export const ImageDigest = z.string().regex(/^sha256:[0-9a-f]{64}$/, 'expected sha256:<64 hex>');
export const IsoDate = z.iso.datetime();

export const TenantId = z.string().min(1).brand<'TenantId'>();
export const RepoId = z.string().min(1).brand<'RepoId'>();
export const CaseId = z.string().min(1).brand<'CaseId'>();
export const ExhibitId = z.string().min(1).brand<'ExhibitId'>();
export const WitnessId = z.string().min(1).brand<'WitnessId'>();
export type TenantId = z.infer<typeof TenantId>;
export type RepoId = z.infer<typeof RepoId>;
export type CaseId = z.infer<typeof CaseId>;
export type ExhibitId = z.infer<typeof ExhibitId>;
export type WitnessId = z.infer<typeof WitnessId>;

export const VulnClass = z.enum(['injection', 'idor']);
export type VulnClass = z.infer<typeof VulnClass>;

export const Severity = z.enum(['low', 'medium', 'high', 'critical']);
export type Severity = z.infer<typeof Severity>;

export const Role = z.enum(['defense', 'prosecution', 'remedy', 'juror', 'judge', 'stenographer']);
export type Role = z.infer<typeof Role>;

/**
 * Prompt ids, not roles, key per-verdict prompt versions and model ids: a role can run several
 * prompts (Defense has a second attempt on a different model, the jury has three mandates).
 * Mirrored by `PromptId` in packages/prompts; a test there asserts the lists match.
 */
export const PromptId = z.enum([
  'defense',
  'defense-second-attempt',
  'prosecution',
  'remedy',
  'juror-security',
  'juror-maintainability',
  'juror-blast-radius',
]);
export type PromptId = z.infer<typeof PromptId>;

export const CaseStage = z.enum([
  'intake',
  'map',
  'arraign',
  'defense',
  'prosecution',
  'remedy',
  'verify',
  'jury',
  'verdict',
  'dismissed',
  'escalated',
]);
export type CaseStage = z.infer<typeof CaseStage>;

export const TERMINAL_STAGES: readonly CaseStage[] = ['verdict', 'dismissed', 'escalated'];

/**
 * Legal stage transitions. Stores must reject anything else. Extra rules the store enforces that
 * this table cannot express: defense to dismissed only below the case's escalation floor (F3);
 * verify to remedy at most MAX_APPEALS times; verify to verdict only when the jury is disabled.
 */
export const STAGE_TRANSITIONS: Readonly<Record<CaseStage, readonly CaseStage[]>> = {
  intake: ['map'],
  map: ['arraign'],
  arraign: ['defense', 'dismissed'],
  defense: ['prosecution', 'dismissed', 'escalated'],
  prosecution: ['remedy', 'dismissed', 'escalated'],
  remedy: ['verify', 'escalated'],
  verify: ['remedy', 'jury', 'verdict', 'escalated'],
  jury: ['verdict', 'escalated'],
  verdict: [],
  dismissed: [],
  escalated: [],
};

export function isLegalTransition(from: CaseStage, to: CaseStage): boolean {
  return STAGE_TRANSITIONS[from].includes(to);
}

export const MAX_APPEALS = 2;

export const AdmissibilityRule = z.enum([
  'schema',
  'completes',
  'stable-3of3',
  'no-egress',
  'time-budget',
  'differential',
  'literal-only-patch',
  'diff-too-large',
  'suite-fails',
  'counterexample-survives',
]);
export type AdmissibilityRule = z.infer<typeof AdmissibilityRule>;

export const TargetVariant = z.enum(['vulnerable', 'safe', 'patched']);
export type TargetVariant = z.infer<typeof TargetVariant>;

export const StageCost = z.object({
  stage: CaseStage,
  inputTokens: z.int().min(0),
  outputTokens: z.int().min(0),
  /** Whole US dollars as a decimal number. */
  usd: z.number().min(0),
  wallMs: z.int().min(0),
  attempt: z.int().min(1),
});
export type StageCost = z.infer<typeof StageCost>;

export const Budget = z.object({
  maxInputTokens: z.int().min(0),
  maxOutputTokens: z.int().min(0),
  maxUsd: z.number().min(0),
});
export type Budget = z.infer<typeof Budget>;

export const BudgetState = z.object({
  remainingInputTokens: z.int(),
  remainingOutputTokens: z.int(),
  remainingUsd: z.number(),
  exhausted: z.boolean(),
});
export type BudgetState = z.infer<typeof BudgetState>;
