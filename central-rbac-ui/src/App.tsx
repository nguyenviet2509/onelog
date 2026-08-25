/**
 * App.tsx — Root component: QueryClient + OIDC provider + Router + Toast.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from 'react-router-dom';
import { OidcAuthProvider } from '@/auth/auth-context';
import { ToastProvider } from '@/components/ui/toast-provider';
import { ErrorBoundary } from '@/components/error-boundary';
import { router } from '@/router';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

export default function App() {
  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <OidcAuthProvider>
          <ToastProvider />
          <RouterProvider router={router} />
        </OidcAuthProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}
