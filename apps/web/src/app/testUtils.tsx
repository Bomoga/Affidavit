import { render, screen, waitFor } from '@testing-library/react';
import { createMemoryHistory } from '@tanstack/react-router';
import { App, createAppQueryClient, createAppRouter } from './router.js';
import type { SourceConfig } from './source.js';

export function renderApp(path: string, source?: SourceConfig) {
  const router = createAppRouter(createMemoryHistory({ initialEntries: [path] }));
  return {
    router,
    ...render(
      <App router={router} client={createAppQueryClient()} {...(source ? { source } : {})} />,
    ),
  };
}

/** Waits for the page's h1 to appear and for any "Loading" placeholder to be replaced. */
export async function settled(): Promise<HTMLElement> {
  let h1: HTMLElement | undefined;
  await waitFor(() => {
    h1 = screen.getByRole('heading', { level: 1 });
    if (/^Loading/.test(h1.textContent)) throw new Error('still loading');
  });
  if (!h1) throw new Error('no h1');
  return h1;
}
