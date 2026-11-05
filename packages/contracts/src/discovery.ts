import { z } from 'zod';
import {
  CaseId,
  CommitSha,
  ImageDigest,
  RepoId,
  SchemaVersion,
  TargetVariant,
  TenantId,
  VulnClass,
} from './common.js';

export const TargetRef = z.object({
  repo: RepoId,
  commit: CommitSha,
  variant: TargetVariant,
  imageDigest: ImageDigest.optional(),
});
export type TargetRef = z.infer<typeof TargetRef>;

export const ExternalStub = z.object({
  name: z.string().min(1),
  kind: z.enum(['http', 'smtp', 's3']),
  hostAlias: z.string().min(1),
});
export type ExternalStub = z.infer<typeof ExternalStub>;

export const BootHints = z.object({
  kind: z.enum(['dockerfile', 'compose']),
  path: z.string().min(1),
  service: z.string().optional(),
  ports: z.array(z.int().min(1).max(65535)).min(1),
  healthRoute: z.string().startsWith('/'),
  healthTimeoutMs: z.int().positive(),
  seed: z.object({ kind: z.enum(['sql', 'script']), path: z.string().min(1) }).optional(),
  stubs: z.array(ExternalStub),
  /** Targets boot with synthetic env values only; real .env files are never copied in. */
  env: z.record(z.string(), z.literal('synthetic')),
});
export type BootHints = z.infer<typeof BootHints>;

const LineRange = z.object({ startLine: z.int().min(1), endLine: z.int().min(1) });

export const Candidate = z.object({
  schemaVersion: SchemaVersion,
  id: z.string().min(1),
  tool: z.enum(['semgrep', 'codeql', 'osv', 'treesitter']),
  ruleId: z.string().min(1),
  cls: VulnClass,
  file: z.string().min(1),
  range: LineRange,
  reachability: z.enum(['reachable', 'unreachable', 'unknown']),
  score: z.number().min(0).max(1),
  scoreInputs: z.record(z.string(), z.number()),
  toolAgreement: z.number().min(0),
});
export type Candidate = z.infer<typeof Candidate>;

/** Repo text shown to agents. Always untrusted data; comments and prose are stripped or fenced. */
export const Slice = z.object({
  file: z.string().min(1),
  range: LineRange,
  code: z.string(),
  strippedComments: z.boolean(),
  untrusted: z.literal(true),
});
export type Slice = z.infer<typeof Slice>;

export const RouteInfo = z.object({
  method: z.string().min(1),
  path: z.string().min(1),
  handlerFile: z.string().min(1),
  middleware: z.array(z.string()),
  authRequired: z.union([z.boolean(), z.literal('unknown')]),
});
export type RouteInfo = z.infer<typeof RouteInfo>;

/** Location and kind of a redacted secret. Never carries the secret value. */
export const Redaction = z.object({
  file: z.string().min(1),
  startLine: z.int().min(1),
  endLine: z.int().min(1),
  kind: z.string().min(1),
  placeholder: z.string().min(1),
});
export type Redaction = z.infer<typeof Redaction>;

export const CaseFile = z.object({
  schemaVersion: SchemaVersion,
  id: CaseId,
  tenantId: TenantId,
  target: TargetRef,
  candidate: Candidate,
  slices: z.array(Slice),
  route: RouteInfo.optional(),
  bootHints: BootHints,
  redactions: z.array(Redaction),
  /** Arraignment score at or above this means no silent dismissal (F3). */
  escalationFloor: z.number().min(0).max(1),
  safeVariant: TargetRef.optional(),
});
export type CaseFile = z.infer<typeof CaseFile>;

export const Dismissal = z.object({
  schemaVersion: SchemaVersion,
  candidateId: z.string().min(1),
  reason: z.enum([
    'unreachable',
    'negative-control',
    'below-threshold',
    'osv-no-path',
    'no-admissible-witness-below-floor',
  ]),
  detail: z.string(),
});
export type Dismissal = z.infer<typeof Dismissal>;
