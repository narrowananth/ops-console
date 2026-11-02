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

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={new QueryClient()}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
