import { CaseFile, CaseId, RepoId, TenantId, samples } from '@affidavit/contracts';
import type { DiscoverCaseInput, DiscoverCaseOutcome, HeldCandidate } from '@affidavit/discovery';
import { describe, expect, it } from 'vitest';
import { holdCaseId, holdDetail, openCaseFromDiscovery, type OpenCaseDeps } from './open.js';

const stored = CaseFile.parse(samples.CaseFile);
const input = {
  caseId: CaseId.parse('case-open-1'),
  tenantId: TenantId.parse(stored.tenantId),
  repo: RepoId.parse(stored.target.repo),
  source: 'https://git.example/r.git',
  commit: stored.target.commit,
};

function heldFor(candidateId: string, discoverInput: DiscoverCaseInput): HeldCandidate {
  const id = discoverInput.holdCaseId?.(candidateId);
  return {
    candidateId,
    score: 0.8,
    wouldDismiss: 'unreachable',
    route: 'person-or-trial',
    detail: 'the map found no path to it (no-route)',
    ...(id === undefined
      ? {}
      : { caseFile: { ...stored, id, candidate: { ...stored.candidate, id: candidateId } } }),
  };
}

function recorder(outcome: (i: DiscoverCaseInput) => DiscoverCaseOutcome) {
  const started: string[] = [];
  const flagged: { caseId: string; detail: string }[] = [];
  const deps: OpenCaseDeps = {
    discover: (i) => Promise.resolve(outcome(i)),
    startCase: (cf) => {
      started.push(cf.id);
      return Promise.resolve();
    },
    openHeldCase: (cf, detail) => {
      flagged.push({ caseId: cf.id, detail });
      return Promise.resolve(true);
    },
  };
  return { deps, started, flagged };
}

describe('open-case records every F3 hold', () => {
  it('opens the trial case and records each hold of the same scan for a person', async () => {
    const r = recorder((i) => ({
      kind: 'case-file',
      caseFile: stored,
      withheld: [],
      scanPartial: false,
      holds: [heldFor('cand-held-a', i), heldFor('cand-held-b', i)],
    }));
    const out = await openCaseFromDiscovery(r.deps, input);
    expect(r.started).toEqual([stored.id]);
    expect(r.flagged.map((f) => f.caseId)).toEqual([
      holdCaseId(input.caseId, 'cand-held-a'),
      holdCaseId(input.caseId, 'cand-held-b'),
    ]);
    for (const f of r.flagged) {
      expect(f.detail).toContain('F3 hold');
      expect(f.detail).toContain('route person-or-trial');
    }
    expect(out.held.map((h) => h.candidate)).toEqual(['cand-held-a', 'cand-held-b']);
    expect(out.opened?.caseId).toBe(stored.id);
  });

  it.each(['review', 'not-found', 'dismissed'] as const)(
    'still records the holds when the outcome is %s, and opens no trial case',
    async (kind) => {
      const r = recorder((i): DiscoverCaseOutcome => {
        const holds = [heldFor('cand-held', i)];
        if (kind === 'review') {
          return {
            kind,
            candidateId: 'cand-held',
            wouldDismiss: 'unreachable',
            route: 'person-or-trial',
            detail: 'held',
            holds,
          };
        }
        if (kind === 'not-found') return { kind, candidateId: null, holds };
        return {
          kind,
          dismissal: { schemaVersion: 1, candidateId: 'c', reason: 'unreachable', detail: 'd' },
          holds,
        };
      });
      const out = await openCaseFromDiscovery(r.deps, input);
      expect(r.started).toEqual([]);
      expect(r.flagged).toHaveLength(1);
      expect(out.held).toHaveLength(1);
      expect(out.why).toContain(kind);
    },
  );

  it('refuses rather than drop a hold it cannot record', async () => {
    const r = recorder(() => ({
      kind: 'not-found',
      candidateId: null,
      holds: [{ ...heldFor('cand-held', { ...input }), caseFile: undefined }],
    }));
    await expect(openCaseFromDiscovery(r.deps, input)).rejects.toThrow(/cannot be recorded/);
  });

  it('records the holds before opening the trial case, so a later failure keeps them', async () => {
    const r = recorder((i) => ({
      kind: 'case-file',
      caseFile: stored,
      withheld: [],
      scanPartial: false,
      holds: [heldFor('cand-held', i)],
    }));
    r.deps.startCase = () => Promise.reject(new Error('database down'));
    await expect(openCaseFromDiscovery(r.deps, input)).rejects.toThrow('database down');
    expect(r.flagged).toHaveLength(1);
  });

  it('gives each hold a stable case id of its own and a detail of fixed fields', () => {
    expect(holdCaseId(input.caseId, 'x')).toBe(holdCaseId(input.caseId, 'x'));
    expect(holdCaseId(input.caseId, 'x')).not.toBe(holdCaseId(input.caseId, 'y'));
    expect(holdCaseId(input.caseId, 'x')).toMatch(/^case-open-1-hold-[0-9a-f]{16}$/);
    expect(holdDetail(heldFor('c', input))).toBe(
      'F3 hold: score 0.8 is at or above the escalation floor, so unreachable was not applied (the map found no path to it (no-route)); route person-or-trial',
    );
  });
});
