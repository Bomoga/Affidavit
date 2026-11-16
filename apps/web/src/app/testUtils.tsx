import { render } from '@testing-library/react';
import { createMemoryHistory } from '@tanstack/react-router';
import { App, createAppQueryClient, createAppRouter } from './router.js';

export function renderApp(path: string) {
  const router = createAppRouter(createMemoryHistory({ initialEntries: [path] }));
  return { router, ...render(<App router={router} client={createAppQueryClient()} />) };
}
