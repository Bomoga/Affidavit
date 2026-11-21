import { Ballot, PatchExhibit, Witness } from '@affidavit/contracts';
import { checkCounterexampleSubmission, type CounterexampleSubmission } from './counterexample.js';
import type { ModelRole } from './roles.js';

/**
 * What each role's agent may submit, cut from the contract schemas. Fields the system decides
 * (ids, hashes, authorship, schema version, juror identity, and anything about pass or fail) are
 * not in these shapes: unknown keys are stripped, so an agent cannot set them. Code builds the
 * full contract object around a validated submission.
 */
export const WitnessSubmission = Witness.pick({ template: true, params: true });
export type WitnessSubmission = ReturnType<typeof WitnessSubmission.parse>;

/**
 * Prosecution submits parameter choices drawn from the Defense witness family (see
 * counterexample.ts), never code. Code, id, hash, author and kind are built in code.
 */
export type { CounterexampleSubmission };

/** Remedy submits only the diff. Files touched and lines changed are computed from it in code. */
export const PatchSubmission = PatchExhibit.pick({ diff: true });
export type PatchSubmission = ReturnType<typeof PatchSubmission.parse>;

const BALLOT_SYSTEM_FIELDS = {
  schemaVersion: true,
  jurorId: true,
  model: true,
  mandate: true,
  inputVariant: true,
} as const;
/** One agent-submittable shape per ballot question. Also the source of the submit_ballot tool schema. */
export const BALLOT_OPTIONS = Ballot.options.map((o) => o.omit(BALLOT_SYSTEM_FIELDS));
export type BallotSubmission = ReturnType<(typeof BALLOT_OPTIONS)[number]['parse']>;

export type SubmissionCheck<T> = { ok: true; value: T } | { ok: false; errors: string[] };

export interface SubmissionSpec<R extends ModelRole, T> {
  readonly role: R;
  /** Must equal the rendered prompt's `outputSchemaRef`. */
  readonly schemaRef: 'Witness' | 'Exhibit' | 'Ballot';
  readonly exhibitKind: 'witness' | 'counterexample' | 'patch' | 'ballot';
  check(value: unknown): SubmissionCheck<T>;
}

interface SafeParser<T> {
  safeParse(
    v: unknown,
  ):
    | { success: true; data: T }
    | { success: false; error: { issues: { path: PropertyKey[]; message: string }[] } };
}

function checker<T>(schema: SafeParser<T>): (v: unknown) => SubmissionCheck<T> {
  return (value) => {
    const r = schema.safeParse(value);
    if (r.success) return { ok: true, value: r.data };
    return {
      ok: false,
      errors: r.error.issues.map(
        (i) => `${i.path.map(String).join('.') || '(root)'}: ${i.message}`,
      ),
    };
  };
}

function checkBallot(value: unknown): SubmissionCheck<BallotSubmission> {
  let firstErrors: string[] | undefined;
  for (const option of BALLOT_OPTIONS) {
    const r = checker<BallotSubmission>(option)(value);
    if (r.ok) return r;
    const q = (value as { question?: unknown } | null)?.question;
    if (q === option.shape.question.value || firstErrors === undefined) firstErrors = r.errors;
  }
  return { ok: false, errors: firstErrors ?? ['(root): not a ballot'] };
}

export const SUBMISSIONS = {
  defense: {
    role: 'defense',
    schemaRef: 'Witness',
    exhibitKind: 'witness',
    check: checker<WitnessSubmission>(WitnessSubmission),
  },
  prosecution: {
    role: 'prosecution',
    schemaRef: 'Exhibit',
    exhibitKind: 'counterexample',
    check: checkCounterexampleSubmission,
  },
  remedy: {
    role: 'remedy',
    schemaRef: 'Exhibit',
    exhibitKind: 'patch',
    check: checker<PatchSubmission>(PatchSubmission),
  },
  juror: { role: 'juror', schemaRef: 'Ballot', exhibitKind: 'ballot', check: checkBallot },
} as const satisfies {
  defense: SubmissionSpec<'defense', WitnessSubmission>;
  prosecution: SubmissionSpec<'prosecution', CounterexampleSubmission>;
  remedy: SubmissionSpec<'remedy', PatchSubmission>;
  juror: SubmissionSpec<'juror', BallotSubmission>;
};
