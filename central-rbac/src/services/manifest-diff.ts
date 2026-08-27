/**
 * services/manifest-diff.ts — Manifest validation + diff computation.
 * Phase 08 Red Team Fixes #9 (implicit deprecate), #13 (namespace exact-segment), #14 (sha256 TOCTOU).
 *
 * validateManifest: parses + validates against schema, then enforces namespace ownership
 *   (Fix #13): every permission.id first segment MUST equal manifest.service EXACTLY.
 *   Case-insensitive. Rejects `startsWith` collisions.
 *
 * computeDiff: 4 categories per Fix #9:
 *   - add             (in manifest, not in DB active)
 *   - update-desc     (in both, description differs; semantic-key unchanged per immutability)
 *   - explicit-deprecate (manifest declares status: soft-deleted OR alias_of; safe default CHECKED)
 *   - implicit-deprecate (in DB active, missing from manifest — unexpected removal; default UNCHECKED)
 */
import { manifestSchema, type Manifest, type PermissionEntry } from './manifest-schema.js';
import { writerPool } from '../db/writer-pool.js';

export interface ValidateResult {
  ok: true;
  manifest: Manifest;
}

export interface ValidateError {
  ok: false;
  errors: Array<{ path: string; message: string }>;
}

/**
 * Validate manifest JSON string against schema + namespace ownership.
 * appSlug = the app.slug this manifest is claimed to belong to (from URL context).
 */
export function validateManifest(rawJson: string, appSlug: string): ValidateResult | ValidateError {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch (err) {
    return { ok: false, errors: [{ path: '$', message: `Invalid JSON: ${err instanceof Error ? err.message : String(err)}` }] };
  }

  const parseResult = manifestSchema.safeParse(parsed);
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

  // Namespace ownership: manifest.service MUST equal appSlug exactly (case-insensitive)
  if (manifest.service.toLowerCase() !== appSlug.toLowerCase()) {
    return {
      ok: false,
      errors: [{
        path: 'service',
        message: `manifest.service '${manifest.service}' does not match app slug '${appSlug}'`,
      }],
    };
  }

  // Exact-segment match for every permission.id: first ':' segment must equal manifest.service
  const errors: Array<{ path: string; message: string }> = [];
  manifest.permissions.forEach((p: PermissionEntry, i) => {
    const idx = p.id.indexOf(':');
    if (idx === -1) {
      errors.push({ path: `permissions[${i}].id`, message: 'id missing ":" segment separator' });
      return;
    }
    const firstSeg = p.id.slice(0, idx);
    if (firstSeg.toLowerCase() !== manifest.service.toLowerCase()) {
      errors.push({
        path: `permissions[${i}].id`,
        message: `first segment '${firstSeg}' does not equal manifest.service '${manifest.service}' (namespace violation)`,
      });
    }
  });

  if (errors.length > 0) return { ok: false, errors };

  return { ok: true, manifest };
}

// ── Diff computation ─────────────────────────────────────────────────────────

export type DiffAction = 'add' | 'update-desc' | 'explicit-deprecate' | 'implicit-deprecate';

export interface DiffItem {
  action: DiffAction;
  id: string;
  current?: { description: string; deprecated_at: string | null; alias_of: string | null };
  incoming?: { description: string; status: 'active' | 'soft-deleted'; alias_of?: string };
}

export interface DiffResult {
  items: DiffItem[];
  counts: Record<DiffAction, number>;
}

interface DbPermRow {
  key: string;
  description: string;
  deprecated_at: string | null;
  alias_of: string | null;
}

/**
 * Compute diff between manifest and DB state for a namespace.
 * `namespacePrefix` = `${service}:` — used in DB WHERE.
 */
export async function computeDiff(manifest: Manifest): Promise<DiffResult> {
  const namespacePrefix = `${manifest.service}:`;

  const { rows: dbRows } = await writerPool.query<DbPermRow>(
    `SELECT key, description, deprecated_at, alias_of
       FROM rbac.permissions
      WHERE key LIKE $1`,
    [`${namespacePrefix}%`],
  );

  const dbByKey = new Map<string, DbPermRow>();
  dbRows.forEach((r) => dbByKey.set(r.key, r));

  const manifestByKey = new Map<string, PermissionEntry>();
  manifest.permissions.forEach((p) => manifestByKey.set(p.id, p));

  const items: DiffItem[] = [];
  const counts: Record<DiffAction, number> = {
    add: 0,
    'update-desc': 0,
    'explicit-deprecate': 0,
    'implicit-deprecate': 0,
  };

  // Categorize each manifest entry
  for (const [id, incoming] of manifestByKey.entries()) {
    const db = dbByKey.get(id);
    if (!db) {
      // Not in DB → add (skip if manifest declares soft-deleted — nothing to add + deprecate simultaneously)
      if (incoming.status === 'active') {
        items.push({
          action: 'add',
          id,
          incoming: { description: incoming.description, status: 'active', alias_of: incoming.alias_of },
        });
        counts.add += 1;
      }
      continue;
    }
    // In DB
    if (incoming.status === 'soft-deleted' || incoming.alias_of) {
      // Explicit deprecation from manifest
      if (!db.deprecated_at) {
        items.push({
          action: 'explicit-deprecate',
          id,
          current: { description: db.description, deprecated_at: db.deprecated_at, alias_of: db.alias_of },
          incoming: { description: incoming.description, status: 'soft-deleted', alias_of: incoming.alias_of },
        });
        counts['explicit-deprecate'] += 1;
      }
      continue;
    }
    // Both active: check description change
    if (db.description !== incoming.description) {
      items.push({
        action: 'update-desc',
        id,
        current: { description: db.description, deprecated_at: db.deprecated_at, alias_of: db.alias_of },
        incoming: { description: incoming.description, status: 'active' },
      });
      counts['update-desc'] += 1;
    }
  }

  // Implicit deprecations: DB has active entry not present in manifest
  for (const [key, db] of dbByKey.entries()) {
    if (db.deprecated_at) continue;               // already deprecated → skip
    if (manifestByKey.has(key)) continue;         // present in manifest → not implicit
    items.push({
      action: 'implicit-deprecate',
      id: key,
      current: { description: db.description, deprecated_at: db.deprecated_at, alias_of: db.alias_of },
    });
    counts['implicit-deprecate'] += 1;
  }

  return { items, counts };
}
