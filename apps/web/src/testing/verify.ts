import type { TrialEvent, VerifyResult } from '@affidavit/contracts';

type Id = VerifyResult['patchExhibitId'];

/** A Judge VerifyResult for `patchExhibitId` with every check passing, unless overridden. */
export function verifyResult(
  patchExhibitId: string,
  overrides: Partial<VerifyResult> = {},
): VerifyResult {
  return {
    schemaVersion: 1,
    patchExhibitId: patchExhibitId as Id,
    familyFlipped: true,
    suitePassed: true,
    rescanClean: true,
    counterexamples: [],
    ...overrides,
  };
}

const renumber = (events: readonly TrialEvent[]): TrialEvent[] =>
  events.map((e, seq) => ({ ...e, seq }));

/** Test helper: the recorded trial with its `verify-result` events removed, seq renumbered. */
export function withoutVerify(events: readonly TrialEvent[]): TrialEvent[] {
  return renumber(events.filter((e) => e.type !== 'verify-result'));
}

/**
 * Test helper: replaces the trial's `verify-result` events with one per given result, recorded
 * the way `packages/trial` records them (actor judge, stage verify, before the verify stage
 * exits), and renumbers seq so the stream stays contiguous. `as` overrides the actor or stage to
 * build a forged check.
 */
export function withVerify(
  events: readonly TrialEvent[],
  results: readonly VerifyResult[],
  as: { actor?: string; stage?: string } = {},
): TrialEvent[] {
  const rest = events.filter((e) => e.type !== 'verify-result');
  let at = rest.findIndex((e) => e.type === 'stage-exited' && e.stage === 'verify');
  if (at < 0) at = rest.length;
  const base = rest[at] ?? rest.at(-1);
  if (!base) throw new Error('empty trial');
  const inserted = results.map(
    (result) =>
      ({
        schemaVersion: 1,
        caseId: base.caseId,
        seq: 0,
        stage: as.stage ?? 'verify',
        at: base.at,
        actor: as.actor ?? 'judge',
        type: 'verify-result',
        payload: { result },
      }) as unknown as TrialEvent,
  );
  return renumber([...rest.slice(0, at), ...inserted, ...rest.slice(at)]);
}
