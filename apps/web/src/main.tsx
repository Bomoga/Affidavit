import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App, createAppQueryClient, createAppRouter } from './app/router.js';

const root = document.getElementById('root');
if (!root) throw new Error('missing #root element');
createRoot(root).render(
  <StrictMode>
    <App router={createAppRouter()} client={createAppQueryClient()} />
  </StrictMode>,
);
