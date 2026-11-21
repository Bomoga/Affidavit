import { TrialEvent } from '@affidavit/contracts';
import { readFixtureJson } from '@affidavit/testing';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { checkAccessibility } from '../a11y/check.js';
import { createFakeTransport } from '../model/fakeTransport.js';
import { expectInert, IMG, poisonPayloads, SCRIPT } from '../testing/poison.js';
import { withProsecution } from '../testing/prosecution.js';
import { sourceFromEnv, type SourceConfig } from './source.js';
import { APP_CSS } from './styles.js';
import { renderApp } from './testUtils.js';

afterEach(cleanup);

const GATE = TrialEvent.array().parse(readFixtureJson('trials/nodegoat-sqli-001.events.json'));
const SLOW = { timeout: 4000 };
const live = (transport: ReturnType<typeof createFakeTransport>): SourceConfig => ({
  mode: 'live',
  transport,
  backoff: { baseMs: 120, capMs: 150, maxAttempts: 8 },
});
const status = () => screen.getByRole('status');
const docketCount = () =>
  /(\d+) entries/.exec(screen.getByRole('button', { name: /Docket/ }).textContent)?.[1];
const openAll = () => {
  for (const b of screen.queryAllByRole('button', { expanded: false })) fireEvent.click(b);
};

describe('live case page', () => {
  it('streams a case, announces Live politely, and ends complete', async () => {
    const { container } = renderApp(
      '/cases/case-nodegoat-sqli-001',
      live(createFakeTransport({ events: GATE })),
    );
    await waitFor(() => expect(status().textContent).toContain('Complete'), SLOW);
    expect(status().getAttribute('aria-live')).toBe('polite');
    expect(docketCount()).toBe(String(GATE.length));
    // The streamed Judge verify-result (CR-1) earns the stamp live, as it does from the fixture.
    expect(screen.getByRole('heading', { level: 1 }).textContent).toContain(
      'Verified: weakness proven and fix confirmed',
    );
    expect(screen.getByText('VERIFIED')).toBeTruthy();
    openAll();
    expect(checkAccessibility(container, APP_CSS)).toEqual([]);
  });

  it('shows Reconnecting after a drop, resumes from the last seq, and loses nothing', async () => {
    const transport = createFakeTransport({ events: GATE, scripts: [{ dropAfter: 7 }] });
    const { container } = renderApp('/cases/case-nodegoat-sqli-001', live(transport));
    await waitFor(() => expect(status().textContent).toContain('Reconnecting'), SLOW);
    expect(docketCount()).toBe('7');
    openAll();
    expect(checkAccessibility(container, APP_CSS)).toEqual([]);
    await waitFor(() => expect(status().textContent).toContain('Complete'), SLOW);
    expect(docketCount()).toBe(String(GATE.length));
    expect(transport.opens).toEqual([undefined, 6]);
    const seqs = [...container.querySelectorAll('.docket li')].map(
      (li) => /^#(\d+)/.exec(li.textContent)?.[1],
    );
    expect(seqs).toEqual(GATE.map((e) => String(e.seq)));
  });

  it('does not render a malformed event and says one was dropped', async () => {
    const msgs = [
      ...GATE.slice(0, 3).map((e) => JSON.stringify(e)),
      JSON.stringify({ ...GATE[3], type: `<b>${IMG}</b>` }),
      ...GATE.slice(3).map((e) => JSON.stringify(e)),
    ];
    const { container } = renderApp(
      '/cases/case-nodegoat-sqli-001',
      live(createFakeTransport({ events: GATE, scripts: [{ messages: msgs }] })),
    );
    await waitFor(() => expect(status().textContent).toContain('Complete'), SLOW);
    expect(status().textContent).toContain('1 malformed update was dropped and not shown');
    expect(docketCount()).toBe(String(GATE.length));
    expect(container.textContent).not.toContain('<b>');
    expect(container.querySelector('b')).toBeNull();
  });

  it('recovers from a gap without showing events past it', async () => {
    const skipping = [GATE[0], GATE[1], GATE[4]].map((e) => JSON.stringify(e));
    const transport = createFakeTransport({ events: GATE, scripts: [{ messages: skipping }] });
    renderApp('/cases/case-nodegoat-sqli-001', live(transport));
    await waitFor(() => expect(status().textContent).toContain('Complete'), SLOW);
    expect(docketCount()).toBe(String(GATE.length));
    expect(transport.opens).toEqual([undefined, 1]);
  });

  it('shows Disconnected with a retry button when the stream keeps failing', async () => {
    const scripts = Array.from({ length: 12 }, () => ({ dropAfter: 0 }));
    const { container } = renderApp(
      '/cases/case-nodegoat-sqli-001',
      live(createFakeTransport({ events: GATE, scripts })),
    );
    await waitFor(() => expect(status().textContent).toContain('Disconnected'), {
      timeout: 8000,
    });
    // The button sits beside the status region, so it is not announced as part of it.
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
    expect(within(status()).queryByRole('button')).toBeNull();
    expect(checkAccessibility(container, APP_CSS)).toEqual([]);
  }, 12000);

  it('refuses an unsafe case id without opening a connection', async () => {
    const transport = createFakeTransport({ events: GATE });
    renderApp('/cases/a.b', live(transport));
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Case file not found' }),
    ).toBeTruthy();
    expect(transport.opens).toEqual([]);
  });

  it('lists no fixtures in live mode', async () => {
    renderApp('/', live(createFakeTransport({ events: GATE })));
    expect(await screen.findByText(/no list of cases/)).toBeTruthy();
    expect(screen.queryByRole('list', { name: 'Case files' })).toBeNull();
  });

  it('shows Prosecution counterexamples and objections, with the exhibit one click deeper', async () => {
    const events = withProsecution(GATE, { counterexampleId: 'exhibit-counterexample-001' });
    const { container } = renderApp(
      '/cases/case-nodegoat-sqli-001',
      live(createFakeTransport({ events })),
    );
    await waitFor(() => expect(status().textContent).toContain('Complete'), SLOW);
    fireEvent.click(screen.getByRole('button', { name: /Docket/ }));
    expect(
      screen.getByText(/The Prosecution objected, citing exhibit-counterexample-001/),
    ).toBeTruthy();
    const show = screen.getAllByRole('button', { name: 'Show exhibit exhibit-counterexample-001' });
    expect(show).toHaveLength(3);
    const target = show[2];
    if (!target) throw new Error('no objection entry');
    fireEvent.click(target);
    expect(target.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText(/counterexample family/)).toBeTruthy();
    openAll();
    expect(checkAccessibility(container, APP_CSS)).toEqual([]);
  });

  it('renders streamed events with hostile text as inert text', async () => {
    const events = poisonPayloads(
      withProsecution(GATE, { counterexampleId: 'exhibit-counterexample-001' }),
    );
    const { container } = renderApp(
      '/cases/case-nodegoat-sqli-001',
      live(createFakeTransport({ events })),
    );
    await waitFor(() => expect(status().textContent).toContain('Complete'), SLOW);
    // Every poisoned event still parsed: none were dropped.
    expect(status().textContent).not.toContain('malformed');
    openAll();
    expectInert(container);
    expect(container.textContent).toContain(IMG);
    expect(container.textContent).toContain(SCRIPT);
  });

  it('has no em dashes in the live copy', async () => {
    const { container } = renderApp(
      '/cases/case-nodegoat-sqli-001',
      live(createFakeTransport({ events: GATE, scripts: [{ dropAfter: 2 }] })),
    );
    await waitFor(() => expect(status().textContent).toContain('Complete'), SLOW);
    openAll();
    expect(container.textContent).not.toContain('—');
  });
});

describe('source selection from env', () => {
  it('defaults to the recorded fixtures', () => {
    expect(sourceFromEnv({})).toEqual({ mode: 'fake' });
    expect(sourceFromEnv({ VITE_AFFIDAVIT_SOURCE: 'fake' })).toEqual({ mode: 'fake' });
  });

  it('goes live only with a safe base URL', () => {
    const ok = sourceFromEnv({
      VITE_AFFIDAVIT_SOURCE: 'live',
      VITE_AFFIDAVIT_API_URL: 'http://localhost:3000',
    });
    expect(ok.mode).toBe('live');
    for (const good of ['http://[::1]:3000', 'https://api.example.com/v1', 'http://127.0.0.1:8080'])
      expect(
        sourceFromEnv({ VITE_AFFIDAVIT_SOURCE: 'live', VITE_AFFIDAVIT_API_URL: good }).mode,
      ).toBe('live');
  });

  it('reports a config error, never fixtures, for a missing or unsafe live URL', () => {
    for (const url of [
      undefined,
      '',
      'http://evil.example.com',
      'https://user:pw@api.example.com',
      'https://api.example.com/?x=1',
      'not a url',
      'http://localhost//evil.example.com',
      'https://api.example.com//evil.example.com',
    ])
      expect(
        sourceFromEnv({ VITE_AFFIDAVIT_SOURCE: 'live', VITE_AFFIDAVIT_API_URL: url }).mode,
      ).toBe('config-error');
  });

  it('shows a plain config error page instead of case files', async () => {
    const { container } = renderApp('/', { mode: 'config-error' });
    expect(
      await screen.findByRole('heading', {
        level: 1,
        name: 'Live API URL is missing or not allowed',
      }),
    ).toBeTruthy();
    expect(screen.queryByRole('list', { name: 'Case files' })).toBeNull();
    expect(checkAccessibility(container, APP_CSS)).toEqual([]);
    expect(container.textContent).not.toContain('—');
  });

  it('shows the config error on a case address too', async () => {
    renderApp('/cases/nodegoat-sqli-001', { mode: 'config-error' });
    expect(
      await screen.findByRole('heading', {
        level: 1,
        name: 'Live API URL is missing or not allowed',
      }),
    ).toBeTruthy();
  });
});
