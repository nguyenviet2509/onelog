/**
 * hooks/use-permissions.ts — Reads permissions + roles + rbac_degraded from OIDC token.
 *
 * Role-based checks (hasRole) are the authoritative gate for the RBAC admin UI.
 * Per seed design: rbac.admin role does NOT hold rbac.admin.* permissions (only system.root
 * does). So canWrite/canRead check role membership, not permission strings.
 *
 * See: plans/260821-1644-central-rbac-single-pane — H6 fix.
 */
import { useAuth } from 'react-oidc-context';
import { parsePermissions, parseRbacDegraded, parseRoles } from '@/lib/utils';

export function usePermissions() {
  const auth = useAuth();
  const token = auth.user?.access_token;

  const permissions = parsePermissions(token);
  const roles = parseRoles(token);
  const isDegraded = parseRbacDegraded(token);

  function hasPermission(perm: string): boolean {
    return permissions.includes(perm);
  }

  /** Check role membership from JWT roles[] claim. */
  function hasRole(role: string): boolean {
    return roles.includes(role);
  }

  /** True nếu user có rbac.admin hoặc system.root */
  function isAdmin(): boolean {
    return hasRole('rbac.admin') || hasRole('system.root');
  }

  /** True nếu user có rbac.member (không phải admin) */
  function isMember(): boolean {
    return hasRole('rbac.member') && !isAdmin();
  }

  /** Chỉ admin xem audit log */
  function canReadAudit(): boolean {
    return isAdmin();
  }

  /**
   * canManageApp: admin luôn true; member chỉ khi ownerSub === self sub.
   * @param ownerSub value của apps.created_by (từ API response)
   * @param selfSub sub của user hiện tại — pass explicit từ useAuth() ở caller để tránh hook rule violation
   */
  function canManageApp(ownerSub: string | null | undefined, selfSub: string | null | undefined): boolean {
    if (isAdmin()) return true;
    if (!ownerSub || !selfSub) return false;
    return ownerSub === selfSub;
  }

  /**
   * canWrite: admin OR member (scope theo ownership check ở button-level qua canManageApp), không bị degraded.
   * Falls back to rbac.admin.write permission for system.root accounts that skip role injection.
   */
  function canWrite(): boolean {
    if (isDegraded) return false;
    return isAdmin() || hasRole('rbac.member') || hasPermission('rbac.admin.write');
  }

  /**
   * canRead: admin OR member (member cũng vào UI được, scope check ở list filter backend).
   * Falls back to rbac.admin.read permission.
   */
  function canRead(): boolean {
    return isAdmin() || hasRole('rbac.member') || hasPermission('rbac.admin.read');
  }

  return {
    permissions,
    roles,
    isDegraded,
    hasPermission,
    hasRole,
    canWrite,
    canRead,
    isAdmin,
    isMember,
    canReadAudit,
    canManageApp,
  };
}
