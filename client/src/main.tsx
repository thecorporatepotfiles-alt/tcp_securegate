import { StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, MemoryRouter } from 'react-router-dom';
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

// The browser edition runs inside an embedded page whose URL cannot carry app routes, so it routes in memory.
const initialEntries = BROWSER_EDITION ? [initialBrowserEntry()] : [];

function Router({ children }: { children: ReactNode }) {
  if (!BROWSER_EDITION) return <BrowserRouter>{children}</BrowserRouter>;
  return (
    <MemoryRouter initialEntries={initialEntries}>
      <BrowserRouteSync />
      {children}
    </MemoryRouter>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <Router>
        <ToastProvider>
          <AuthProvider>
            <App />
          </AuthProvider>
        </ToastProvider>
      </Router>
    </QueryClientProvider>
  </StrictMode>,
);
