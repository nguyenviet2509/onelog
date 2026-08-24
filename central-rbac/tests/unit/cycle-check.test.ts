/**
 * cycle-check.test.ts — Unit tests for role hierarchy cycle detection.
 */
import { describe, it, expect } from 'vitest';
import { wouldCreateCycle, type RoleNode } from '../../src/lib/cycle-check.js';

const flatRoles: RoleNode[] = [
  { key: 'base.viewer', parent_key: null },
  { key: 'dept.editor', parent_key: 'base.viewer' },
  { key: 'dept.admin', parent_key: 'dept.editor' },
];

describe('wouldCreateCycle', () => {
  it('returns false for valid new parent (no cycle)', () => {
    expect(wouldCreateCycle(flatRoles, 'dept.admin', 'base.viewer')).toBe(false);
  });

  it('returns true when child === parent (self-loop)', () => {
    expect(wouldCreateCycle(flatRoles, 'dept.editor', 'dept.editor')).toBe(true);
  });

  it('returns true for direct parent→child cycle', () => {
    // dept.admin's parent is dept.editor; setting dept.editor.parent = dept.admin creates cycle
    expect(wouldCreateCycle(flatRoles, 'dept.editor', 'dept.admin')).toBe(true);
  });

  it('returns true for transitive cycle (A→B→C, C→A)', () => {
    // base.viewer is ancestor of dept.admin; setting base.viewer.parent = dept.admin is cycle
    expect(wouldCreateCycle(flatRoles, 'base.viewer', 'dept.admin')).toBe(true);
  });

  it('returns false for unrelated new root-level role', () => {
    const roles: RoleNode[] = [
      ...flatRoles,
      { key: 'other.role', parent_key: null },
    ];
    expect(wouldCreateCycle(roles, 'other.role', 'base.viewer')).toBe(false);
  });

  it('returns false for empty roles list', () => {
    expect(wouldCreateCycle([], 'a', 'b')).toBe(false);
  });

  it('handles depth cap — returns true if chain exceeds 10 levels', () => {
    // Build a chain of 11 roles: r0 → r1 → ... → r10
    const deepRoles: RoleNode[] = Array.from({ length: 12 }, (_, i) => ({
      key: `role.${i}`,
      parent_key: i === 0 ? null : `role.${i - 1}`,
    }));
    // Trying to set role.0.parent = role.11 would require walking 12 ancestors (>10 cap)
    // The function should treat hitting depth cap as a cycle
    expect(wouldCreateCycle(deepRoles, 'role.0', 'role.11')).toBe(true);
  });
});
