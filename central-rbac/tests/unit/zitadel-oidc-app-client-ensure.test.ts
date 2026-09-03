/**
 * zitadel-oidc-app-client-ensure.test.ts — Unit tests for ensureAssertionFlags.
 *
 * Covers the retrofit path (Phase 01 Central RBAC) — bug scenario 2026-08-27:
 * pre-wizard OIDC app on central-rbac project had assertion flags = false,
 * ID token missed profile claims, admin UI fell back to "User 798148".
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/config.js', () => ({
  config: { ZITADEL_ORG_ID: 'org-default' },
}));

vi.mock('../../src/lib/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { mockMgmtPost, mockMgmtGet, mockMgmtPut } = vi.hoisted(() => ({
  mockMgmtPost: vi.fn(),
  mockMgmtGet: vi.fn(),
  mockMgmtPut: vi.fn(),
}));

vi.mock('../../src/lib/zitadel-http.js', () => ({
  mgmtPost: mockMgmtPost,
  mgmtGet: mockMgmtGet,
  mgmtPut: mockMgmtPut,
}));

const { ensureAssertionFlags } = await import('../../src/lib/zitadel-oidc-app-client.js');

const PROJECT_ID = 'proj-123';

function makeOk(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('ensureAssertionFlags', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('patches only apps missing at least one flag; preserves other config fields', async () => {
    mockMgmtPost.mockResolvedValueOnce(makeOk({
      result: [
        {
          id: 'app-1',
          name: 'central-rbac (bootstrap)',
          oidcConfig: {
            redirectUris: ['https://rbac.inet.vn/callback'],
            responseTypes: ['OIDC_RESPONSE_TYPE_CODE'],
            grantTypes: ['OIDC_GRANT_TYPE_AUTHORIZATION_CODE'],
            appType: 'OIDC_APP_TYPE_WEB',
            authMethodType: 'OIDC_AUTH_METHOD_TYPE_BASIC',
            // Bug scenario: all 3 flags false — matches 2026-08-27 root cause
            accessTokenRoleAssertion: false,
            idTokenRoleAssertion: false,
            idTokenUserinfoAssertion: false,
            devMode: false,
          },
        },
      ],
    }));
    mockMgmtPut.mockResolvedValueOnce(makeOk({}));

    const result = await ensureAssertionFlags(PROJECT_ID);

    expect(result.updated).toHaveLength(1);
    expect(result.updated[0]?.appId).toBe('app-1');
    expect(result.updated[0]?.changedFlags).toEqual([
      'accessTokenRoleAssertion',
      'idTokenRoleAssertion',
      'idTokenUserinfoAssertion',
    ]);

    // PUT payload preserves original fields + forces 3 flags = true
    expect(mockMgmtPut).toHaveBeenCalledOnce();
    const putBody = mockMgmtPut.mock.calls[0]![2] as Record<string, unknown>;
    expect(putBody['redirectUris']).toEqual(['https://rbac.inet.vn/callback']);
    expect(putBody['appType']).toBe('OIDC_APP_TYPE_WEB');
    expect(putBody['accessTokenRoleAssertion']).toBe(true);
    expect(putBody['idTokenRoleAssertion']).toBe(true);
    expect(putBody['idTokenUserinfoAssertion']).toBe(true);
  });

  it('is idempotent — apps already conformant are skipped, no PUT calls', async () => {
    mockMgmtPost.mockResolvedValueOnce(makeOk({
      result: [
        {
          id: 'app-2',
          name: 'onemcp-portal',
          oidcConfig: {
            redirectUris: ['https://portal.inet.vn/callback'],
            accessTokenRoleAssertion: true,
            idTokenRoleAssertion: true,
            idTokenUserinfoAssertion: true,
          },
        },
      ],
    }));

    const result = await ensureAssertionFlags(PROJECT_ID);

    expect(result.updated).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.reason).toBe('already-ok');
    expect(mockMgmtPut).not.toHaveBeenCalled();
  });

  it('mixed batch — patches only the app missing a flag; leaves conformant one alone', async () => {
    mockMgmtPost.mockResolvedValueOnce(makeOk({
      result: [
        {
          id: 'app-ok',
          name: 'ok',
          oidcConfig: {
            accessTokenRoleAssertion: true,
            idTokenRoleAssertion: true,
            idTokenUserinfoAssertion: true,
          },
        },
        {
          id: 'app-partial',
          name: 'partial',
          oidcConfig: {
            accessTokenRoleAssertion: true,
            idTokenRoleAssertion: true,
            idTokenUserinfoAssertion: false, // only this one missing
          },
        },
      ],
    }));
    mockMgmtPut.mockResolvedValueOnce(makeOk({}));

    const result = await ensureAssertionFlags(PROJECT_ID);

    expect(result.updated).toHaveLength(1);
    expect(result.updated[0]?.appId).toBe('app-partial');
    expect(result.updated[0]?.changedFlags).toEqual(['idTokenUserinfoAssertion']);
    expect(result.skipped).toHaveLength(1);
    expect(mockMgmtPut).toHaveBeenCalledOnce();
  });

  it('uses default org from config when no override supplied', async () => {
    mockMgmtPost.mockResolvedValueOnce(makeOk({ result: [] }));

    await ensureAssertionFlags(PROJECT_ID);

    // mgmtPost called with default org from config (org-default per top-of-file mock)
    expect(mockMgmtPost.mock.calls[0]![1]).toBe('org-default');
  });

  it('uses supplied org override — needed for retrofit outside SA default org', async () => {
    mockMgmtPost.mockResolvedValueOnce(makeOk({ result: [] }));

    await ensureAssertionFlags(PROJECT_ID, 'org-authway-internal');

    expect(mockMgmtPost.mock.calls[0]![1]).toBe('org-authway-internal');
  });

  it('skips non-OIDC apps in project (API / SAML) — filtered by listOidcApps', async () => {
    mockMgmtPost.mockResolvedValueOnce(makeOk({
      result: [
        { id: 'app-api', name: 'legacy-api-app' /* no oidcConfig — API app */ },
        {
          id: 'app-oidc',
          name: 'oidc-app',
          oidcConfig: {
            accessTokenRoleAssertion: false,
            idTokenRoleAssertion: false,
            idTokenUserinfoAssertion: false,
          },
        },
      ],
    }));
    mockMgmtPut.mockResolvedValueOnce(makeOk({}));

    const result = await ensureAssertionFlags(PROJECT_ID);

    expect(result.updated).toHaveLength(1);
    expect(result.updated[0]?.appId).toBe('app-oidc');
    expect(mockMgmtPut).toHaveBeenCalledOnce();
  });

  it('throws on Zitadel list failure — caller handles retry / audit', async () => {
    mockMgmtPost.mockResolvedValueOnce(new Response('boom', { status: 500 }));
    await expect(ensureAssertionFlags(PROJECT_ID)).rejects.toThrow(/HTTP 500/);
  });
});
