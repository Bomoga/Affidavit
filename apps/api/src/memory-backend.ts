import {
  CaseFile as CaseFileSchema,
  TrialEvent as TrialEventSchema,
  type Budget,
  type CaseFile,
  type CaseStage,
  type TrialEvent,
  type Verdict,
} from '@affidavit/contracts';
import type { CaseBackend, CaseView, TenantCases } from './backend.js';
import { buildFakeCaseFile, fixtureEvents, type TrialFixture } from './intake.js';

interface MemoryCase {
  tenantId: string;
  caseFile: CaseFile;
  stage: CaseStage;
  events: TrialEvent[];
  verdict?: Verdict;
}

/** The stage a case is at after `event`. */
function stageAfter(current: CaseStage, event: TrialEvent): CaseStage {
  switch (event.type) {
    case 'stage-entered':
      return event.stage;
    case 'stage-exited':
      return event.payload.to;
    case 'escalated':
    case 'budget-exhausted':
      return 'escalated';
    case 'dismissed':
      return 'dismissed';
    default:
      return current;
  }
}

export interface MemoryBackendOptions {
  /**
   * When set, a case created through `create` has the nodegoat fixture trial replayed into it,
   * one event every `replayMs`, standing in for the worker. Dev only.
   */
  replayMs?: number;
  /**
   * Tenants that count as provisioned for sign-in. Absent: every tenant is (dev, tests). The
   * Postgres backend reads the `tenants` table instead.
   */
  provisionedTenants?: readonly string[];
}

/**
 * In-memory backend for the dev server and the default test path. Cases are keyed by tenant and
 * case id, so one tenant cannot even address another's case. Event seqs are contiguous from 0;
 * a second event with a seq already stored is ignored (the EventSink idempotence rule).
 */
export class MemoryCaseBackend implements CaseBackend {
  private readonly cases = new Map<string, MemoryCase>();
  private readonly timers = new Set<NodeJS.Timeout>();
  private closed = false;

  constructor(private readonly options: MemoryBackendOptions = {}) {}

  private key(tenantId: string, caseId: string): string {
    return `${tenantId}\u0000${caseId}`;
  }

  private find(tenantId: string, caseId: string): MemoryCase | undefined {
    return this.cases.get(this.key(tenantId, caseId));
  }

  /** Registers a case at intake with no events. Throws if it already exists for this tenant. */
  open(caseFileIn: CaseFile): void {
    const caseFile = CaseFileSchema.parse(caseFileIn);
    const k = this.key(caseFile.tenantId, caseFile.id);
    if (this.cases.has(k)) throw new Error('case already open');
    this.cases.set(k, { tenantId: caseFile.tenantId, caseFile, stage: 'intake', events: [] });
  }

  /** Appends one event (as the worker's EventSink would). Idempotent on seq. */
  append(tenantId: string, eventIn: TrialEvent): void {
    const event = TrialEventSchema.parse(eventIn);
    const c = this.find(tenantId, event.caseId);
    if (!c) throw new Error('unknown case');
    if (c.events.some((e) => e.seq === event.seq)) return;
    c.events.push(event);
    c.events.sort((a, b) => a.seq - b.seq);
    c.stage = stageAfter(c.stage, event);
    if (event.type === 'verdict-written' && !c.verdict) c.verdict = event.payload.verdict;
  }

  /** Opens a case and stores a recorded trial stream for it at once. */
  seed(caseFile: CaseFile, events: readonly TrialEvent[]): void {
    this.open(caseFile);
    for (const e of events) this.append(caseFile.tenantId, e);
  }

  /** Seeds the two recorded fixture trials for a tenant (dev convenience). */
  seedFixtures(tenantId: string): void {
    const pairs: [string, TrialFixture][] = [
      ['case-nodegoat-sqli-001', 'nodegoat-sqli-001'],
      ['case-escalated-001', 'escalated-001'],
    ];
    for (const [id, name] of pairs) {
      this.seed(buildFakeCaseFile('fixture', tenantId, id), fixtureEvents(name, id));
    }
  }

  private replay(tenantId: string, caseId: string, replayMs: number): void {
    const events = fixtureEvents('nodegoat-sqli-001', caseId).filter((e) => e.seq > 0);
    let i = 0;
    const step = () => {
      if (this.closed) return;
      const e = events[i++];
      if (!e) return;
      this.append(tenantId, { ...e, at: new Date().toISOString() });
      const t = setTimeout(() => {
        this.timers.delete(t);
        step();
      }, replayMs);
      this.timers.add(t);
    };
    const t = setTimeout(() => {
      this.timers.delete(t);
      step();
    }, replayMs);
    this.timers.add(t);
  }

  forTenant(tenantId: string): TenantCases {
    return {
      create: (caseFile: CaseFile, _budget: Budget) => {
        void _budget;
        if (caseFile.tenantId !== tenantId) {
          return Promise.reject(new Error('case file belongs to another tenant'));
        }
        this.open(caseFile);
        this.append(tenantId, {
          schemaVersion: 1,
          caseId: caseFile.id,
          seq: 0,
          stage: 'intake',
          at: new Date().toISOString(),
          actor: 'stenographer',
          type: 'stage-entered',
          payload: {},
        });
        if (this.options.replayMs !== undefined) {
          this.replay(tenantId, caseFile.id, this.options.replayMs);
        }
        return Promise.resolve();
      },
      get: (caseId) => {
        const c = this.find(tenantId, caseId);
        if (!c) return Promise.resolve(null);
        const view: CaseView = { caseId, stage: c.stage, caseFile: c.caseFile };
        if (c.verdict) view.verdict = c.verdict;
        return Promise.resolve(view);
      },
      stage: (caseId) => Promise.resolve(this.find(tenantId, caseId)?.stage ?? null),
      events: (caseId, afterSeq, limit) => {
        const c = this.find(tenantId, caseId);
        if (!c) return Promise.resolve(null);
        const after = c.events.filter((e) => e.seq > afterSeq);
        return Promise.resolve(limit === undefined ? after : after.slice(0, limit));
      },
    };
  }

  isProvisioned(tenantId: string): Promise<boolean> {
    const list = this.options.provisionedTenants;
    return Promise.resolve(list === undefined || list.includes(tenantId));
  }

  close(): Promise<void> {
    this.closed = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    return Promise.resolve();
  }
}
