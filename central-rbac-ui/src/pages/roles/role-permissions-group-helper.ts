/**
 * pages/roles/role-permissions-group-helper.ts — Pure helpers for grouping permissions by module.
 *
 * Permission key format: <app>.<module>.<action>  (e.g. qlts.assets.read)
 * Groups by the <module> segment (index 1).
 * Keys with fewer than 3 segments go into "other".
 */
import type { Permission } from '@/api/permissions';

export interface PermissionGroup {
  module: string;
  permissions: Permission[];
}

/**
 * Group permissions by module (second dot-segment).
 * Returns groups sorted alphabetically by module name.
 */
export function groupPermissionsByModule(perms: Permission[]): PermissionGroup[] {
  const map = new Map<string, Permission[]>();
  for (const p of perms) {
    const parts = p.key.split('.');
    // qlts.assets.read → module = "assets"; qlts.read → module = "other"
    const module = parts.length >= 3 ? (parts[1] ?? 'other') : 'other';
    const list = map.get(module) ?? [];
    list.push(p);
    map.set(module, list);
  }
  return [...map.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([module, permissions]) => ({ module, permissions }));
}

/**
 * Filter permissions client-side by app prefix (e.g. "qlts.").
 * Also strips deprecated permissions.
 */
export function filterPermissionsByPrefix(
  perms: Permission[],
  prefix: string | undefined,
): Permission[] {
  return perms.filter(
    (p) =>
      !p.deprecated &&
      (!prefix || p.key.startsWith(prefix)),
  );
}

/**
 * Case-insensitive search filter applied on top of grouped data.
 * Returns groups that have at least one matching permission.
 */
export function searchPermissionGroups(
  groups: PermissionGroup[],
  query: string,
): PermissionGroup[] {
  if (!query.trim()) return groups;
  const q = query.trim().toLowerCase();
  return groups
    .map((g) => ({
      ...g,
      permissions: g.permissions.filter(
        (p) =>
          p.key.toLowerCase().includes(q) ||
          (p.description ?? '').toLowerCase().includes(q),
      ),
    }))
    .filter((g) => g.permissions.length > 0);
}
