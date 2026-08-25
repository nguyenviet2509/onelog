/**
 * pages/login/login-page.tsx — Login landing: triggers Zitadel OIDC redirect.
 */
import { useEffect } from 'react';
import { useAuth } from 'react-oidc-context';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';

export function LoginPage() {
  const auth = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (auth.isAuthenticated) {
      navigate('/users', { replace: true });
    }
  }, [auth.isAuthenticated, navigate]);

  function handleLogin() {
    void auth.signinRedirect();
  }

  if (auth.isLoading) {
    return (
      <div className="flex h-screen items-center justify-center text-gray-500 text-sm">
        Đang tải...
      </div>
    );
  }

  return (
    <div className="flex h-screen items-center justify-center bg-gray-50">
      <div className="bg-white rounded-xl shadow-md p-10 flex flex-col items-center gap-6 w-full max-w-sm">
        <div className="text-center">
          <h1 className="text-2xl font-semibold text-gray-900">Central RBAC</h1>
          <p className="text-sm text-gray-500 mt-1">Cổng quản trị phân quyền</p>
        </div>

        {auth.error && (
          <div className="w-full rounded-md bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700">
            Lỗi xác thực: {auth.error.message}
          </div>
        )}

        <Button onClick={handleLogin} className="w-full" size="lg">
          Đăng nhập qua Zitadel
        </Button>
      </div>
    </div>
  );
}
