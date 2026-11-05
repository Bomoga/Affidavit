import type { z } from 'zod';
import * as api from './api.js';
import * as discovery from './discovery.js';
import * as evidence from './evidence.js';
import * as trial from './trial.js';

/** Every boundary schema by name. Drives JSON Schema export and the round-trip tests. */
export const schemaRegistry: Readonly<Record<string, z.ZodType>> = {
  TargetRef: discovery.TargetRef,
  BootHints: discovery.BootHints,
  Candidate: discovery.Candidate,
  Slice: discovery.Slice,
  RouteInfo: discovery.RouteInfo,
  CaseFile: discovery.CaseFile,
  Dismissal: discovery.Dismissal,
  Witness: evidence.Witness,
  Exhibit: evidence.Exhibit,
  RunRecord: evidence.RunRecord,
  ExhibitResult: evidence.ExhibitResult,
  VerifyResult: evidence.VerifyResult,
  BundleManifest: evidence.BundleManifest,
  Attestation: evidence.Attestation,
  Ballot: trial.Ballot,
  Verdict: trial.Verdict,
  Escalation: trial.Escalation,
  TrialEvent: trial.TrialEvent,
  CreateCaseRequest: api.CreateCaseRequest,
  CreateCaseResponse: api.CreateCaseResponse,
  GetCaseResponse: api.GetCaseResponse,
  GetBundleResponse: api.GetBundleResponse,
  GithubWebhookRequest: api.GithubWebhookRequest,
};
