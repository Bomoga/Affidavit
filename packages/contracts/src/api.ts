import { z } from 'zod';
import { CaseId, CaseStage, CommitSha, IsoDate, SchemaVersion, Sha256 } from './common.js';
import { CaseFile } from './discovery.js';
import { TrialEvent, Verdict } from './trial.js';

/** POST /cases */
export const CreateCaseRequest = z.object({
  repoUrl: z.url(),
  commit: CommitSha,
});
export const CreateCaseResponse = z.object({
  schemaVersion: SchemaVersion,
  caseId: CaseId,
  stage: CaseStage,
});

/** GET /cases/:id */
export const GetCaseResponse = z.object({
  schemaVersion: SchemaVersion,
  caseId: CaseId,
  stage: CaseStage,
  caseFile: CaseFile.optional(),
  verdict: Verdict.optional(),
});

/** GET /cases/:id/events is an SSE stream; each message data field is one TrialEvent. */
export const SseTrialEvent = TrialEvent;

/** GET /cases/:id/verdict */
export const GetVerdictResponse = Verdict;

/** GET /bundles/:sha256 returns a short-lived signed URL, never the bytes. */
export const GetBundleResponse = z.object({
  schemaVersion: SchemaVersion,
  sha256: Sha256,
  url: z.url(),
  expiresAt: IsoDate,
});

/** POST /webhooks/github. The body is verified by HMAC before parsing and stays opaque here. */
export const GithubWebhookRequest = z.object({
  event: z.string().min(1),
  deliveryId: z.string().min(1),
  payload: z.record(z.string(), z.json()),
});

export const ApiRoutes = {
  createCase: { request: CreateCaseRequest, response: CreateCaseResponse },
  getCase: { response: GetCaseResponse },
  caseEvents: { event: SseTrialEvent },
  getVerdict: { response: GetVerdictResponse },
  getBundle: { response: GetBundleResponse },
  githubWebhook: { request: GithubWebhookRequest },
} as const;
