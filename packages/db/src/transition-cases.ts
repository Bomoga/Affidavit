import { STAGE_TRANSITIONS, type CaseStage } from '@affidavit/contracts';

/**
 * Shared transition table. Each entry says how to reach the `from` stage (a legal path from
 * intake), the case's score and floor, and whether the transition must be accepted. A store
 * implementation (the fake or Postgres) is correct when every entry behaves as listed.
 */
export interface TransitionCase {
  name: string;
  juryEnabled?: boolean;
  score?: number;
  floor?: number;
  /** Stages entered after intake, in order, to reach the starting state. */
  path: readonly CaseStage[];
  to: CaseStage;
  ok: boolean;
}

const P = {
  intake: [],
  map: ['map'],
  arraign: ['map', 'arraign'],
  defense: ['map', 'arraign', 'defense'],
  prosecution: ['map', 'arraign', 'defense', 'prosecution'],
  remedy: ['map', 'arraign', 'defense', 'prosecution', 'remedy'],
  verify: ['map', 'arraign', 'defense', 'prosecution', 'remedy', 'verify'],
  jury: ['map', 'arraign', 'defense', 'prosecution', 'remedy', 'verify', 'jury'],
  verdict: ['map', 'arraign', 'defense', 'prosecution', 'remedy', 'verify', 'jury', 'verdict'],
  dismissed: ['map', 'arraign', 'dismissed'],
  escalated: ['map', 'arraign', 'defense', 'escalated'],
} as const satisfies Record<CaseStage, readonly CaseStage[]>;

const stages = Object.keys(STAGE_TRANSITIONS) as CaseStage[];

/** Every pair the table forbids must be rejected, whatever the rules a table cannot express. */
const forbiddenPairs: TransitionCase[] = stages.flatMap((from) =>
  stages
    .filter((to) => !STAGE_TRANSITIONS[from].includes(to))
    .map((to) => ({
      name: `${from} -> ${to} is not in the table`,
      path: P[from],
      // Reaching `dismissed` is only possible below the floor (F3), so its path needs a low score.
      ...(from === 'dismissed' ? { score: 0.5, floor: 0.7 } : {}),
      to,
      ok: false,
    })),
);

const appeal = ['remedy', 'verify'] as const;
const verifyAfter1Appeal = [...P.verify, ...appeal] as const;
const verifyAfter2Appeals = [...P.verify, ...appeal, ...appeal] as const;

/**
 * Every pair in STAGE_TRANSITIONS must be accepted from a state where the extra rules allow it
 * (low score for defense to dismissed, jury off for verify to verdict).
 */
const legalPairs: TransitionCase[] = stages.flatMap((from) =>
  STAGE_TRANSITIONS[from].map((to) => ({
    name: `${from} -> ${to} is legal`,
    path: P[from],
    ...(to === 'dismissed' ? { score: 0.5, floor: 0.7 } : {}),
    ...(from === 'verify' && to === 'verdict' ? { juryEnabled: false } : {}),
    to,
    ok: true,
  })),
);

/** F3 (CR-3): every way into `dismissed` is refused at or above the floor, allowed below it. */
const f3Sources = ['arraign', 'defense', 'prosecution'] as const;
const f3Cases: TransitionCase[] = f3Sources.flatMap((from) => [
  {
    name: `${from} -> dismissed below the floor`,
    path: P[from],
    score: 0.5,
    floor: 0.7,
    to: 'dismissed' as const,
    ok: true,
  },
  {
    name: `${from} -> dismissed at the floor is rejected (F3)`,
    path: P[from],
    score: 0.7,
    floor: 0.7,
    to: 'dismissed' as const,
    ok: false,
  },
  {
    name: `${from} -> dismissed above the floor is rejected (F3)`,
    path: P[from],
    score: 0.95,
    floor: 0.7,
    to: 'dismissed' as const,
    ok: false,
  },
]);

export const transitionCases: readonly TransitionCase[] = [
  ...forbiddenPairs,
  ...legalPairs,
  // F3: arraign, defense and prosecution to dismissed only below the escalation floor.
  ...f3Cases,
  // Appeals.
  { name: 'verify -> remedy (first appeal)', path: P.verify, to: 'remedy', ok: true },
  { name: 'verify -> remedy (second appeal)', path: verifyAfter1Appeal, to: 'remedy', ok: true },
  {
    name: 'verify -> remedy (third appeal) is rejected',
    path: verifyAfter2Appeals,
    to: 'remedy',
    ok: false,
  },
  // Jury enabled (default).
  { name: 'verify -> jury with jury enabled', path: P.verify, to: 'jury', ok: true },
  {
    name: 'verify -> verdict with jury enabled and appeals left is rejected',
    path: P.verify,
    to: 'verdict',
    ok: false,
  },
  {
    name: 'verify -> verdict with jury enabled and appeals exhausted',
    path: verifyAfter2Appeals,
    to: 'verdict',
    ok: true,
  },
  { name: 'verify -> escalated', path: P.verify, to: 'escalated', ok: true },
  // Jury disabled.
  {
    name: 'verify -> jury with jury disabled is rejected',
    juryEnabled: false,
    path: P.verify,
    to: 'jury',
    ok: false,
  },
  {
    name: 'verify -> verdict with jury disabled',
    juryEnabled: false,
    path: P.verify,
    to: 'verdict',
    ok: true,
  },
];
