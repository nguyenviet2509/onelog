/**
 * zitadel-mgmt-client.test.ts — Unit tests for Zitadel Mgmt API client.
 * Mocks global fetch to avoid real network calls.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/config.js', () => ({
  config: {
    ZITADEL_MGMT_URL: 'http://zitadel-mock:8080',
    ZITADEL_SA_PAT: 'test-pat-token',
    ZITADEL_ORG_ID: 'org-test-123',
  },
}));

vi.mock('../../src/lib/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { listUserGrants } = await import('../../src/lib/zitadel-mgmt-client.js');

const USER_ID = 'user-abc-123';
const ORG_ID = 'org-test-123';

function makeOkResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function makeErrorResponse(status: number): Response {
  return new Response(JSON.stringify({ message: 'error' }), { status });
}

describe('listUserGrants', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns parsed grants on 200 response', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      makeOkResponse({
        result: [
          { grantId: 'g1', projectId: 'proj-1', orgId: ORG_ID, roleKeys: ['admin', 'viewer'] },
          { grantId: 'g2', projectId: 'proj-2', orgId: ORG_ID, roleKeys: ['editor'] },
        ],
      }),
    );
    vi.stubGlobal('fetch', mockFetch);

    const grants = await listUserGrants(USER_ID, ORG_ID);

    expect(grants).toHaveLength(2);
    expect(grants[0]).toEqual({ grantId: 'g1', projectId: 'proj-1', orgId: ORG_ID, roleKeys: ['admin', 'viewer'] });
    expect(grants[1]).toEqual({ grantId: 'g2', projectId: 'proj-2', orgId: ORG_ID, roleKeys: ['editor'] });
  });

  it('returns empty array when result is empty', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeOkResponse({ result: [] })));
    const grants = await listUserGrants(USER_ID, ORG_ID);
    expect(grants).toEqual([]);
  });

  it('returns empty array when result field is absent', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeOkResponse({})));
    const grants = await listUserGrants(USER_ID, ORG_ID);
    expect(grants).toEqual([]);
  });

  it('retries once on 5xx and succeeds on second attempt', async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce(makeErrorResponse(503))
      .mockResolvedValueOnce(makeOkResponse({ result: [{ grantId: 'g1', projectId: 'p1', orgId: ORG_ID, roleKeys: ['role.x'] }] }));
    vi.stubGlobal('fetch', mockFetch);

    const grants = await listUserGrants(USER_ID, ORG_ID);

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(grants).toHaveLength(1);
  });

  it('throws on non-5xx error (e.g. 403 Forbidden)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeErrorResponse(403)));
    await expect(listUserGrants(USER_ID, ORG_ID)).rejects.toThrow('HTTP 403');
  });

  it('throws when fetch rejects (network error)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    await expect(listUserGrants(USER_ID, ORG_ID)).rejects.toThrow('Zitadel Mgmt API unreachable');
  });

  it('sends correct Authorization header with PAT', async () => {
    const mockFetch = vi.fn().mockResolvedValue(makeOkResponse({ result: [] }));
    vi.stubGlobal('fetch', mockFetch);

    await listUserGrants(USER_ID, ORG_ID);

    const callArgs = mockFetch.mock.calls[0] as [string, RequestInit];
    const headers = callArgs[1].headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer test-pat-token');
    expect(headers['x-zitadel-orgid']).toBe(ORG_ID);
  });

  it('sends userId in body queries filter (not URL path)', async () => {
    const mockFetch = vi.fn().mockResolvedValue(makeOkResponse({ result: [] }));
    vi.stubGlobal('fetch', mockFetch);

    await listUserGrants('user/with/slashes', ORG_ID);

    const callArgs = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(callArgs[1].body as string);
    expect(body.queries).toEqual([{ userIdQuery: { userId: 'user/with/slashes' } }]);
  });

  it('handles grants with empty roleKeys gracefully', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        makeOkResponse({
          result: [{ grantId: 'g1', projectId: 'p1', orgId: ORG_ID }], // no roleKeys field
        }),
      ),
    );

    const grants = await listUserGrants(USER_ID, ORG_ID);
    expect(grants[0].roleKeys).toEqual([]);
  });
});
