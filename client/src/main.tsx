import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import './index.css';
import { ThemeProvider } from './contexts/ThemeContext';
// Renders the toastStore. Without this mounted, every addToast() call in the
// app pushed into a store with no subscriber and the user saw nothing.
import { ToastContainer } from './shared/components/ToastContainer';
// Top-level crash net. AppLayout has its own ErrorBoundary around the routed
// pages, but a render crash in LoginPage, the customer portal, or AppLayout's
// own chrome (sidebar/header) happened OUTSIDE that boundary — the user got a
// blank white screen with no way back. This outer boundary is the fallback
// for everything the inner one can't see.
import { ErrorBoundary } from './shared/components/ErrorBoundary';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 5 * 60_000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <ThemeProvider>
        <QueryClientProvider client={queryClient}>
          <BrowserRouter>
            <App />
            <ToastContainer />
          </BrowserRouter>
        </QueryClientProvider>
      </ThemeProvider>
    </ErrorBoundary>
  </React.StrictMode>
);
