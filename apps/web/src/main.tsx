import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App, createAppQueryClient, createAppRouter } from './app/router.js';
import { sourceFromEnv } from './app/source.js';

const root = document.getElementById('root');
if (!root) throw new Error('missing #root element');
// VITE_AFFIDAVIT_SOURCE=live and VITE_AFFIDAVIT_API_URL=<origin> select the live API. Anything
// else, or an unsafe URL, keeps the recorded fixtures.
const source = sourceFromEnv({
  VITE_AFFIDAVIT_SOURCE: import.meta.env['VITE_AFFIDAVIT_SOURCE'] as string | undefined,
  VITE_AFFIDAVIT_API_URL: import.meta.env['VITE_AFFIDAVIT_API_URL'] as string | undefined,
});
createRoot(root).render(
  <StrictMode>
    <App router={createAppRouter()} client={createAppQueryClient()} source={source} />
  </StrictMode>,
);
