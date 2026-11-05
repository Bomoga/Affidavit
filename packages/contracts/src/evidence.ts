import { z } from 'zod';
import {
  AdmissibilityRule,
  CaseId,
  ExhibitId,
  ImageDigest,
  Role,
  SchemaVersion,
  Sha256,
  TargetVariant,
  VulnClass,
  WitnessId,
} from './common.js';

/** Finite, enumerable parameter space. A witness is a family over it, not one input (F5). */
export const ParamSpace = z.array(
  z.object({ name: z.string().min(1), values: z.array(z.json()).min(1) }),
);
export type ParamSpace = z.infer<typeof ParamSpace>;

export const Witness = z.object({
  schemaVersion: SchemaVersion,
  id: WitnessId,
  caseId: CaseId,
  cls: VulnClass,
  template: z.string().min(1),
  params: ParamSpace,
  author: Role,
  /** Hash of the canonical template plus params; the key scripted fakes use. */
  sha256: Sha256,
});
export type Witness = z.infer<typeof Witness>;

const ExhibitBase = z.object({
  schemaVersion: SchemaVersion,
  id: ExhibitId,
  caseId: CaseId,
  author: Role,
  code: z.string(),
  sha256: Sha256,
});

export const WitnessExhibit = ExhibitBase.extend({ kind: z.literal('witness') });
export const CounterexampleExhibit = ExhibitBase.extend({ kind: z.literal('counterexample') });
export const PatchExhibit = ExhibitBase.extend({
  kind: z.literal('patch'),
  diff: z.string().min(1),
  filesTouched: z.array(z.string().min(1)).min(1),
  linesChanged: z.int().min(1),
});
export const Exhibit = z.discriminatedUnion('kind', [
  WitnessExhibit,
  CounterexampleExhibit,
  PatchExhibit,
]);
export type Exhibit = z.infer<typeof Exhibit>;
export type PatchExhibit = z.infer<typeof PatchExhibit>;

export const RunRecord = z.object({
  variant: TargetVariant,
  attempt: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  exitCode: z.int(),
  passed: z.boolean(),
  durationMs: z.int().min(0),
  stdoutSha256: Sha256,
  stderrSha256: Sha256,
});
export type RunRecord = z.infer<typeof RunRecord>;

export const ExhibitResult = z
  .object({
    schemaVersion: SchemaVersion,
    exhibitId: ExhibitId,
    admissible: z.boolean(),
    rejectedBy: AdmissibilityRule.optional(),
    runs: z.array(RunRecord),
    vulnPass: z.boolean(),
    /** Present only when the corpus has a safe variant to compare against (F2). */
    safeVariantFail: z.boolean().optional(),
    egressAttempts: z.int().min(0),
    familyResults: z
      .array(z.object({ paramIndex: z.int().min(0), passed: z.boolean() }))
      .optional(),
    passed: z.boolean(),
    durationMs: z.int().min(0),
  })
  .refine((r) => r.admissible || r.rejectedBy !== undefined, {
    message: 'an inadmissible result must name the rule that rejected it',
    path: ['rejectedBy'],
  })
  .refine((r) => !r.admissible || r.rejectedBy === undefined, {
    message: 'an admissible result cannot carry a rejecting rule',
    path: ['rejectedBy'],
  });
export type ExhibitResult = z.infer<typeof ExhibitResult>;

export const VerifyResult = z.object({
  schemaVersion: SchemaVersion,
  patchExhibitId: ExhibitId,
  familyFlipped: z.boolean(),
  suitePassed: z.boolean(),
  rescanClean: z.boolean(),
  counterexamples: z.array(z.object({ exhibitId: ExhibitId, survived: z.boolean() })),
  rejectedBy: AdmissibilityRule.optional(),
});
export type VerifyResult = z.infer<typeof VerifyResult>;

export const BundleManifest = z.object({
  schemaVersion: SchemaVersion,
  caseId: CaseId,
  createdAt: z.iso.datetime(),
  targetDigests: z.partialRecord(TargetVariant, ImageDigest),
  exhibits: z.array(z.object({ id: ExhibitId, sha256: Sha256, path: z.string().min(1) })),
  results: z.array(ExhibitId),
  verdictSha256: Sha256,
  toolVersions: z.record(z.string(), z.string()),
});
export type BundleManifest = z.infer<typeof BundleManifest>;

export const InTotoStatement = z.object({
  _type: z.literal('https://in-toto.io/Statement/v1'),
  subject: z
    .array(z.object({ name: z.string().min(1), digest: z.object({ sha256: Sha256 }) }))
    .min(1),
  predicateType: z.string().min(1),
  predicate: z.record(z.string(), z.json()),
});
export type InTotoStatement = z.infer<typeof InTotoStatement>;

export const Attestation = z.object({
  schemaVersion: SchemaVersion,
  statement: InTotoStatement,
  signature: z.string().min(1),
  keyId: z.string().min(1),
});
export type Attestation = z.infer<typeof Attestation>;
