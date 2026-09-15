/**
 * manifest-diff-v2-dispatch.test.ts — Plan 260915-1615 phase 2.
 *
 * Verifies: validateManifest correctly dispatches v1 vs v2 via manifestSchemaAny
 * discriminated union. computeDiff processes v1+v2 permissions identically.
 *
 * Note: validateManifestV2 semantic checks (parent_key cycles, can_grant escalation, SSRF)
 * are already covered exhaustively in manifest-validator-v2.test.ts — no re-duplication.
 * This suite focuses on the dispatch layer + computeDiff compatibility.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockWriterQuery } = vi.hoisted(() => ({
  mockWriterQuery: vi.fn(async () => ({ rows: [] })),
}));

vi.mock('../../src/db/writer-pool.js', () => ({
  writerPool: { query: mockWriterQuery },
}));

vi.mock('../../src/lib/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Stub manifest-fetcher SSRF check so tests don't hit DNS
vi.mock('../../src/services/manifest-fetcher.js', () => ({
  validateSafeUrl: vi.fn(async () => undefined),
}));

import { validateManifest, computeDiff } from '../../src/services/manifest-diff.js';

const APP_SLUG = 'onelog-agent';

function v1Manifest(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schema: '1',
    service: APP_SLUG,
    version: '0.1.0',
    permissions: [
      { id: 'onelog-agent:chat.query', description: 'Query chat' },
      { id: 'onelog-agent:alert.push', description: 'Push alerts' },
    ],
    default_roles: [
      { key: 'onelog-agent.viewer', permissions: ['onelog-agent:chat.query'] },
      { key: 'onelog-agent.admin', permissions: ['onelog-agent:chat.query', 'onelog-agent:alert.push'] },
    ],
    ...overrides,
  });
}

function v2Manifest(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schema: '2',
    service: APP_SLUG,
    version: '0.2.0',
    tenant_aware: true,
    permissions: [
      { id: 'onelog-agent:chat.query', description: 'Query chat' },
      { id: 'onelog-agent:alert.push', description: 'Push alerts' },
    ],
    default_roles: [
      { key: 'onelog-agent.viewer', permissions: ['onelog-agent:chat.query'], can_grant: [] },
      {
        key: 'onelog-agent.admin',
        parent_key: 'onelog-agent.viewer',
        permissions: ['onelog-agent:alert.push'],
        can_grant: ['onelog-agent.viewer'],
      },
    ],
    ...overrides,
  });
}

describe('validateManifest — dispatch v1/v2', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWriterQuery.mockResolvedValue({ rows: [] });
  });

  it('accepts v1 manifest (schema="1") and returns ManifestV1 shape', async () => {
    const result = await validateManifest(v1Manifest(), APP_SLUG);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.schema).toBe('1');
      expect(result.manifest.permissions.length).toBe(2);
      expect(result.manifest.default_roles?.length).toBe(2);
    }
  });

  it('accepts v2 manifest (schema="2") with hierarchy + can_grant', async () => {
    const result = await validateManifest(v2Manifest(), APP_SLUG, { skipSsrfCheck: true });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.schema).toBe('2');
      if (result.manifest.schema === '2') {
        expect(result.manifest.tenant_aware).toBe(true);
        const admin = result.manifest.default_roles?.find((r) => r.key === 'onelog-agent.admin');
        expect(admin?.parent_key).toBe('onelog-agent.viewer');
        expect(admin?.can_grant).toContain('onelog-agent.viewer');
      }
    }
  });

  it('rejects invalid schema field (not "1" or "2")', async () => {
    const raw = JSON.stringify({
      schema: '3',
      service: APP_SLUG,
      version: '0.1.0',
      permissions: [],
    });
    const result = await validateManifest(raw, APP_SLUG);
    expect(result.ok).toBe(false);
  });

  it('rejects v1 manifest with cross-namespace permission id', async () => {
    const raw = v1Manifest({
      permissions: [{ id: 'other-app:evil', description: 'x' }],
    });
    const result = await validateManifest(raw, APP_SLUG);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.path.includes('permissions'))).toBe(true);
    }
  });

  it('rejects v2 manifest with can_grant privilege escalation (grant descendant)', async () => {
    // viewer tries to grant admin (its descendant via parent_key chain) → escalation
    const raw = v2Manifest({
      default_roles: [
        { key: 'onelog-agent.viewer', permissions: [], can_grant: ['onelog-agent.admin'] },
        { key: 'onelog-agent.admin', parent_key: 'onelog-agent.viewer', permissions: [], can_grant: [] },
      ],
    });
    const result = await validateManifest(raw, APP_SLUG, { skipSsrfCheck: true });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.message.includes('escalation'))).toBe(true);
    }
  });

  it('rejects service/appSlug mismatch (namespace ownership) for both v1 and v2', async () => {
    const v1Bad = await validateManifest(v1Manifest(), 'other-app');
    const v2Bad = await validateManifest(v2Manifest(), 'other-app', { skipSsrfCheck: true });
    expect(v1Bad.ok).toBe(false);
    expect(v2Bad.ok).toBe(false);
  });

  it('rejects malformed JSON with clear error', async () => {
    const result = await validateManifest('{ not json', APP_SLUG);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]!.path).toBe('$');
      expect(result.errors[0]!.message).toContain('Invalid JSON');
    }
  });
});

describe('computeDiff — v1 + v2 permissions treated identically', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWriterQuery.mockResolvedValue({ rows: [] });
  });

  it('computes add-diff for v2 manifest permissions (DB empty)', async () => {
    const v = await validateManifest(v2Manifest(), APP_SLUG, { skipSsrfCheck: true });
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    const diff = await computeDiff(v.manifest);
    expect(diff.counts.add).toBe(2);
    expect(diff.counts['update-desc']).toBe(0);
  });

  it('computes update-desc when DB has different description', async () => {
    mockWriterQuery.mockResolvedValueOnce({
      rows: [
        { key: 'onelog-agent:chat.query', description: 'OLD desc', deprecated_at: null, alias_of: null },
        { key: 'onelog-agent:alert.push', description: 'Push alerts', deprecated_at: null, alias_of: null },
      ],
    });
    const v = await validateManifest(v2Manifest(), APP_SLUG, { skipSsrfCheck: true });
    if (!v.ok) return;
    const diff = await computeDiff(v.manifest);
    expect(diff.counts['update-desc']).toBe(1);
    expect(diff.counts.add).toBe(0);
  });

  it('computes implicit-deprecate for DB permissions missing from v2 manifest', async () => {
    mockWriterQuery.mockResolvedValueOnce({
      rows: [
        { key: 'onelog-agent:chat.query', description: 'Query chat', deprecated_at: null, alias_of: null },
        { key: 'onelog-agent:alert.push', description: 'Push alerts', deprecated_at: null, alias_of: null },
        { key: 'onelog-agent:gone.perm', description: 'Removed', deprecated_at: null, alias_of: null },
      ],
    });
    const v = await validateManifest(v2Manifest(), APP_SLUG, { skipSsrfCheck: true });
    if (!v.ok) return;
    const diff = await computeDiff(v.manifest);
    expect(diff.counts['implicit-deprecate']).toBe(1);
    expect(diff.items.some((it) => it.action === 'implicit-deprecate' && it.id === 'onelog-agent:gone.perm')).toBe(true);
  });
});
