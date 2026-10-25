import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, createMemoryRouter, RouterProvider, useRouteError, type RouteObject } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@fontsource-variable/inter';
import './index.css';
import App from './App';
import { AuthProvider } from './lib/auth';
import { ToastProvider } from './components/toast';
import { ApiError } from './lib/api';
import { BROWSER_EDITION } from './lib/edition';
import { BrowserRouteSync, initialBrowserEntry } from './lib/browserRouting';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (count, err) => !(err instanceof ApiError && [400, 401, 403, 404].includes(err.status)) && count < 2,
      refetchOnWindowFocus: true,
      staleTime: 10_000,
      placeholderData: (prev: unknown) => prev,
    },
  },
});

function Root() {
  return (
    <>
      {BROWSER_EDITION && <BrowserRouteSync />}
      <ToastProvider>
        <AuthProvider>
          <App />
        </AuthProvider>
      </ToastProvider>
    </>
  );
}

/** Replaces the router's developer error screen if rendering fails; it sits outside the app's providers. */
function RootError() {
  const error = useRouteError();
  console.error(error);
  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <div className="max-w-md rounded-xl border border-line bg-card p-6 text-center shadow-[var(--shadow-card)]" role="alert">
        <h1 className="text-lg font-semibold text-ink">Something went wrong</h1>
        <p className="mt-1 text-sm text-ink-2">This view could not be displayed. Reloading usually fixes it.</p>
        <button type="button" onClick={() => window.location.reload()} className="mt-4 h-10 rounded-lg bg-forest-800 px-4 text-sm font-medium text-white hover:bg-forest-700">
          Reload
        </button>
      </div>
    </div>
  );
}

// A data router (rather than <BrowserRouter>/<MemoryRouter>) lets pages hold back navigation while they
// have unsaved changes (useBlocker). One splat route renders the app; App keeps its own <Routes>.
const routes: RouteObject[] = [{ path: '*', element: <Root />, errorElement: <RootError /> }];
// The browser edition runs inside an embedded page whose URL cannot carry app routes, so it routes in memory.
const router = BROWSER_EDITION ? createMemoryRouter(routes, { initialEntries: [initialBrowserEntry()] }) : createBrowserRouter(routes);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
