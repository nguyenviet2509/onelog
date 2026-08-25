/**
 * auth/protected-route.tsx — Route wrapper that redirects to login if unauthenticated.
 *
 * Authorization: user must have rbac.admin or system.root role (from JWT roles[] claim).
 * Per H6 fix: rbac.admin role does NOT carry rbac.admin.read permission in Zitadel seed —
 * role-based check is the correct gate. Fallback to rbac.admin.read perm for backward compat.
 */
import { Navigate, Outlet } from 'react-router-dom';
import { useAuth } from 'react-oidc-context';
import { usePermissions } from '@/hooks/use-permissions';

export function ProtectedRoute() {
  const auth = useAuth();

  if (auth.isLoading) {
    return (
      <div className="flex h-screen items-center justify-center text-gray-500">
        Đang tải...
      </div>
    );
  }

  if (!auth.isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  return <AuthorizedRoute />;
}

/** Inner check: must have rbac.admin or system.root role (or legacy rbac.admin.read perm). */
function AuthorizedRoute() {
  const { canRead } = usePermissions();

  if (!canRead()) {
    return (
      <div className="flex h-screen items-center justify-center flex-col gap-3">
        <p className="text-red-600 font-medium">Bạn không có quyền truy cập trang này.</p>
        <p className="text-gray-500 text-sm">Liên hệ quản trị viên để được cấp quyền rbac.admin.</p>
      </div>
    );
  }

  return <Outlet />;
}
