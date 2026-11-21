import { TrialEvent } from '@affidavit/contracts';
import { readFixtureJson } from '@affidavit/testing';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { checkAccessibility } from '../a11y/check.js';
import { createFakeTransport } from '../model/fakeTransport.js';
import type { StreamTransport } from '../model/liveStream.js';
import { createSseTransport } from '../model/sseTransport.js';
import { APP_CSS } from './styles.js';
import { renderApp } from './testUtils.js';

afterEach(cleanup);

const GATE = TrialEvent.array().parse(readFixtureJson('trials/nodegoat-sqli-001.events.json'));
const BACKOFF = { baseMs: 5, capMs: 10, maxAttempts: 8 };
const status = () => screen.getByRole('status');
const openAll = () => {
  for (const b of screen.queryAllByRole('button', { expanded: false })) fireEvent.click(b);
};

describe('other live states', () => {
  it('passes the accessibility check while connecting', async () => {
    const never: StreamTransport = { open: () => new Promise(() => undefined) };
    const { container } = renderApp('/cases/case-nodegoat-sqli-001', {
      mode: 'live',
      transport: never,
    });
    await waitFor(() => expect(status().textContent).toContain('Connecting'));
    openAll();
    expect(checkAccessibility(container, APP_CSS)).toEqual([]);
  });

  it('shows "too long" with no retry button, and passes the accessibility check', async () => {
    const { container } = renderApp('/cases/case-nodegoat-sqli-001', {
      mode: 'live',
      transport: createFakeTransport({ events: GATE }),
      backoff: BACKOFF,
      maxEvents: 4,
    });
    await waitFor(() => expect(status().textContent).toContain('too long to show here'));
    expect(status().textContent).toContain('Disconnected');
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    openAll();
    expect(checkAccessibility(container, APP_CSS)).toEqual([]);
  });

  it('shows the not found page, not a connection status, when the server answers 404', async () => {
    let calls = 0;
    const transport = createSseTransport({
      baseUrl: 'http://localhost:3000',
      fetch: () => {
        calls += 1;
        return Promise.resolve(new Response('', { status: 404 }));
      },
    });
    const { container } = renderApp('/cases/case-missing', {
      mode: 'live',
      transport,
      backoff: BACKOFF,
    });
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Case file not found' }),
    ).toBeTruthy();
    expect(screen.queryByRole('status')).toBeNull();
    expect(calls).toBe(1);
    expect(checkAccessibility(container, APP_CSS)).toEqual([]);
  });
});
