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
import { APP_CSS } from './styles.js';

function Layout() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const mainRef = useRef<HTMLElement>(null);
  const first = useRef(true);
  // After a client-side navigation, move focus to the content so keyboard and screen reader
  // users land on the new page instead of the link they activated.
  useEffect(() => {
    if (first.current) first.current = false;
    else mainRef.current?.focus();
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
}: {
  router: ReturnType<typeof createAppRouter>;
  client: QueryClient;
}) {
  return (
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}
