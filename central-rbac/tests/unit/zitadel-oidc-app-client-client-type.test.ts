/**
 * zitadel-oidc-app-client-client-type.test.ts — Unit tests for Phase 09 additions.
 *
 * Covers:
 *   - CLIENT_TYPE_MAP: web/spa/native → correct Zitadel enums
 *   - deriveAdditionalOrigins: extract + dedupe origins
 *   - classifyClientType: reverse map from Zitadel enums
 *   - isPublicClient: spa/native vs web
 *   - patchOidcAppConfig: merge-then-PUT preserves untouched fields;
 *     guards public → confidential transition.
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

const {
  CLIENT_TYPE_MAP,
  deriveAdditionalOrigins,
  classifyClientType,
  isPublicClient,
  patchOidcAppConfig,
} = await import('../../src/lib/zitadel-oidc-app-client.js');

function makeOk(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('CLIENT_TYPE_MAP', () => {
  it('maps web → WEB + BASIC (confidential)', () => {
    expect(CLIENT_TYPE_MAP.web).toEqual({
      appType: 'OIDC_APP_TYPE_WEB',
      authMethodType: 'OIDC_AUTH_METHOD_TYPE_BASIC',
    });
  });

  it('maps spa → USER_AGENT + NONE (public PKCE)', () => {
    expect(CLIENT_TYPE_MAP.spa).toEqual({
      appType: 'OIDC_APP_TYPE_USER_AGENT',
      authMethodType: 'OIDC_AUTH_METHOD_TYPE_NONE',
    });
  });

  it('maps native → NATIVE + NONE (public PKCE)', () => {
    expect(CLIENT_TYPE_MAP.native).toEqual({
      appType: 'OIDC_APP_TYPE_NATIVE',
      authMethodType: 'OIDC_AUTH_METHOD_TYPE_NONE',
    });
  });
});

describe('deriveAdditionalOrigins', () => {
  it('extracts single origin from callback URL', () => {
    expect(deriveAdditionalOrigins(['https://qlts.inet.vn/sso/callback'])).toEqual(['https://qlts.inet.vn']);
  });

  it('deduplicates origins across multiple callbacks on same host', () => {
    expect(
      deriveAdditionalOrigins([
        'https://qlts.inet.vn/sso/callback',
        'https://qlts.inet.vn/api/oauth/callback',
      ]),
    ).toEqual(['https://qlts.inet.vn']);
  });

  it('keeps distinct origins for different hosts/ports', () => {
    const result = deriveAdditionalOrigins([
      'https://a.example.com/cb',
      'https://b.example.com/cb',
      'https://a.example.com:8443/cb',
    ]);
    expect(new Set(result)).toEqual(
      new Set(['https://a.example.com', 'https://b.example.com', 'https://a.example.com:8443']),
    );
  });

  it('silently skips invalid URLs', () => {
    expect(deriveAdditionalOrigins(['not-a-url', 'https://ok.example.com/cb'])).toEqual([
      'https://ok.example.com',
    ]);
  });

  it('returns empty array for empty input', () => {
    expect(deriveAdditionalOrigins([])).toEqual([]);
  });
});

describe('classifyClientType', () => {
  it('classifies USER_AGENT + NONE as spa', () => {
    expect(
      classifyClientType({
        appType: 'OIDC_APP_TYPE_USER_AGENT',
        authMethodType: 'OIDC_AUTH_METHOD_TYPE_NONE',
      }),
    ).toBe('spa');
  });

  it('classifies NATIVE + NONE as native', () => {
    expect(
      classifyClientType({
        appType: 'OIDC_APP_TYPE_NATIVE',
        authMethodType: 'OIDC_AUTH_METHOD_TYPE_NONE',
      }),
    ).toBe('native');
  });

  it('classifies WEB + BASIC as web', () => {
    expect(
      classifyClientType({
        appType: 'OIDC_APP_TYPE_WEB',
        authMethodType: 'OIDC_AUTH_METHOD_TYPE_BASIC',
      }),
    ).toBe('web');
  });

  it('falls back to web for unknown combinations', () => {
    expect(classifyClientType({ appType: 'OIDC_APP_TYPE_UNKNOWN', authMethodType: 'X' })).toBe('web');
    expect(classifyClientType({})).toBe('web');
  });
});

describe('isPublicClient', () => {
  it.each([
    ['spa', true],
    ['native', true],
    ['web', false],
  ] as const)('%s → %s', (type, expected) => {
    expect(isPublicClient(type)).toBe(expected);
  });
});

describe('patchOidcAppConfig', () => {
  const PROJECT_ID = 'proj-1';
  const APP_ID = 'app-1';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('merges client_type change onto current config, preserving assertion flags + accessTokenType', async () => {
    // GET current
    mockMgmtGet.mockResolvedValueOnce(
      makeOk({
        app: {
          oidcConfig: {
            appType: 'OIDC_APP_TYPE_WEB',
            authMethodType: 'OIDC_AUTH_METHOD_TYPE_BASIC',
            redirectUris: ['https://qlts.inet.vn/sso/callback'],
            postLogoutRedirectUris: ['https://qlts.inet.vn/'],
            responseTypes: ['OIDC_RESPONSE_TYPE_CODE'],
            grantTypes: ['OIDC_GRANT_TYPE_AUTHORIZATION_CODE'],
            accessTokenType: 'OIDC_TOKEN_TYPE_JWT',
            accessTokenRoleAssertion: true,
            idTokenRoleAssertion: true,
            idTokenUserinfoAssertion: true,
            clockSkew: '1s',
          },
        },
      }),
    );
    // PUT ok
    mockMgmtPut.mockResolvedValueOnce(makeOk({}, 200));

    const result = await patchOidcAppConfig({
      projectId: PROJECT_ID,
      appId: APP_ID,
      clientType: 'spa',
    });

    expect(result.clientType).toBe('spa');
    expect(result.additionalOrigins).toEqual(['https://qlts.inet.vn']);
    expect(mockMgmtPut).toHaveBeenCalledOnce();

    const [, , putBody] = mockMgmtPut.mock.calls[0]!;
    expect(putBody).toMatchObject({
      appType: 'OIDC_APP_TYPE_USER_AGENT',
      authMethodType: 'OIDC_AUTH_METHOD_TYPE_NONE',
      accessTokenType: 'OIDC_TOKEN_TYPE_JWT',
      accessTokenRoleAssertion: true,
      idTokenRoleAssertion: true,
      idTokenUserinfoAssertion: true,
      clockSkew: '1s',
      additionalOrigins: ['https://qlts.inet.vn'],
    });
  });

  it('auto-derives additionalOrigins when redirectUris change', async () => {
    mockMgmtGet.mockResolvedValueOnce(
      makeOk({
        app: {
          oidcConfig: {
            appType: 'OIDC_APP_TYPE_USER_AGENT',
            authMethodType: 'OIDC_AUTH_METHOD_TYPE_NONE',
            redirectUris: ['https://old.example.com/cb'],
            postLogoutRedirectUris: [],
            additionalOrigins: ['https://old.example.com'],
          },
        },
      }),
    );
    mockMgmtPut.mockResolvedValueOnce(makeOk({}, 200));

    const result = await patchOidcAppConfig({
      projectId: PROJECT_ID,
      appId: APP_ID,
      redirectUris: ['https://new.example.com/cb', 'https://new.example.com/api/cb'],
    });

    expect(result.additionalOrigins).toEqual(['https://new.example.com']);
    const [, , putBody] = mockMgmtPut.mock.calls[0]!;
    expect((putBody as { additionalOrigins: string[] }).additionalOrigins).toEqual(['https://new.example.com']);
  });

  it('rejects public → confidential (spa → web) transition with 400', async () => {
    mockMgmtGet.mockResolvedValueOnce(
      makeOk({
        app: {
          oidcConfig: {
            appType: 'OIDC_APP_TYPE_USER_AGENT',
            authMethodType: 'OIDC_AUTH_METHOD_TYPE_NONE',
            redirectUris: ['https://qlts.inet.vn/cb'],
          },
        },
      }),
    );

    await expect(
      patchOidcAppConfig({ projectId: PROJECT_ID, appId: APP_ID, clientType: 'web' }),
    ).rejects.toMatchObject({ status: 400 });

    expect(mockMgmtPut).not.toHaveBeenCalled();
  });

  it('rejects public → confidential (native → web) transition with 400', async () => {
    mockMgmtGet.mockResolvedValueOnce(
      makeOk({
        app: {
          oidcConfig: {
            appType: 'OIDC_APP_TYPE_NATIVE',
            authMethodType: 'OIDC_AUTH_METHOD_TYPE_NONE',
            redirectUris: ['https://a/cb'],
          },
        },
      }),
    );

    await expect(
      patchOidcAppConfig({ projectId: PROJECT_ID, appId: APP_ID, clientType: 'web' }),
    ).rejects.toMatchObject({ status: 400 });
    expect(mockMgmtPut).not.toHaveBeenCalled();
  });

  it('allows web → spa (confidential → public) transition', async () => {
    mockMgmtGet.mockResolvedValueOnce(
      makeOk({
        app: {
          oidcConfig: {
            appType: 'OIDC_APP_TYPE_WEB',
            authMethodType: 'OIDC_AUTH_METHOD_TYPE_BASIC',
            redirectUris: ['https://a/cb'],
          },
        },
      }),
    );
    mockMgmtPut.mockResolvedValueOnce(makeOk({}, 200));

    const result = await patchOidcAppConfig({ projectId: PROJECT_ID, appId: APP_ID, clientType: 'spa' });
    expect(result.clientType).toBe('spa');
  });

  it('throws 404 when OIDC app not found', async () => {
    mockMgmtGet.mockResolvedValueOnce(new Response('', { status: 404 }));
    await expect(
      patchOidcAppConfig({ projectId: PROJECT_ID, appId: APP_ID, clientType: 'spa' }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('preserves current URLs when only client_type changes (no redirect override)', async () => {
    mockMgmtGet.mockResolvedValueOnce(
      makeOk({
        app: {
          oidcConfig: {
            appType: 'OIDC_APP_TYPE_WEB',
            authMethodType: 'OIDC_AUTH_METHOD_TYPE_BASIC',
            redirectUris: ['https://qlts.inet.vn/sso/callback'],
            postLogoutRedirectUris: ['https://qlts.inet.vn/'],
          },
        },
      }),
    );
    mockMgmtPut.mockResolvedValueOnce(makeOk({}, 200));

    const result = await patchOidcAppConfig({ projectId: PROJECT_ID, appId: APP_ID, clientType: 'spa' });
    expect(result.redirectUris).toEqual(['https://qlts.inet.vn/sso/callback']);
    expect(result.postLogoutRedirectUris).toEqual(['https://qlts.inet.vn/']);
  });
});
