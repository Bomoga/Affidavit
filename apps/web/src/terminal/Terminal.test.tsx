import type { TrialEvent } from '@affidavit/contracts';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkAccessibility } from '../a11y/check.js';
import { APP_CSS } from '../app/styles.js';
import {
  SAMPLE_EMPTY,
  SAMPLE_FAILED,
  SAMPLE_MID_TRIAL,
  SAMPLE_VERIFIED,
  SAMPLES,
} from './sampleView.js';
import { Terminal, TerminalWithScrubber } from './Terminal.js';
import { TERMINAL_CSS } from './terminalCss.js';
import type { TerminalView } from './types.js';

// The scrubber test stands in for the model: the view it returns says how many events it was
// given, and has one bubble per event so stepping forward adds a bubble.
vi.mock('./model.js', () => ({
  buildTerminalView: (events: readonly unknown[]): TerminalView => ({
    ...SAMPLE_VERIFIED,
    eventCount: events.length,
    lastSeq: Math.max(0, events.length - 1),
    tape: SAMPLE_VERIFIED.tape.slice(0, events.length),
    bubbles: SAMPLE_VERIFIED.bubbles.slice(0, events.length),
  }),
}));

afterEach(cleanup);

const PANELS = [
  'Stages',
  'Evidence',
  'Verify',
  'Diff',
  'Arguments',
  'Jury',
  'Cost',
  'Tape',
  'Verdict',
];
const AGENT_LABEL: Record<string, string> = {
  defense: 'Defense',
  prosecution: 'Prosecution',
  remedy: 'Remedy',
  judge: 'Judge',
  juror: 'Juror',
  stenographer: 'Stenographer',
};

function page(view: TerminalView) {
  return render(
    <>
      <header />
      <main>
        <Terminal view={view} />
      </main>
      <footer />
    </>,
  );
}

function panel(name: string): HTMLElement {
  return screen.getByRole('region', { name });
}

describe.each(Object.entries(SAMPLES))('terminal, %s sample', (_name, view) => {
  it('shows all nine panels, each a named region with its heading', () => {
    page(view);
    for (const name of PANELS) {
      expect(within(panel(name)).getByRole('heading', { level: 2, name })).toBeTruthy();
    }
    expect(screen.getAllByRole('heading', { level: 2 })).toHaveLength(9);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toContain('trial terminal');
  });

  it('renders every bubble with its agent label, title, body, cites and quote', () => {
    const { container } = page(view);
    const bubbles = [...container.querySelectorAll('.term-bubble')];
    expect(bubbles).toHaveLength(view.bubbles.length);
    for (const b of view.bubbles) {
      const el = bubbles.find((x) => x.textContent.includes(b.body));
      expect(el, b.id).toBeTruthy();
      const chip = el?.querySelector('.term-chip')?.textContent ?? '';
      expect(chip).toContain(AGENT_LABEL[b.agent]);
      if (b.agentDetail) expect(chip).toContain(b.agentDetail);
      expect(el?.textContent).toContain(b.title);
      for (const id of b.cites) expect(el?.textContent).toContain(id);
      if (b.quote) {
        const quote = el?.querySelector('blockquote');
        expect(quote?.textContent).toContain('Recorded text');
        expect(quote?.textContent).toContain(b.quote);
      }
      // Pinned to its anchor panel.
      expect(el?.closest('section')?.className).toContain(`term-panel--${b.anchor}`);
    }
  });

  it('passes the in-repo accessibility check with no images', () => {
    const { container } = page(view);
    expect(container.querySelectorAll('img, svg, canvas')).toHaveLength(0);
    expect(checkAccessibility(container, APP_CSS + TERMINAL_CSS)).toEqual([]);
  });

  it('has no em dashes in its copy', () => {
    const { container } = page(view);
    expect(container.textContent).not.toContain('—');
    expect(TERMINAL_CSS).not.toContain('—');
  });

  it('gives every pass or fail cell a text equivalent', () => {
    const { container } = page(view);
    for (const cell of container.querySelectorAll('.term-res'))
      expect(cell.textContent).toMatch(/^(PASS|FAIL)$/);
    for (const cell of container.querySelectorAll('.term-cell'))
      expect(cell.textContent).toMatch(/parameter \d+ (pass|fail)/);
    for (const cell of container.querySelectorAll('.term-norun'))
      expect(cell.textContent).toContain('not run');
  });
});

describe('terminal panels', () => {
  it('shows the status line and the stage rail with one active stage', () => {
    page(SAMPLE_VERIFIED);
    const status = screen.getByRole('heading', { level: 1 }).parentElement as HTMLElement;
    expect(status.textContent).toContain('case-nodegoat-sqli-001');
    expect(status.textContent).toContain('VERIFIED');
    expect(status.textContent).toContain('Events22');
    expect(status.textContent).toContain('Last seq21');
    const items = within(panel('Stages')).getAllByRole('listitem');
    expect(
      items.slice(0, 11).map((li) => li.querySelector('.term-rail-name')?.textContent),
    ).toEqual([
      'Intake',
      'Map',
      'Arraign',
      'Defense',
      'Prosecution',
      'Remedy',
      'Verify',
      'Jury',
      'Verdict',
      'Dismissed',
      'Escalated',
    ]);
    const current = panel('Stages').querySelectorAll('[aria-current="step"]');
    expect(current).toHaveLength(1);
    expect(current[0]?.textContent).toContain('active');
    expect(current[0]?.textContent).toContain('Verdict');
  });

  it('shows the run matrix, the differential line and the family strip for a witness', () => {
    page(SAMPLE_VERIFIED);
    const evidence = panel('Evidence');
    const matrix = within(evidence).getAllByRole('table')[0] as HTMLElement;
    expect(matrix.querySelector('caption')?.textContent).toContain('exhibit-witness-001');
    const rows = within(matrix).getAllByRole('row').slice(2);
    expect(rows).toHaveLength(3);
    // attempt, vulnerable (res, exit, ms), safe (res, exit, ms), patched not run
    expect(rows[0]?.textContent).toBe('1PASS0417FAIL1397·not run');
    expect(evidence.textContent).toContain('vulnerable: pass, safe: fail');
    expect(evidence.textContent).toContain('5 of 5 pass');
    expect(evidence.querySelectorAll('.term-exhibit')).toHaveLength(3);
  });

  it('says a pending exhibit is not a rejection and names the rule for a rejected one', () => {
    page(SAMPLE_MID_TRIAL);
    expect(panel('Evidence').textContent).toContain('Pending is not a rejection.');
    cleanup();
    page(SAMPLE_FAILED);
    const evidence = panel('Evidence');
    expect(evidence.textContent).toContain(
      'The test did not give the same result on all three repeat runs. Rule: stable-3of3.',
    );
    expect(evidence.textContent).toContain('vulnerable: pass, safe: no safe variant on record');
  });

  it('shows the diff with line numbers, markers and counts', () => {
    page(SAMPLE_VERIFIED);
    const diff = panel('Diff');
    expect(diff.querySelector('.term-bar-meta')?.textContent).toContain('2 files +9 -4');
    const view = SAMPLE_VERIFIED.diff;
    expect(diff.querySelectorAll('.term-diff-line--add')).toHaveLength(view?.added ?? -1);
    expect(diff.querySelectorAll('.term-diff-line--del')).toHaveLength(view?.removed ?? -1);
    expect(diff.querySelectorAll('.term-diff-file')).toHaveLength(2);
    expect(diff.querySelectorAll('.term-diff-hunk')).toHaveLength(2);
    const add = diff.querySelector('.term-diff-line--add') as HTMLElement;
    const cells = [...add.querySelectorAll('td')].map((td) => td.textContent);
    expect(cells).toEqual(['', '43', '+added', '    if (typeof userName !== "string") {']);
    const del = diff.querySelector('.term-diff-line--del') as HTMLElement;
    expect([...del.querySelectorAll('td')].slice(0, 3).map((td) => td.textContent)).toEqual([
      '43',
      '',
      '-removed',
    ]);
    expect(diff.textContent).toContain('app/data/user-dao.js');
  });

  it('says plainly when the patch content is not in the record', () => {
    for (const view of [SAMPLE_MID_TRIAL, SAMPLE_EMPTY]) {
      page(view);
      const diff = panel('Diff');
      expect(diff.textContent).toContain('The patch content is not in the record.');
      expect(diff.querySelector('table')).toBeNull();
      cleanup();
    }
  });

  it('flags a verify row that does not count, in words', () => {
    page(SAMPLE_FAILED);
    const rounds = panel('Verify').querySelectorAll('.term-round');
    expect(rounds).toHaveLength(2);
    expect(rounds[0]?.textContent).toContain('NOT ACCEPTED');
    expect(rounds[0]?.textContent).toContain('FAILNo counterexample survives the patch');
    expect(rounds[0]?.textContent).toContain('Rule: counterexample-survives.');
    expect(rounds[0]?.textContent).not.toContain('Does not count');
    expect(rounds[1]?.textContent).toContain('DOES NOT COUNT');
    expect(rounds[1]?.textContent).toContain(
      'Does not count: this is not the Judge’s own check'.replace('’', "'"),
    );
  });

  it('lists claims against rulings in the arguments panel', () => {
    page(SAMPLE_FAILED);
    const table = within(panel('Arguments')).getByRole('table');
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(SAMPLE_FAILED.evidence.length + 1);
    expect(rows[0]?.textContent).toContain('REJECTED stable-3of3');
    expect(rows[2]?.textContent).toContain('survives the patch');
    expect(rows[3]?.textContent).toContain('patch check failed');
    expect(rows[4]?.textContent).toContain('Basket 2 is still readable');
  });

  it('shows ballots with a confidence number, and says when there are none', () => {
    page(SAMPLE_VERIFIED);
    const rows = within(within(panel('Jury')).getByRole('table'))
      .getAllByRole('row')
      .slice(1);
    expect(rows).toHaveLength(3);
    expect(rows[0]?.textContent).toContain('juror-security-1');
    expect(rows[0]?.textContent).toContain('0.86');
    expect(rows[0]?.textContent).toContain('exhibit-counterexample-001');
    cleanup();
    page(SAMPLE_MID_TRIAL);
    expect(panel('Jury').textContent).toContain('No ballots are recorded.');
  });

  it('shows recorded cost and totals, and [metric] placeholders when nothing is recorded', () => {
    page(SAMPLE_VERIFIED);
    const cost = panel('Cost');
    expect(cost.textContent).toContain('87,100');
    expect(cost.textContent).toContain('$0.3923');
    expect(cost.textContent).not.toContain('[metric]');
    cleanup();
    page(SAMPLE_EMPTY);
    const empty = panel('Cost');
    expect(empty.textContent?.match(/\[metric\]/g)?.length).toBeGreaterThanOrEqual(8);
    expect(empty.textContent).not.toMatch(/\$\d/);
    cleanup();
    page(SAMPLE_FAILED);
    expect(panel('Cost').textContent).toContain('EXHAUSTED');
  });

  it('shows the tape in order, newest last, in a labelled scroll region', () => {
    page(SAMPLE_VERIFIED);
    const region = screen.getByRole('group', { name: 'Event tape, newest last' });
    expect(region.getAttribute('tabindex')).toBe('0');
    const rows = within(region).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(SAMPLE_VERIFIED.tape.length);
    expect(rows.at(-1)?.textContent).toContain('Verdict written: proven-fixed');
    expect(rows.at(-1)?.textContent).toContain('12:00:21.877');
  });

  it('shows the verdict, and keeps the verified look for the verified flag only', () => {
    const { container } = page(SAMPLE_VERIFIED);
    expect(panel('Verdict').textContent).toContain('PROVEN, FIX CLAIMED');
    expect(panel('Verdict').textContent).toContain('juror-blast-radius');
    expect(container.querySelectorAll('.term-stamp--verified').length).toBeGreaterThan(0);
    cleanup();
    // A status of "verified" without the flag must not look verified.
    const spoof = page({ ...SAMPLE_VERIFIED, verified: false });
    expect(spoof.container.querySelectorAll('.term-stamp--verified')).toHaveLength(0);
    expect(spoof.container.textContent).toContain('UNVERIFIED');
    cleanup();
    page(SAMPLE_MID_TRIAL);
    expect(panel('Verdict').textContent).toContain('No verdict is recorded yet.');
  });

  it('shows the latest three bubbles of a panel and folds the rest into a details', () => {
    const base = SAMPLE_VERIFIED.bubbles[1];
    if (!base) throw new Error('sample has no bubbles');
    const many = [1, 2, 3, 4, 5].map((n) => ({
      ...base,
      id: `m-${n}`,
      seq: n,
      body: `Note number ${n}.`,
    }));
    page({ ...SAMPLE_VERIFIED, bubbles: many });
    const evidence = panel('Evidence');
    const details = evidence.querySelector('details') as HTMLElement;
    expect(details.querySelector('summary')?.textContent).toBe('2 earlier');
    expect(details.textContent).toContain('Note number 1.');
    expect(details.textContent).toContain('Note number 2.');
    expect(details.textContent).not.toContain('Note number 3.');
    const latest = within(evidence).getByRole('list', { name: 'Notes on Evidence' });
    expect(within(latest).getAllByRole('listitem')).toHaveLength(3);
    expect(latest.textContent).toContain('Note number 5.');
  });
});

describe('untrusted record content', () => {
  const IMG = '<img src=x onerror=alert(1)>';
  const JS_URL = 'javascript:alert(1)';
  const STYLE = '"><a href="x" style="position:fixed">';
  const P = `${IMG} ${JS_URL} ${STYLE} `;

  /** Prefixes every string in the view with a hostile payload, enum-like fields included. */
  function poison(v: unknown): unknown {
    if (typeof v === 'string') return P + v;
    if (Array.isArray(v)) return v.map(poison);
    if (v && typeof v === 'object')
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, poison(x)]));
    return v;
  }

  it('renders hostile strings as inert text everywhere', () => {
    const { container } = page(poison(SAMPLE_VERIFIED) as TerminalView);
    for (const d of container.querySelectorAll('details')) d.open = true;
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('a')).toBeNull();
    for (const el of container.querySelectorAll('*'))
      for (const attr of el.getAttributeNames()) {
        expect(attr.startsWith('on'), `${el.tagName} has ${attr}`).toBe(false);
        expect(attr).not.toBe('style');
        const value = (el.getAttribute(attr) ?? '').toLowerCase();
        expect(value, `${el.tagName}[${attr}]`).not.toContain('<img');
        expect(value, `${el.tagName}[${attr}]`).not.toContain('javascript:');
        expect(value, `${el.tagName}[${attr}]`).not.toContain('position:fixed');
      }
    expect(container.textContent).toContain(IMG);
    expect(container.textContent).toContain(JS_URL);
    // Every bubble still shows, on the tape when its anchor is not a panel this view knows.
    expect(container.querySelectorAll('.term-bubble')).toHaveLength(SAMPLE_VERIFIED.bubbles.length);
    // A poisoned status or agent cannot pick a look.
    expect(container.querySelectorAll('.term-stamp--verified').length).toBeGreaterThan(0);
    expect(container.querySelectorAll('.term-chip--unknown').length).toBeGreaterThan(0);
    expect(checkAccessibility(container, APP_CSS + TERMINAL_CSS)).toEqual([]);
  });

  it('does not look verified because of recorded text', () => {
    const view: TerminalView = {
      ...SAMPLE_FAILED,
      caseId: 'VERIFIED term-stamp--verified',
      bubbles: SAMPLE_FAILED.bubbles.map((b) => ({ ...b, quote: 'Status: VERIFIED' })),
    };
    const { container } = page(view);
    expect(container.querySelectorAll('.term-stamp--verified')).toHaveLength(0);
  });
});

describe('scrubber', () => {
  const events = Array.from({ length: 6 }, (_, i) => ({ seq: i })) as unknown as TrialEvent[];

  function shown(): number {
    return document.querySelectorAll('.term-bubble').length;
  }

  it('starts at the latest event and steps back and forward', () => {
    render(<TerminalWithScrubber events={events} />);
    const range = screen.getByRole('slider', { name: 'Show the record as of event' });
    expect((range as HTMLInputElement).value).toBe('6');
    expect(screen.getByTestId('term-scrub-pos').textContent).toBe('Event 6 of 6, following latest');
    expect(shown()).toBe(6);
    const back = screen.getByRole('button', { name: 'Step back one event' });
    const fwd = screen.getByRole('button', { name: 'Step forward one event' });
    const latest = screen.getByRole('button', { name: 'Latest' });
    expect((fwd as HTMLButtonElement).disabled).toBe(true);
    expect((latest as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(back);
    fireEvent.click(back);
    expect(screen.getByTestId('term-scrub-pos').textContent).toBe('Event 4 of 6, paused');
    expect(shown()).toBe(4);
    fireEvent.click(fwd);
    expect(shown()).toBe(5);
    fireEvent.change(range, { target: { value: '2' } });
    expect(screen.getByTestId('term-scrub-pos').textContent).toBe('Event 2 of 6, paused');
    expect(shown()).toBe(2);
    fireEvent.change(range, { target: { value: '1' } });
    expect((back as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(latest);
    expect(screen.getByTestId('term-scrub-pos').textContent).toBe('Event 6 of 6, following latest');
  });

  it('follows new events while at latest, and stays put while paused', () => {
    const { rerender } = render(<TerminalWithScrubber events={events.slice(0, 3)} />);
    expect(shown()).toBe(3);
    rerender(<TerminalWithScrubber events={events.slice(0, 5)} />);
    expect(screen.getByTestId('term-scrub-pos').textContent).toBe('Event 5 of 5, following latest');
    expect(shown()).toBe(5);
    fireEvent.click(screen.getByRole('button', { name: 'Step back one event' }));
    rerender(<TerminalWithScrubber events={events} />);
    expect(screen.getByTestId('term-scrub-pos').textContent).toBe('Event 4 of 6, paused');
    expect(shown()).toBe(4);
  });

  it('passes the accessibility check with the scrubber in place', () => {
    const { container } = render(
      <>
        <header />
        <main>
          <TerminalWithScrubber events={events} />
        </main>
        <footer />
      </>,
    );
    expect(checkAccessibility(container, APP_CSS + TERMINAL_CSS)).toEqual([]);
  });
});
