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

  /**
   * canWrite: user must have rbac.admin or system.root role, and not be in degraded mode.
   * Falls back to rbac.admin.write permission for system.root accounts that skip role injection.
   */
  function canWrite(): boolean {
    if (isDegraded) return false;
    return hasRole('rbac.admin') || hasRole('system.root') || hasPermission('rbac.admin.write');
  }

  /**
   * canRead: user must have rbac.admin or system.root role.
   * Falls back to rbac.admin.read permission.
   */
  function canRead(): boolean {
    return hasRole('rbac.admin') || hasRole('system.root') || hasPermission('rbac.admin.read');
  }

  return { permissions, roles, isDegraded, hasPermission, hasRole, canWrite, canRead };
}
