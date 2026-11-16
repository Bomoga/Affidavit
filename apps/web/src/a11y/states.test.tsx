import { cleanup, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { APP_CSS } from '../app/styles.js';
import { renderApp } from '../app/testUtils.js';
import { checkAccessibility } from './check.js';

const mode = vi.hoisted<{ value: 'loading' | 'error' }>(() => ({ value: 'loading' }));

vi.mock('../app/data.js', async (original) => {
  const real = await original<typeof import('../app/data.js')>();
  return {
    ...real,
    loadCase: () =>
      mode.value === 'loading'
        ? new Promise<never>(() => undefined)
        : Promise.reject(new Error('boom')),
  };
});

afterEach(cleanup);

describe('case page loading and error states', () => {
  it('shows an h1 and passes the accessibility check while loading', async () => {
    mode.value = 'loading';
    const { container } = renderApp('/cases/nodegoat-sqli-001');
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Loading case file' }),
    ).toBeTruthy();
    expect(checkAccessibility(container, APP_CSS)).toEqual([]);
  });

  it('shows an h1 and passes the accessibility check when the load fails', async () => {
    mode.value = 'error';
    const { container } = renderApp('/cases/nodegoat-sqli-001');
    // The query retries twice with backoff before it gives up.
    expect(
      await screen.findByRole(
        'heading',
        { level: 1, name: 'Case file could not be loaded' },
        { timeout: 8000 },
      ),
    ).toBeTruthy();
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(checkAccessibility(container, APP_CSS)).toEqual([]);
  }, 12000);
});
