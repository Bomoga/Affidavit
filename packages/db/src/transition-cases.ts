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
      to,
      ok: false,
    })),
);

const appeal = ['remedy', 'verify'] as const;
const verifyAfter1Appeal = [...P.verify, ...appeal] as const;
const verifyAfter2Appeals = [...P.verify, ...appeal, ...appeal] as const;

export const transitionCases: readonly TransitionCase[] = [
  ...forbiddenPairs,
  { name: 'intake -> map', path: P.intake, to: 'map', ok: true },
  { name: 'map -> arraign', path: P.map, to: 'arraign', ok: true },
  { name: 'arraign -> defense', path: P.arraign, to: 'defense', ok: true },
  { name: 'arraign -> dismissed', path: P.arraign, to: 'dismissed', ok: true },
  { name: 'defense -> prosecution', path: P.defense, to: 'prosecution', ok: true },
  { name: 'defense -> escalated', path: P.defense, to: 'escalated', ok: true },
  { name: 'prosecution -> remedy', path: P.prosecution, to: 'remedy', ok: true },
  { name: 'remedy -> verify', path: P.remedy, to: 'verify', ok: true },
  { name: 'jury -> verdict', path: P.jury, to: 'verdict', ok: true },
  // F3: defense to dismissed only below the escalation floor.
  {
    name: 'defense -> dismissed below the floor',
    path: P.defense,
    score: 0.5,
    floor: 0.7,
    to: 'dismissed',
    ok: true,
  },
  {
    name: 'defense -> dismissed at the floor is rejected (F3)',
    path: P.defense,
    score: 0.7,
    floor: 0.7,
    to: 'dismissed',
    ok: false,
  },
  {
    name: 'defense -> dismissed above the floor is rejected (F3)',
    path: P.defense,
    score: 0.95,
    floor: 0.7,
    to: 'dismissed',
    ok: false,
  },
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
