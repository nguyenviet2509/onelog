/**
 * zitadel-user-provision-client.test.ts — Unit tests for Phase 02 provision proxy.
 *
 * Focus: 409 idempotency (create-then-return-existing) + happy path + err path.
 * All Zitadel HTTP calls mocked; no live network.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/config.js', () => ({
  config: { ZITADEL_ORG_ID: 'org-default' },
}));

vi.mock('../../src/lib/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { mockMgmtPost } = vi.hoisted(() => ({ mockMgmtPost: vi.fn() }));
vi.mock('../../src/lib/zitadel-http.js', () => ({ mgmtPost: mockMgmtPost }));

const { mockSearchUsers } = vi.hoisted(() => ({ mockSearchUsers: vi.fn() }));
vi.mock('../../src/lib/zitadel-user-search-client.js', () => ({ searchUsers: mockSearchUsers }));

const { createHumanUser, deactivateUser, reactivateUser } = await import(
  '../../src/lib/zitadel-user-provision-client.js'
);

const ORG = 'org-spike-test';

function ok(body: unknown, status = 201): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
function err(status: number, msg = ''): Response {
  return new Response(msg, { status });
}

describe('createHumanUser', () => {
  beforeEach(() => vi.clearAllMocks());

  it('happy path — returns userId + alreadyExisted=false', async () => {
    mockMgmtPost.mockResolvedValueOnce(ok({ userId: 'user-42' }));

    const r = await createHumanUser({
      email: 'new@example.com',
      firstName: 'Alice',
      lastName: 'Nguyen',
      orgId: ORG,
    });

    expect(r).toEqual({ userId: 'user-42', alreadyExisted: false });
    // Verify Zitadel POST body shape
    const [path, orgHeader, body] = mockMgmtPost.mock.calls[0]!;
    expect(path).toBe('/v2/users/human');
    expect(orgHeader).toBe(ORG);
    expect((body as Record<string, unknown>)['username']).toBe('new@example.com');
    // sendCode present by default → Zitadel emails set-password link
    expect((body as { email: { sendCode?: unknown } }).email.sendCode).toBeDefined();
  });

  it('409 duplicate — searches by email and returns existing userId (idempotent)', async () => {
    mockMgmtPost.mockResolvedValueOnce(err(409, 'user exists'));
    mockSearchUsers.mockResolvedValueOnce({
      users: [{ id: 'user-existing', email: 'dup@example.com', display_name: 'Dup' }],
      total: 1,
    });

    const r = await createHumanUser({
      email: 'dup@example.com',
      firstName: 'D',
      lastName: 'U',
      orgId: ORG,
    });

    expect(r).toEqual({ userId: 'user-existing', alreadyExisted: true });
    expect(mockSearchUsers).toHaveBeenCalledWith('dup@example.com', 1, 0, ORG);
  });

  it('409 duplicate but search returns no match — throws for admin to investigate', async () => {
    mockMgmtPost.mockResolvedValueOnce(err(409, 'user exists'));
    mockSearchUsers.mockResolvedValueOnce({ users: [], total: 0 });

    await expect(
      createHumanUser({ email: 'ghost@example.com', firstName: 'G', lastName: 'H', orgId: ORG }),
    ).rejects.toThrow(/409/);
  });

  it('non-409 failure — surfaces ZitadelHttpError with status', async () => {
    mockMgmtPost.mockResolvedValueOnce(err(500, 'boom'));

    await expect(
      createHumanUser({ email: 'x@example.com', firstName: 'X', lastName: 'Y', orgId: ORG }),
    ).rejects.toThrow(/HTTP 500/);
  });

  // ── Phase 03: 2-mode provisioning (setup_later dropped 2026-09-03) ─────────

  it('mode=invite_email → email.sendCode set, no password', async () => {
    mockMgmtPost.mockResolvedValueOnce(ok({ userId: 'u-inv' }));
    await createHumanUser({
      email: 'inv@example.com',
      firstName: 'I',
      lastName: 'V',
      orgId: ORG,
      mode: 'invite_email',
    });
    const [, , body] = mockMgmtPost.mock.calls[0]! as [unknown, unknown, { email: Record<string, unknown>; password?: unknown }];
    expect(body.email['sendCode']).toEqual({});
    expect(body.password).toBeUndefined();
  });

  it('mode=set_password → email.isVerified=true, password.changeRequired=true', async () => {
    mockMgmtPost.mockResolvedValueOnce(ok({ userId: 'u-pwd' }));
    await createHumanUser({
      email: 'pwd@example.com',
      firstName: 'P',
      lastName: 'W',
      orgId: ORG,
      mode: 'set_password',
      password: 'S3cure!Passphrase',
    });
    const [, , body] = mockMgmtPost.mock.calls[0]! as [
      unknown,
      unknown,
      { email: Record<string, unknown>; password: { password: string; changeRequired: boolean } },
    ];
    expect(body.email['isVerified']).toBe(true);
    expect(body.password.password).toBe('S3cure!Passphrase');
    expect(body.password.changeRequired).toBe(true);
  });

  it('mode=set_password without password → throws (guard, never reaches Zitadel)', async () => {
    await expect(
      createHumanUser({
        email: 'nopw@example.com',
        firstName: 'N',
        lastName: 'P',
        orgId: ORG,
        mode: 'set_password',
      }),
    ).rejects.toThrow(/password required/);
    expect(mockMgmtPost).not.toHaveBeenCalled();
  });

  it('mode=set_password respects passwordChangeRequired=false override', async () => {
    mockMgmtPost.mockResolvedValueOnce(ok({ userId: 'u-noforce' }));
    await createHumanUser({
      email: 'noforce@example.com',
      firstName: 'N',
      lastName: 'F',
      orgId: ORG,
      mode: 'set_password',
      password: 'AnotherStrong1!',
      passwordChangeRequired: false,
    });
    const [, , body] = mockMgmtPost.mock.calls[0]! as [
      unknown,
      unknown,
      { password: { changeRequired: boolean } },
    ];
    expect(body.password.changeRequired).toBe(false);
  });
});

describe('deactivateUser', () => {
  beforeEach(() => vi.clearAllMocks());

  it('calls Zitadel deactivate + surfaces empty body OK', async () => {
    mockMgmtPost.mockResolvedValueOnce(ok({}, 200));
    await deactivateUser('user-1', ORG);
    expect(mockMgmtPost).toHaveBeenCalledWith(`/v2/users/user-1/deactivate`, ORG, {});
  });

  it('URL-encodes userId — safe when Zitadel eventually issues punctuated ids', async () => {
    mockMgmtPost.mockResolvedValueOnce(ok({}, 200));
    await deactivateUser('user/with/slash', ORG);
    expect(mockMgmtPost.mock.calls[0]![0]).toBe(`/v2/users/user%2Fwith%2Fslash/deactivate`);
  });

  it('non-2xx throws ZitadelHttpError', async () => {
    mockMgmtPost.mockResolvedValueOnce(err(404));
    await expect(deactivateUser('missing', ORG)).rejects.toThrow(/HTTP 404/);
  });
});

describe('reactivateUser', () => {
  beforeEach(() => vi.clearAllMocks());

  it('happy path calls reactivate endpoint', async () => {
    mockMgmtPost.mockResolvedValueOnce(ok({}, 200));
    await reactivateUser('user-1', ORG);
    expect(mockMgmtPost).toHaveBeenCalledWith(`/v2/users/user-1/reactivate`, ORG, {});
  });

  it('non-2xx throws ZitadelHttpError', async () => {
    mockMgmtPost.mockResolvedValueOnce(err(403));
    await expect(reactivateUser('user-1', ORG)).rejects.toThrow(/HTTP 403/);
  });
});
