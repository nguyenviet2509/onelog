/**
 * manifest-validator-v2.test.ts — Unit tests cho Manifest v2 semantic validator.
 * Phase 09 (plan 260910-1334).
 *
 * Coverage:
 *   - Valid v2 manifest với hierarchy + can_grant
 *   - Namespace ownership (service vs app_slug + permission id prefix)
 *   - parent_key cycle detection (2 role + 3 role + self-ref)
 *   - parent_key must reference declared role
 *   - can_grant constraints (self, cross-app, ancestor, undeclared)
 *   - Backward compat: v1 manifest rejected qua v2 validator
 */
import { describe, it, expect } from 'vitest';
import { validateManifestV2 } from '../../src/services/manifest-validator-v2.js';

const APP_SLUG = 'helpdesk';

function buildValidManifest(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schema: '2',
    service: APP_SLUG,
    version: '1.0.0',
    tenant_aware: true,
    permissions: [
      { id: 'helpdesk:tickets.read', description: 'Read tickets' },
      { id: 'helpdesk:tickets.write', description: 'Write tickets' },
    ],
    default_roles: [
      { key: 'helpdesk.viewer', permissions: ['helpdesk:tickets.read'], can_grant: [] },
      { key: 'helpdesk.member', parent_key: 'helpdesk.viewer', permissions: ['helpdesk:tickets.write'], can_grant: [] },
      { key: 'helpdesk.admin', parent_key: 'helpdesk.member', permissions: [], can_grant: ['helpdesk.member', 'helpdesk.viewer'] },
    ],
    ...overrides,
  });
}

describe('validateManifestV2 — happy path', () => {
  it('accepts valid v2 manifest với hierarchy + can_grant', async () => {
    const result = await validateManifestV2(buildValidManifest(), APP_SLUG, { skipSsrfCheck: true });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.service).toBe(APP_SLUG);
      expect(result.manifest.tenant_aware).toBe(true);
      expect(result.manifest.default_roles?.length).toBe(3);
    }
  });

  it('accepts manifest với no default_roles', async () => {
    const raw = JSON.stringify({
      schema: '2',
      service: APP_SLUG,
      version: '1.0.0',
      permissions: [{ id: 'helpdesk:foo.bar', description: 'x' }],
    });
    const result = await validateManifestV2(raw, APP_SLUG, { skipSsrfCheck: true });
    expect(result.ok).toBe(true);
  });
});

describe('validateManifestV2 — namespace ownership', () => {
  it('rejects manifest.service không match app_slug', async () => {
    const result = await validateManifestV2(buildValidManifest({ service: 'otherapp' }), APP_SLUG, { skipSsrfCheck: true });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.path === 'service')).toBe(true);
    }
  });

  it('rejects permission id với foreign namespace', async () => {
    const raw = buildValidManifest({
      permissions: [{ id: 'otherapp:tickets.read', description: 'x' }],
      default_roles: [],
    });
    const result = await validateManifestV2(raw, APP_SLUG, { skipSsrfCheck: true });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.path === 'permissions.0.id')).toBe(true);
    }
  });

  it('rejects role key không có service prefix', async () => {
    const raw = buildValidManifest({
      default_roles: [
        { key: 'foreign.viewer', permissions: [], can_grant: [] },
      ],
    });
    const result = await validateManifestV2(raw, APP_SLUG, { skipSsrfCheck: true });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.path === 'default_roles.0.key')).toBe(true);
    }
  });
});

describe('validateManifestV2 — parent_key cycle detection', () => {
  it('rejects 2-role cycle (roleA → roleB → roleA)', async () => {
    const raw = buildValidManifest({
      default_roles: [
        { key: 'helpdesk.rolea', parent_key: 'helpdesk.roleb', permissions: [], can_grant: [] },
        { key: 'helpdesk.roleb', parent_key: 'helpdesk.rolea', permissions: [], can_grant: [] },
      ],
    });
    const result = await validateManifestV2(raw, APP_SLUG, { skipSsrfCheck: true });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.message.match(/cycle/i))).toBe(true);
    }
  });

  it('rejects 3-role cycle (roleA → roleB → roleC → roleA)', async () => {
    const raw = buildValidManifest({
      default_roles: [
        { key: 'helpdesk.rolea', parent_key: 'helpdesk.rolec', permissions: [], can_grant: [] },
        { key: 'helpdesk.roleb', parent_key: 'helpdesk.rolea', permissions: [], can_grant: [] },
        { key: 'helpdesk.rolec', parent_key: 'helpdesk.roleb', permissions: [], can_grant: [] },
      ],
    });
    const result = await validateManifestV2(raw, APP_SLUG, { skipSsrfCheck: true });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.message.match(/cycle/i))).toBe(true);
    }
  });

  it('rejects parent_key referencing undeclared role', async () => {
    const raw = buildValidManifest({
      default_roles: [
        { key: 'helpdesk.viewer', parent_key: 'helpdesk.ghost', permissions: [], can_grant: [] },
      ],
    });
    const result = await validateManifestV2(raw, APP_SLUG, { skipSsrfCheck: true });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.path === 'default_roles.0.parent_key')).toBe(true);
    }
  });
});

describe('validateManifestV2 — can_grant constraints', () => {
  it('rejects can_grant self', async () => {
    const raw = buildValidManifest({
      default_roles: [
        { key: 'helpdesk.admin', permissions: [], can_grant: ['helpdesk.admin'] },
      ],
    });
    const result = await validateManifestV2(raw, APP_SLUG, { skipSsrfCheck: true });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.message.match(/cannot grant itself/i))).toBe(true);
    }
  });

  it('rejects can_grant cross-app', async () => {
    const raw = buildValidManifest({
      default_roles: [
        { key: 'helpdesk.admin', permissions: [], can_grant: ['otherapp.admin'] },
      ],
    });
    const result = await validateManifestV2(raw, APP_SLUG, { skipSsrfCheck: true });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.message.match(/cross-app/i))).toBe(true);
    }
  });

  it('rejects can_grant descendant (privilege escalation — grantee inherits more perms)', async () => {
    const raw = buildValidManifest({
      default_roles: [
        { key: 'helpdesk.viewer', permissions: [], can_grant: ['helpdesk.member'] },
        { key: 'helpdesk.member', parent_key: 'helpdesk.viewer', permissions: [], can_grant: [] },
      ],
    });
    const result = await validateManifestV2(raw, APP_SLUG, { skipSsrfCheck: true });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.message.match(/descendant/i))).toBe(true);
    }
  });

  it('rejects can_grant undeclared target', async () => {
    const raw = buildValidManifest({
      default_roles: [
        { key: 'helpdesk.admin', permissions: [], can_grant: ['helpdesk.ghost'] },
      ],
    });
    const result = await validateManifestV2(raw, APP_SLUG, { skipSsrfCheck: true });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.message.match(/not declared/i))).toBe(true);
    }
  });
});

describe('validateManifestV2 — version discrimination', () => {
  it('rejects v1 manifest (schema="1")', async () => {
    const v1Raw = JSON.stringify({
      schema: '1',
      service: APP_SLUG,
      version: '1.0.0',
      permissions: [{ id: 'helpdesk:tickets.read', description: 'x' }],
    });
    const result = await validateManifestV2(v1Raw, APP_SLUG, { skipSsrfCheck: true });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.path === 'schema')).toBe(true);
    }
  });

  it('rejects invalid JSON', async () => {
    const result = await validateManifestV2('{not json', APP_SLUG, { skipSsrfCheck: true });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]?.path).toBe('$');
    }
  });
});

describe('validateManifestV2 — tenant_lookup_url SSRF', () => {
  it('accepts valid HTTPS tenant_lookup_url với skipSsrfCheck', async () => {
    const raw = buildValidManifest({ tenant_lookup_url: 'https://example.com/tenants' });
    const result = await validateManifestV2(raw, APP_SLUG, { skipSsrfCheck: true });
    expect(result.ok).toBe(true);
  });

  it('rejects non-HTTPS tenant_lookup_url via zod', async () => {
    const raw = buildValidManifest({ tenant_lookup_url: 'http://example.com/tenants' });
    const result = await validateManifestV2(raw, APP_SLUG, { skipSsrfCheck: true });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.path === 'tenant_lookup_url')).toBe(true);
    }
  });
});
