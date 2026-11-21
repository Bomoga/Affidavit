import type { Budget, CaseFile, CaseStage, TrialEvent, Verdict } from '@affidavit/contracts';

export interface CaseView {
  caseId: string;
  stage: CaseStage;
  caseFile?: CaseFile;
  verdict?: Verdict;
}

/**
 * Everything one tenant may do through the API. A case of another tenant is indistinguishable
 * from one that does not exist: every lookup returns null for both.
 */
export interface TenantCases {
  create(caseFile: CaseFile, budget: Budget): Promise<void>;
  get(caseId: string): Promise<CaseView | null>;
  stage(caseId: string): Promise<CaseStage | null>;
  /** Events with seq greater than `afterSeq`, in seq order; null when the case is not visible. */
  events(caseId: string, afterSeq: number): Promise<TrialEvent[] | null>;
}

export interface CaseBackend {
  forTenant(tenantId: string): TenantCases;
  close(): Promise<void>;
}

/** Thrown by `create` when the tenant has not been provisioned (Postgres store). */
export class UnknownTenantError extends Error {
  constructor() {
    super('tenant is not provisioned');
    this.name = 'UnknownTenantError';
  }
}
