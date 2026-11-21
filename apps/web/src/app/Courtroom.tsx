import type { CaseStage } from '@affidavit/contracts';
import type { CaseView } from '../model/caseView.js';

// Courtroom stage indicator (a light first cut of L3-13). Original roles only, shown as
// plain-text nameplates: no logos, mascots or brand characters. All text here is static; the
// only input from the record is which stage the last event was in.

export type Seat =
  'stenographer' | 'defense' | 'prosecution' | 'remedy' | 'judge' | 'jury' | 'bench' | 'reviewer';

export const SEATS: readonly { seat: Seat; nameplate: string }[] = [
  { seat: 'stenographer', nameplate: 'Stenographer' },
  { seat: 'defense', nameplate: 'Defense' },
  { seat: 'prosecution', nameplate: 'Prosecution' },
  { seat: 'remedy', nameplate: 'Remedy' },
  { seat: 'judge', nameplate: 'Judge' },
  { seat: 'jury', nameplate: 'Jury box' },
  { seat: 'bench', nameplate: 'Bench' },
  { seat: 'reviewer', nameplate: 'Human reviewer' },
];

/** Every case stage maps to one seat holding the floor and one plain sentence. */
export const COURTROOM_STATE: Record<CaseStage, { seat: Seat; text: string }> = {
  intake: { seat: 'stenographer', text: 'The stenographer files the repository and commit.' },
  map: { seat: 'stenographer', text: 'The stenographer maps the code with deterministic tools.' },
  arraign: { seat: 'stenographer', text: 'The stenographer reads the candidate charges.' },
  defense: { seat: 'defense', text: 'The Defense files a witness for the Judge to run.' },
  prosecution: {
    seat: 'prosecution',
    text: 'The Prosecution attacks the claim with its own exhibits.',
  },
  remedy: { seat: 'remedy', text: 'Remedy drafts the smallest patch that fixes the cause.' },
  verify: { seat: 'judge', text: 'The Judge runs the patch against the witness and its family.' },
  jury: {
    seat: 'jury',
    text: 'The jury weighs questions the Judge cannot settle by running code.',
  },
  verdict: { seat: 'bench', text: 'The bench records the verdict.' },
  dismissed: { seat: 'bench', text: 'The bench closes the case with a recorded reason.' },
  escalated: { seat: 'reviewer', text: 'The case waits for a person to review it.' },
};

/** The stage of the latest docket entry, or undefined before any event arrives. */
export function currentStage(view: CaseView): CaseStage | undefined {
  return view.docket.at(-1)?.stage;
}

export function Courtroom({ view }: { view: CaseView }) {
  const stage = currentStage(view);
  // An escalated case sits with the human reviewer whatever stage its last event names.
  const state = view.humanReview
    ? COURTROOM_STATE.escalated
    : stage
      ? COURTROOM_STATE[stage]
      : undefined;
  return (
    <section className="courtroom" aria-labelledby="courtroom-heading">
      <h2 id="courtroom-heading">Courtroom</h2>
      <p className="courtroom-now">
        <span className="label">Who has the floor</span>
        <br />
        {state ? state.text : 'The court has not opened this case yet.'}
      </p>
      <ol className="seats" aria-label="Seats in the courtroom">
        {SEATS.map(({ seat, nameplate }) => {
          const active = state?.seat === seat;
          return (
            <li
              key={seat}
              className={active ? 'seat seat--active' : 'seat'}
              {...(active ? { 'aria-current': 'step' as const } : {})}
            >
              {nameplate}
              {active ? <span className="sr-only"> (has the floor)</span> : null}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
