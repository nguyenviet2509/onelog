/**
 * pages/login/callback-page.tsx — OIDC callback handler.
 * react-oidc-context processes the code+state from the URL; we just show a spinner
 * and redirect once auth state resolves.
 */
import { useEffect } from 'react';
import { useAuth } from 'react-oidc-context';
import { useNavigate } from 'react-router-dom';

export function CallbackPage() {
  const auth = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (!auth.isLoading && auth.isAuthenticated) {
      navigate('/users', { replace: true });
    }
    if (!auth.isLoading && !auth.isAuthenticated && auth.error) {
      navigate('/login', { replace: true });
    }
  }, [auth.isLoading, auth.isAuthenticated, auth.error, navigate]);

  return (
    <div className="flex h-screen items-center justify-center flex-col gap-3 text-gray-500">
      <svg
        className="animate-spin w-8 h-8 text-blue-600"
        fill="none"
        viewBox="0 0 24 24"
        aria-hidden="true"
      >
        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
        <path className="opacity-75" fill="currentColor"
          d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
      </svg>
      <span className="text-sm">Đang xác thực...</span>
    </div>
  );
}
