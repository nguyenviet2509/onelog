/**
 * cycle-check.ts — Role hierarchy cycle detection (app-layer guard).
 * Used before INSERT/UPDATE role parent to prevent circular hierarchies.
 * DB recursive CTE also has depth cap 10 as secondary guard.
 */

export interface RoleNode {
  key: string;
  parent_key: string | null;
}

/**
 * Check if setting `childKey.parent = newParentKey` would create a cycle.
 * Walks ancestors of newParentKey; if childKey is found → cycle detected.
 *
 * @param allRoles - flat list of current role nodes (from DB)
 * @param childKey - role being updated
 * @param newParentKey - proposed new parent
 * @returns true if cycle would be created
 */
export function wouldCreateCycle(
  allRoles: RoleNode[],
  childKey: string,
  newParentKey: string,
): boolean {
  if (childKey === newParentKey) return true;

  // Build parent lookup map
  const parentOf = new Map<string, string | null>();
  for (const r of allRoles) {
    parentOf.set(r.key, r.parent_key);
  }

  // Walk ancestors of newParentKey up to depth 10
  let current: string | null = newParentKey;
  let depth = 0;
  const MAX_DEPTH = 10;

  while (current !== null && depth < MAX_DEPTH) {
    if (current === childKey) return true;
    current = parentOf.get(current) ?? null;
    depth++;
  }

  // If we hit MAX_DEPTH without resolving — treat as cycle (defensive)
  if (depth >= MAX_DEPTH && current !== null) return true;

  return false;
}
