/**
 * services/manifest-validator-v2.ts — Manifest v2 semantic validation.
 *
 * Phase 09 (plan 260910-1334). Beyond zod parse, enforces:
 *   1. Namespace ownership (manifest.service = appSlug + permission.id prefix)
 *   2. Cycle detection trong parent_key chain (depth cap 10)
 *   3. can_grant constraints:
 *      - no self (role không grant chính nó)
 *      - no ancestor (role không grant lên parent chain)
 *      - no cross-app (target role_key phải cùng service prefix)
 *      - target role phải khai báo trong default_roles cùng manifest
 *   4. SSRF check cho tenant_lookup_url (reuse manifest-fetcher.validateSafeUrl)
 *
 * v1 validation vẫn dùng manifest-diff.validateManifest — v2 tách riêng vì semantic khác.
 */
import {
  manifestSchemaV2,
  type ManifestV2,
  type PermissionEntry,
  type DefaultRoleV2,
} from './manifest-schema.js';
import { validateSafeUrl } from './manifest-fetcher.js';

export interface ValidateV2Result {
  ok: true;
  manifest: ManifestV2;
}

export interface ValidateV2Error {
  ok: false;
  errors: Array<{ path: string; message: string }>;
}

const MAX_HIERARCHY_DEPTH = 10;

/**
 * Validate manifest v2. Zod parse + semantic checks + optional SSRF DNS check.
 *
 * Note: SSRF check runs async DNS resolve — pass `skipSsrfCheck: true` cho unit tests
 * hoặc dry-run contexts không muốn DNS lookup.
 */
export async function validateManifestV2(
  rawJson: string,
  appSlug: string,
  opts: { skipSsrfCheck?: boolean } = {},
): Promise<ValidateV2Result | ValidateV2Error> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch (err) {
    return {
      ok: false,
      errors: [{ path: '$', message: `Invalid JSON: ${err instanceof Error ? err.message : String(err)}` }],
    };
  }

  const parseResult = manifestSchemaV2.safeParse(parsed);
  if (!parseResult.success) {
    return {
      ok: false,
      errors: parseResult.error.issues.map((iss) => ({
        path: iss.path.join('.') || '$',
        message: iss.message,
      })),
    };
  }

  const manifest = parseResult.data;
  const errors: Array<{ path: string; message: string }> = [];

  // 1. Namespace ownership
  if (manifest.service.toLowerCase() !== appSlug.toLowerCase()) {
    errors.push({
      path: 'service',
      message: `manifest.service '${manifest.service}' does not match app slug '${appSlug}'`,
    });
  }

  // 1b. Permission ID first segment must equal service
  manifest.permissions.forEach((p: PermissionEntry, i) => {
    const idx = p.id.indexOf(':');
    if (idx === -1) {
      errors.push({ path: `permissions.${i}.id`, message: 'id missing ":" segment separator' });
      return;
    }
    const firstSeg = p.id.slice(0, idx);
    if (firstSeg.toLowerCase() !== manifest.service.toLowerCase()) {
      errors.push({
        path: `permissions.${i}.id`,
        message: `first segment '${firstSeg}' does not equal manifest.service '${manifest.service}' (namespace violation)`,
      });
    }
  });

  // 2. Role validation — parent_key cycle + can_grant constraints
  const defaultRoles = manifest.default_roles ?? [];
  if (defaultRoles.length > 0) {
    validateRoleGraph(defaultRoles, manifest.service, errors);
  }

  // 3. tenant_lookup_url SSRF check
  if (manifest.tenant_lookup_url && !opts.skipSsrfCheck) {
    try {
      await validateSafeUrl(manifest.tenant_lookup_url);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push({
        path: 'tenant_lookup_url',
        message: `SSRF check failed: ${msg}`,
      });
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, manifest };
}

/**
 * Validate role graph: parent_key must reference role trong same manifest;
 * detect cycles (walk parent chain, depth cap); can_grant constraints.
 */
function validateRoleGraph(
  roles: DefaultRoleV2[],
  service: string,
  errors: Array<{ path: string; message: string }>,
): void {
  const rolesByKey = new Map<string, DefaultRoleV2>();
  const roleServicePrefix = `${service.toLowerCase()}.`;

  // Index roles by key + validate key prefix matches service
  roles.forEach((role, i) => {
    const keyLower = role.key.toLowerCase();
    if (!keyLower.startsWith(roleServicePrefix)) {
      errors.push({
        path: `default_roles.${i}.key`,
        message: `role key '${role.key}' does not start with service prefix '${roleServicePrefix}'`,
      });
    }
    if (rolesByKey.has(role.key)) {
      errors.push({
        path: `default_roles.${i}.key`,
        message: `duplicate role key '${role.key}'`,
      });
    }
    rolesByKey.set(role.key, role);
  });

  // parent_key existence + cycle check per role
  roles.forEach((role, i) => {
    if (role.parent_key) {
      if (!rolesByKey.has(role.parent_key)) {
        errors.push({
          path: `default_roles.${i}.parent_key`,
          message: `parent_key '${role.parent_key}' not declared trong default_roles`,
        });
        return;
      }
      // Walk parent chain, detect cycle + enforce depth cap
      const ancestors = walkParentChain(role.key, rolesByKey);
      if (ancestors === 'cycle') {
        errors.push({
          path: `default_roles.${i}.parent_key`,
          message: `cycle detected trong parent_key chain starting at '${role.key}'`,
        });
      } else if (ancestors === 'depth-exceeded') {
        errors.push({
          path: `default_roles.${i}.parent_key`,
          message: `parent_key depth exceeded ${MAX_HIERARCHY_DEPTH} for role '${role.key}'`,
        });
      }
    }
  });

  // can_grant constraints
  // Hierarchy semantic: parent_key = "inherits from" → descendant has MORE permissions than ancestor.
  // Delegation rule: grantor cannot grant a role MORE privileged than themselves (privilege escalation).
  // Equivalently: role X cannot grant role Y IF role.key is in Y's ancestor chain (Y is descendant of X).
  roles.forEach((role, i) => {
    role.can_grant.forEach((targetKey, j) => {
      // no self
      if (targetKey === role.key) {
        errors.push({
          path: `default_roles.${i}.can_grant.${j}`,
          message: `role '${role.key}' cannot grant itself`,
        });
        return;
      }
      // no cross-app
      if (!targetKey.toLowerCase().startsWith(roleServicePrefix)) {
        errors.push({
          path: `default_roles.${i}.can_grant.${j}`,
          message: `can_grant target '${targetKey}' cross-app (must start with '${roleServicePrefix}')`,
        });
        return;
      }
      // target must exist trong manifest
      if (!rolesByKey.has(targetKey)) {
        errors.push({
          path: `default_roles.${i}.can_grant.${j}`,
          message: `can_grant target '${targetKey}' not declared trong default_roles`,
        });
        return;
      }
      // no descendant (target's parent chain contains role.key → target > role in privilege → escalation)
      const targetAncestors = collectAncestorKeys(targetKey, rolesByKey);
      if (targetAncestors.has(role.key)) {
        errors.push({
          path: `default_roles.${i}.can_grant.${j}`,
          message: `role '${role.key}' cannot grant descendant '${targetKey}' (privilege escalation — descendant inherits MORE permissions)`,
        });
      }
    });
  });
}

/** Walk parent_key chain từ role key. Returns 'ok' | 'cycle' | 'depth-exceeded'. */
function walkParentChain(startKey: string, rolesByKey: Map<string, DefaultRoleV2>): 'ok' | 'cycle' | 'depth-exceeded' {
  const visited = new Set<string>([startKey]);
  let current = rolesByKey.get(startKey)?.parent_key ?? null;
  let depth = 0;
  while (current) {
    depth += 1;
    if (depth > MAX_HIERARCHY_DEPTH) return 'depth-exceeded';
    if (visited.has(current)) return 'cycle';
    visited.add(current);
    current = rolesByKey.get(current)?.parent_key ?? null;
  }
  return 'ok';
}

/** Collect all ancestor keys reachable từ role. Empty set if no ancestors. */
function collectAncestorKeys(startKey: string, rolesByKey: Map<string, DefaultRoleV2>): Set<string> {
  const ancestors = new Set<string>();
  let current = rolesByKey.get(startKey)?.parent_key ?? null;
  let depth = 0;
  while (current && depth <= MAX_HIERARCHY_DEPTH) {
    if (ancestors.has(current)) break; // cycle guard
    ancestors.add(current);
    current = rolesByKey.get(current)?.parent_key ?? null;
    depth += 1;
  }
  return ancestors;
}
