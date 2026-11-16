import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createRootRoute,
  createRoute,
  createRouter,
  Link,
  Outlet,
  RouterProvider,
  useRouterState,
  type RouterHistory,
} from '@tanstack/react-router';
import { useEffect, useRef } from 'react';
import { CaseListPage, CasePage, NotFoundPage } from './pages.js';
import { SourceProvider, type SourceConfig } from './source.js';
import { APP_CSS } from './styles.js';

function Layout() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const mainRef = useRef<HTMLElement>(null);
  const previous = useRef(pathname);
  // After a client-side navigation, move focus to the content so keyboard and screen reader
  // users land on the new page instead of the link they activated.
  // Comparing with the previous path (not a first-run flag) keeps this correct when StrictMode
  // runs the effect twice on mount.
  useEffect(() => {
    if (previous.current !== pathname) {
      previous.current = pathname;
      mainRef.current?.focus();
    }
  }, [pathname]);
  return (
    <>
      <style>{APP_CSS}</style>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="site-header">
        <p className="brand">Affidavit</p>
        <nav aria-label="Primary">
          <Link to="/">Case files</Link>
        </nav>
      </header>
      <main id="main" tabIndex={-1} ref={mainRef}>
        <Outlet />
      </main>
      <footer className="site-footer">
        <p>Case content is untrusted data and is shown as plain text only.</p>
      </footer>
    </>
  );
}

const rootRoute = createRootRoute({ component: Layout, notFoundComponent: NotFoundPage });
const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: CaseListPage,
});
const caseRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/cases/$caseId',
  component: CasePage,
});
const routeTree = rootRoute.addChildren([indexRoute, caseRoute]);

export function createAppRouter(history?: RouterHistory) {
  return createRouter({ routeTree, ...(history ? { history } : {}) });
}

export function createAppQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}

export function App({
  router,
  client,
  source = { mode: 'fake' },
}: {
  router: ReturnType<typeof createAppRouter>;
  client: QueryClient;
  source?: SourceConfig;
}) {
  return (
    <QueryClientProvider client={client}>
      <SourceProvider value={source}>
        <RouterProvider router={router} />
      </SourceProvider>
    </QueryClientProvider>
  );
}
