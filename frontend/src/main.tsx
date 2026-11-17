import './styles/theme.css';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './app/app';
import { takeTokenFromUrl } from './lib/session';

takeTokenFromUrl();
// `pnpm dev` runs beside the installed app: its tab says which one it is.
if (import.meta.env.DEV) document.title = 'Ops Console (dev)';

const root = document.getElementById('root');
if (!root) throw new Error('index.html has no #root');

/**
 * Pages are kept fresh by `/ws` events, so a read is trusted for 15 s: opening a page, or coming back to the tab, does
 * not read everything again. A button's own mutation says what to read next.
 */
const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 15_000, refetchOnWindowFocus: false, retry: 1 } },
});

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
