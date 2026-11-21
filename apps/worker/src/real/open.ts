/**
 * What `open-case` does with one discovery run. Wiring only: the decisions are discovery's.
 *
 * - The trial candidate (the one named, or the highest-ranked) is opened and queued (`startCase`).
 * - EVERY F3 hold of the scan (a dismissal rule matched at or above the escalation floor) is
 *   opened as a case of its own and flagged for a person (`openHeldCase`: review flag `f3-hold`,
 *   no stage job). A hold is never skipped, printed only, or dismissed. Its route
 *   (`person`, or `person-or-trial`: a person or a second Defense attempt) is in the flag detail.
 */
import { createHash } from 'node:crypto';
import { CaseId, type CaseFile } from '@affidavit/contracts';
import type { DiscoverCaseInput, HeldCandidate } from '@affidavit/discovery';
import type { Discover } from './intake.js';

export interface OpenCaseDeps {
  discover: Discover;
  /** `startCase` from @affidavit/db with the case budget. */
  startCase(caseFile: CaseFile): Promise<void>;
  /** `openHeldCase` from @affidavit/db with the case budget. True when the flag is new. */
  openHeldCase(caseFile: CaseFile, detail: string): Promise<boolean>;
}

export interface HeldCaseRecord {
  caseId: string;
  candidate: string;
  route: HeldCandidate['route'];
  wouldDismiss: HeldCandidate['wouldDismiss'];
  /** False when an earlier run already flagged it. */
  newlyFlagged: boolean;
}

export interface OpenCaseResult {
  /** The case queued for trial, if any. */
  opened: { caseId: string; candidate: string; scanPartial: boolean; withheld: number } | null;
  /** Every F3 hold, each recorded durably. */
  held: HeldCaseRecord[];
  /** Why no trial case was opened, in fixed text (outcome kind and discovery's reason codes). */
  why: string | null;
}

/** A hold's case id: the run's case id plus a short digest of the candidate id. */
export function holdCaseId(caseId: string, candidateId: string): CaseId {
  const digest = createHash('sha256').update(candidateId).digest('hex').slice(0, 16);
  return CaseId.parse(`${caseId}-hold-${digest}`);
}

/** The flag detail: arraignment's fixed fields only, never repository content. */
export function holdDetail(h: HeldCandidate): string {
  return `F3 hold: score ${h.score} is at or above the escalation floor, so ${h.wouldDismiss} was not applied (${h.detail}); route ${h.route}`;
}

export async function openCaseFromDiscovery(
  deps: OpenCaseDeps,
  input: Omit<DiscoverCaseInput, 'holdCaseId'>,
): Promise<OpenCaseResult> {
  const outcome = await deps.discover({
    ...input,
    holdCaseId: (candidate) => holdCaseId(input.caseId, candidate),
  });

  if (outcome.kind === 'unsupported' || outcome.kind === 'incomplete') {
    const why =
      outcome.kind === 'unsupported'
        ? `${outcome.reason}: ${outcome.detail}`
        : `${outcome.reason}, ${outcome.coverageLosses} coverage loss(es)`;
    return { opened: null, held: [], why: `${outcome.kind}: ${why}` };
  }

  // Holds first: a failure later (opening the trial case) must not lose them.
  const held: HeldCaseRecord[] = [];
  for (const h of outcome.holds) {
    if (h.caseFile === undefined) {
      // discoverCase assembles one for every hold when holdCaseId is given.
      throw new Error(`F3 hold ${h.candidateId} has no case file, so it cannot be recorded`);
    }
    held.push({
      caseId: h.caseFile.id,
      candidate: h.candidateId,
      route: h.route,
      wouldDismiss: h.wouldDismiss,
      newlyFlagged: await deps.openHeldCase(h.caseFile, holdDetail(h)),
    });
  }

  if (outcome.kind !== 'case-file') {
    const why =
      outcome.kind === 'review'
        ? `review: candidate ${outcome.candidateId} is held for review (F3), recorded with the holds`
        : outcome.kind === 'dismissed'
          ? `dismissed: arraignment dismissed the candidate (${outcome.dismissal.reason})`
          : 'not-found: no candidate to try';
    return { opened: null, held, why };
  }
  await deps.startCase(outcome.caseFile);
  return {
    opened: {
      caseId: outcome.caseFile.id,
      candidate: outcome.caseFile.candidate.id,
      scanPartial: outcome.scanPartial,
      withheld: outcome.withheld.length,
    },
    held,
    why: null,
  };
}
