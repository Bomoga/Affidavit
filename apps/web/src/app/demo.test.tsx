import { CaseStage, TrialEvent, type VerifyResult } from '@affidavit/contracts';
import { readFixtureJson } from '@affidavit/testing';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { checkAccessibility } from '../a11y/check.js';
import { buildCaseView } from '../model/caseView.js';
import { withVerify, withoutVerify } from '../testing/verify.js';
import { CaseFile } from './CaseFile.js';
import { COURTROOM_STATE, SEATS } from './Courtroom.js';
import { APP_CSS } from './styles.js';
import { renderApp, settled } from './testUtils.js';

afterEach(cleanup);

const GATE = TrialEvent.array().parse(readFixtureJson('trials/nodegoat-sqli-001.events.json'));
const ESCALATED = TrialEvent.array().parse(readFixtureJson('trials/escalated-001.events.json'));
/** The gate trial as it was before CR-1: no Judge verify-result in the stream. */
const UNCHECKED = withoutVerify(GATE);
const PENDING_NOTE =
  'Judge verification event not yet recorded. Nothing in the record says the fix failed.';

const accepted: VerifyResult = {
  schemaVersion: 1,
  patchExhibitId: 'exhibit-patch-001' as VerifyResult['patchExhibitId'],
  familyFlipped: true,
  suitePassed: true,
  rescanClean: true,
  counterexamples: [],
};

describe('awaiting Judge verification (no verify-result recorded)', () => {
  it('marks a gate trial with no verify-result as awaiting a recorded check, not as a failed fix', () => {
    const view = buildCaseView(UNCHECKED);
    expect(view.status).toBe('unverified');
    expect(view.stamp).toBeNull();
    expect(view.awaitingVerification).toBe(true);
    const patch = view.exhibits.find((x) => x.id === 'exhibit-patch-001');
    expect(patch?.judged).toBe(false);
    expect(patch?.admitted).toBe(false);
  });

  it('is false once the Judge accepts the patch', () => {
    const view = buildCaseView(withVerify(UNCHECKED, [accepted]));
    expect(view.awaitingVerification).toBe(false);
    expect(view.stamp).toBe('VERIFIED');
    expect(buildCaseView(GATE).stamp).toBe('VERIFIED');
  });

  it('is false when the recorded Judge verify-result fails', () => {
    const view = buildCaseView(withVerify(UNCHECKED, [{ ...accepted, rescanClean: false }]));
    expect(view.awaitingVerification).toBe(false);
    expect(view.stamp).toBeNull();
    expect(view.headline).toBe('Fix claimed, not yet confirmed by the recorded evidence');
  });

  it('is false when the Judge rejected the cited patch', () => {
    const rejected: TrialEvent[] = [
      ...UNCHECKED.slice(0, -1),
      {
        schemaVersion: 1,
        caseId: GATE[0]?.caseId ?? '',
        seq: 100,
        stage: 'verify',
        at: '2026-11-05T12:00:17.500Z',
        actor: 'judge',
        type: 'exhibit-inadmissible',
        payload: { exhibitId: 'exhibit-patch-001', rejectedBy: 'suite-fails' },
      } as TrialEvent,
      { ...(UNCHECKED.at(-1) as TrialEvent), seq: 101 },
    ];
    const view = buildCaseView(TrialEvent.array().parse(rejected));
    expect(view.status).toBe('unverified');
    expect(view.awaitingVerification).toBe(false);
    expect(view.headline).toBe('Fix claimed, not yet confirmed by the recorded evidence');
  });

  it('is false on the escalated fixture', () => {
    expect(buildCaseView(ESCALATED).awaitingVerification).toBe(false);
  });

  it('says so under the stamp on a case page with no verify-result, and never shows VERIFIED', () => {
    render(<CaseFile view={buildCaseView(UNCHECKED)} />);
    const h1 = screen.getByRole('heading', { level: 1 });
    expect(h1.textContent).toContain('not yet confirmed by a recorded Judge check');
    expect(screen.getByText(PENDING_NOTE)).toBeTruthy();
    expect(screen.getByText('UNVERIFIED')).toBeTruthy();
    expect(screen.queryByText('VERIFIED')).toBeNull();
    const patch = screen.getByRole('button', { name: /exhibit-patch-001/ });
    expect(patch.textContent).toContain('Judge check not recorded');
    expect(patch.textContent).not.toContain('not admitted');
    fireEvent.click(patch);
    expect(screen.getByText(/has not ruled on this patch in the record yet/)).toBeTruthy();
  });

  it('shows VERIFIED on the gate case page and no pending note in the case list (CR-1)', async () => {
    renderApp('/cases/nodegoat-sqli-001');
    const h1 = await settled();
    expect(h1.textContent).toContain('Verified');
    expect(screen.getByText('VERIFIED')).toBeTruthy();
    expect(screen.queryByText('UNVERIFIED')).toBeNull();
    expect(screen.queryByText(PENDING_NOTE)).toBeNull();
    const patch = screen.getByRole('button', { name: /exhibit-patch-001/ });
    expect(patch.textContent).toContain('admitted');
    cleanup();
    renderApp('/');
    const list = await screen.findByRole('list', { name: 'Case files' });
    expect(within(list).queryAllByText(PENDING_NOTE)).toHaveLength(0);
  });

  it('drops the note when the stamp is earned', () => {
    render(<CaseFile view={buildCaseView(withVerify(UNCHECKED, [accepted]))} />);
    expect(screen.queryByText(PENDING_NOTE)).toBeNull();
  });
});

describe('differential proof line', () => {
  it('shows the recorded vulnerable and safe-variant outcome for an admitted witness', () => {
    const witness = buildCaseView(GATE).exhibits.find((x) => x.id === 'exhibit-witness-001');
    expect(witness?.proof).toEqual({
      vulnPass: true,
      safeVariantFail: true,
      family: { passed: 3, total: 3 },
    });
    render(<CaseFile view={buildCaseView(GATE)} />);
    fireEvent.click(screen.getByRole('button', { name: /exhibit-witness-001/ }));
    expect(screen.getByText('Fails on the known-safe variant')).toBeTruthy();
    expect(screen.getByText('3 of 3')).toBeTruthy();
  });
});

describe('courtroom stage indicator', () => {
  it('maps every case stage to a seat that has a plain-text nameplate', () => {
    const seats = new Set(SEATS.map((s) => s.seat));
    for (const stage of CaseStage.options) {
      const state = COURTROOM_STATE[stage];
      expect(seats.has(state.seat)).toBe(true);
      expect(state.text.length).toBeGreaterThan(0);
    }
  });

  it('gives the floor to the bench on the gate case and to the human reviewer when escalated', () => {
    render(<CaseFile view={buildCaseView(GATE)} />);
    const seats = screen.getByRole('list', { name: 'Seats in the courtroom' });
    const current = seats.querySelector('[aria-current="step"]');
    expect(current?.textContent).toContain('Bench');
    expect(seats.querySelectorAll('[aria-current]')).toHaveLength(1);
    cleanup();
    render(<CaseFile view={buildCaseView(ESCALATED)} />);
    const again = screen.getByRole('list', { name: 'Seats in the courtroom' });
    expect(again.querySelector('[aria-current="step"]')?.textContent).toContain('Human reviewer');
  });

  it('shows no images and passes the in-repo accessibility check', () => {
    for (const events of [GATE, ESCALATED]) {
      const { container: c } = render(
        <>
          <header />
          <main>
            <CaseFile view={buildCaseView(events)} />
          </main>
          <footer />
        </>,
      );
      expect(c.querySelectorAll('img, svg')).toHaveLength(0);
      expect(checkAccessibility(c, APP_CSS)).toEqual([]);
      cleanup();
    }
  });
});
