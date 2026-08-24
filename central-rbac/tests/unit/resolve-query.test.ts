/**
 * resolve-query.test.ts — Unit tests for resolvePermissions logic.
 * Mocks pg.Pool to test recursive flattening without a real DB.
 */
import { describe, it, expect, vi } from 'vitest';
import { resolvePermissions } from '../../src/db/queries/resolve.js';
import type { Pool } from 'pg';

function makePoolMock(rows: Array<{ permission_key: string; role_key: string }>): Pool {
  return {
    query: vi.fn().mockResolvedValue({ rows }),
  } as unknown as Pool;
}

describe('resolvePermissions', () => {
  it('returns empty result for empty roleKeys', async () => {
    const pool = makePoolMock([]);
    const result = await resolvePermissions(pool, []);
    expect(result.permissions).toEqual([]);
    expect(result.roles_expanded).toEqual([]);
  });

  it('returns permissions for a single role', async () => {
    const pool = makePoolMock([
      { permission_key: 'onemcp.kb.read', role_key: 'base.viewer' },
      { permission_key: 'onelog.logs.read', role_key: 'base.viewer' },
    ]);
    const result = await resolvePermissions(pool, ['base.viewer']);
    expect(result.permissions).toContain('onemcp.kb.read');
    expect(result.permissions).toContain('onelog.logs.read');
    expect(result.roles_expanded).toContain('base.viewer');
  });

  it('deduplicates permissions when multiple roles share same permission', async () => {
    const pool = makePoolMock([
      { permission_key: 'onemcp.kb.read', role_key: 'base.viewer' },
      { permission_key: 'onemcp.kb.read', role_key: 'dept.editor' },
      { permission_key: 'onemcp.kb.write', role_key: 'dept.editor' },
    ]);
    const result = await resolvePermissions(pool, ['base.viewer', 'dept.editor']);
    const readCount = result.permissions.filter((p) => p === 'onemcp.kb.read').length;
    expect(readCount).toBe(1);
    expect(result.permissions).toHaveLength(2);
  });

  it('returns roles_expanded including inherited role keys', async () => {
    const pool = makePoolMock([
      { permission_key: 'onemcp.kb.read', role_key: 'base.viewer' },
      { permission_key: 'onemcp.kb.write', role_key: 'dept.editor' },
      { permission_key: 'onemcp.kb.delete', role_key: 'dept.admin' },
    ]);
    const result = await resolvePermissions(pool, ['dept.admin']);
    expect(result.roles_expanded).toContain('base.viewer');
    expect(result.roles_expanded).toContain('dept.editor');
    expect(result.roles_expanded).toContain('dept.admin');
  });

  it('contains all permissions regardless of DB return order', async () => {
    // Sorting is enforced by SQL ORDER BY in production; mock returns rows as-is.
    // This test verifies set membership; integration tests verify ordering.
    const pool = makePoolMock([
      { permission_key: 'zzz.last', role_key: 'r1' },
      { permission_key: 'aaa.first', role_key: 'r1' },
      { permission_key: 'mmm.middle', role_key: 'r1' },
    ]);
    const result = await resolvePermissions(pool, ['r1']);
    expect(new Set(result.permissions)).toEqual(new Set(['aaa.first', 'mmm.middle', 'zzz.last']));
    expect(result.permissions).toHaveLength(3);
  });
});
