import { TrialEvent, type VerifyResult } from '@affidavit/contracts';
import { listFixtureFiles, readFixtureJson } from '@affidavit/testing';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { buildCaseView } from '../model/caseView.js';
import { CaseFile } from './CaseFile.js';
import { getCaseEvents, listCaseSlugs } from './data.js';
import { renderApp } from './testUtils.js';

afterEach(cleanup);

const EM_DASH = '—';
const EN_DASH = '–';

describe('fixture loading', () => {
  it('inlines the same trial fixtures that @affidavit/testing reads from disk', () => {
    const onDisk = listFixtureFiles()
      .filter((f) => f.replaceAll('\\', '/').includes('trials/') && f.endsWith('.events.json'))
      .map((f) => f.replaceAll('\\', '/').split('/').pop()?.replace('.events.json', ''))
      .sort();
    expect(listCaseSlugs()).toEqual(onDisk);
    for (const slug of listCaseSlugs())
      expect(getCaseEvents(slug)).toEqual(
        TrialEvent.array().parse(readFixtureJson(`trials/${slug}.events.json`)),
      );
  });
});

describe('case list route', () => {
  it('lists every fixture with a link to its case file', async () => {
    renderApp('/');
    expect(await screen.findByRole('heading', { level: 1, name: 'Case files' })).toBeTruthy();
    const list = await screen.findByRole('list', { name: 'Case files' });
    const links = within(list).getAllByRole('link');
    expect(links.map((l) => l.textContent)).toEqual(['escalated-001', 'nodegoat-sqli-001']);
    expect(links.map((l) => l.getAttribute('href'))).toEqual([
      '/cases/escalated-001',
      '/cases/nodegoat-sqli-001',
    ]);
  });

  it('navigates to a case, then moves focus to the content', async () => {
    renderApp('/');
    const link = await screen.findByRole('link', { name: 'nodegoat-sqli-001' });
    link.focus();
    expect(document.activeElement).toBe(link);
    fireEvent.click(link);
    expect(await screen.findByText('Summary')).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole('main'));
  });
});

describe('gate case view (nodegoat-sqli-001)', () => {
  it('renders end to end, summary first, and honestly unverified until CR-1 lands', async () => {
    renderApp('/cases/nodegoat-sqli-001');
    const h1 = await screen.findByRole('heading', { level: 1 });
    expect(h1.textContent).toContain('not yet confirmed');
    expect(screen.getByText('UNVERIFIED')).toBeTruthy();
    expect(screen.queryByText('VERIFIED')).toBeNull();
    expect(
      screen.getByText('The record has no Judge result accepting a patch for this case.'),
    ).toBeTruthy();
    const summary = screen.getByRole('heading', { name: 'Summary' });
    const exhibits = screen.getByRole('heading', { name: /Exhibits/ });
    expect(
      summary.compareDocumentPosition(exhibits) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.getByText(/Cost: \[metric\]/)).toBeTruthy();
  });

  it('keeps exhibits one click deeper and shows the run log when opened', async () => {
    renderApp('/cases/nodegoat-sqli-001');
    const toggle = await screen.findByRole('button', { name: /exhibit-witness-001/ });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('table')).toBeNull();
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const table = screen.getByRole('table', { name: 'Run log for exhibit-witness-001' });
    expect(within(table).getAllByText('vulnerable').length).toBeTruthy();
    expect(within(table).getAllByText('pass').length).toBeTruthy();
    expect(within(table).getAllByText('812').length).toBeTruthy();
  });

  it('lists the docket behind a disclosure', async () => {
    renderApp('/cases/nodegoat-sqli-001');
    const toggle = await screen.findByRole('button', { name: /Docket/ });
    const list = document.querySelector('ol.docket');
    if (!list) throw new Error('docket list missing');
    expect(list.closest('[hidden]')).not.toBeNull();
    fireEvent.click(toggle);
    expect(list.closest('[hidden]')).toBeNull();
    expect(within(list as HTMLElement).getAllByRole('listitem')).toHaveLength(19);
  });
});

describe('VERIFIED stamp', () => {
  const events = TrialEvent.array().parse(readFixtureJson('trials/nodegoat-sqli-001.events.json'));
  const accepted: VerifyResult = {
    schemaVersion: 1,
    patchExhibitId: 'exhibit-patch-001' as VerifyResult['patchExhibitId'],
    familyFlipped: true,
    suitePassed: true,
    rescanClean: true,
    counterexamples: [],
  };

  it('shows only when the view model has Judge evidence for the patch', () => {
    render(<CaseFile view={buildCaseView(events, { verifyResults: [accepted] })} />);
    expect(screen.getByText('VERIFIED')).toBeTruthy();
    expect(screen.queryByText('UNVERIFIED')).toBeNull();
  });
});

describe('escalated case view (escalated-001)', () => {
  it('renders a clear human-review state', async () => {
    renderApp('/cases/escalated-001');
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Needs human review' }),
    ).toBeTruthy();
    expect(screen.getByText('HUMAN REVIEW')).toBeTruthy();
    const panel = screen.getByRole('region', { name: 'Human review needed' });
    expect(within(panel).getByText(/could not produce a test the Judge would admit/)).toBeTruthy();
    expect(
      within(panel).getByText(/second Defense attempt produced no admissible witness/),
    ).toBeTruthy();
    expect(within(panel).getAllByRole('listitem').length).toBeGreaterThan(0);
    expect(screen.queryByText('VERIFIED')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /exhibit-witness-002/ }));
    expect(screen.getByText(/Rule: differential/)).toBeTruthy();
  });
});

describe('document title', () => {
  it('names each page', async () => {
    renderApp('/cases/escalated-001');
    await screen.findByRole('heading', { level: 1 });
    expect(document.title).toBe('Needs human review - Affidavit');
    cleanup();
    renderApp('/cases/nope');
    await screen.findByRole('heading', { level: 1, name: 'Case file not found' });
    expect(document.title).toBe('Case file not found - Affidavit');
    cleanup();
    renderApp('/');
    await screen.findByRole('heading', { level: 1, name: 'Case files' });
    expect(document.title).toBe('Case files - Affidavit');
  });
});

describe('unknown case', () => {
  it('shows a not-found page with a way back', async () => {
    renderApp('/cases/nope');
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Case file not found' }),
    ).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Back to all case files' }).getAttribute('href')).toBe(
      '/',
    );
  });
});

describe('copy', () => {
  it('has no em or en dashes in any rendered page', async () => {
    for (const path of ['/', '/cases/nodegoat-sqli-001', '/cases/escalated-001', '/cases/nope']) {
      const { container, unmount } = renderApp(path);
      await screen.findByRole('heading', { level: 1 });
      for (const b of screen.queryAllByRole('button')) fireEvent.click(b);
      expect(container.textContent).not.toContain(EM_DASH);
      expect(container.textContent).not.toContain(EN_DASH);
      unmount();
    }
  });
});
