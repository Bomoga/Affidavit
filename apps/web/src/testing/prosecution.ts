import type { TrialEvent } from '@affidavit/contracts';

/**
 * Test helper: splices Prosecution events into a recorded trial, after the last event of the
 * prosecution stage, and renumbers seq so the stream stays contiguous. The events have the same
 * shape `packages/trial` emits (exhibit-submitted, exhibit-result, objection).
 */
export function withProsecution(
  events: readonly TrialEvent[],
  options: { counterexampleId: string; admissible?: boolean; claim?: string },
): TrialEvent[] {
  let at = -1;
  events.forEach((e, i) => {
    if (e.stage === 'prosecution') at = i;
  });
  const base = events[at];
  if (!base) throw new Error('fixture has no prosecution stage');
  const admissible = options.admissible ?? true;
  const make = (type: string, actor: string, payload: unknown) =>
    ({
      schemaVersion: 1,
      caseId: base.caseId,
      seq: 0,
      stage: 'prosecution',
      at: base.at,
      actor,
      type,
      payload,
    }) as unknown as TrialEvent;
  const inserted: TrialEvent[] = [
    make('exhibit-submitted', 'prosecution', {
      exhibitId: options.counterexampleId,
      kind: 'counterexample',
    }),
    make('exhibit-result', 'judge', {
      result: {
        schemaVersion: 1,
        exhibitId: options.counterexampleId,
        admissible,
        ...(admissible ? {} : { rejectedBy: 'differential' }),
        runs: [],
        vulnPass: admissible,
        safeVariantFail: admissible,
        egressAttempts: 0,
        familyResults: [],
        passed: admissible,
        durationMs: 10,
      },
    }),
    ...(admissible
      ? [
          make('objection', 'prosecution', {
            exhibitId: options.counterexampleId,
            claim: options.claim ?? 'The fix must also stop this counterexample family.',
          }),
        ]
      : []),
  ];
  return [...events.slice(0, at + 1), ...inserted, ...events.slice(at + 1)].map((e, seq) => ({
    ...e,
    seq,
  }));
}
