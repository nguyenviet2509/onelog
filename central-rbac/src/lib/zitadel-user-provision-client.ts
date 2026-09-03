/**
 * zitadel-user-provision-client.ts — Zitadel Mgmt API wrappers for user
 * lifecycle actions Central RBAC proxies (Phase 02).
 *
 * Scope: create human user, deactivate, reactivate. NOT covered here:
 * password reset, MFA, deletion — those stay with Zitadel self-service /
 * Console (see plans/260827-1816-.../plan.md Non-goals).
 *
 * All 3 endpoints use Zitadel /v2/users. Auth via SA PAT (mgmt* transport
 * layer handles headers). Callers must have `rbac.admin` — enforced at
 * the route boundary, not here.
 */
import { mgmtPost } from './zitadel-http.js';
import { ZitadelHttpError } from './zitadel-http-error.js';
import { logger } from './logger.js';
import { searchUsers } from './zitadel-user-search-client.js';

export type ProvisionMode = 'invite_email' | 'set_password';

export interface CreateHumanUserInput {
  email: string;
  firstName: string;
  lastName: string;
  displayName?: string;
  orgId: string;
  /**
   * Phase 03: matches Zitadel Console create-user form (2 modes).
   *   invite_email — Zitadel sends verify + set-password link (needs SMTP config)
   *   set_password — admin supplies initial password; changeRequired forces rotation
   */
  mode?: ProvisionMode;
  /** Required when mode === 'set_password'. Zitadel enforces its complexity policy. */
  password?: string;
  passwordChangeRequired?: boolean;
  preferredLanguage?: string;
}

export interface CreateHumanUserResult {
  userId: string;
  /** true when the create hit 409 and we returned the existing user id (idempotent) */
  alreadyExisted: boolean;
}

/**
 * Create a human user. Idempotent on duplicate email: 409 → search-by-email
 * and return existing user id. Zitadel triggers the email verification /
 * set-password flow automatically when `sendInviteEmail` is true.
 *
 * Password strategy: we NEVER supply a password. Zitadel's set-password
 * link (delivered via email) is the only credential path. Keeps Central RBAC
 * out of credential storage.
 */
export async function createHumanUser(input: CreateHumanUserInput): Promise<CreateHumanUserResult> {
  const mode: ProvisionMode = input.mode ?? 'invite_email';

  const emailBlock: Record<string, unknown> = { email: input.email };
  if (mode === 'invite_email') {
    emailBlock['sendCode'] = {};
  } else {
    // set_password — with admin-supplied password we don't need Zitadel to send
    // a verify link; treat the email as verified so the user can log in immediately.
    emailBlock['isVerified'] = true;
  }

  const body: Record<string, unknown> = {
    username: input.email,
    organization: { orgId: input.orgId },
    profile: {
      givenName: input.firstName,
      familyName: input.lastName,
      displayName: input.displayName ?? `${input.firstName} ${input.lastName}`.trim(),
      preferredLanguage: input.preferredLanguage ?? 'vi',
    },
    email: emailBlock,
  };

  if (mode === 'set_password') {
    if (!input.password) throw new Error('createHumanUser: password required when mode=set_password');
    body['password'] = {
      password: input.password,
      changeRequired: input.passwordChangeRequired ?? true,
    };
  }

  const res = await mgmtPost('/v2/users/human', input.orgId, body);

  if (res.status === 409) {
    // Duplicate — surface existing user id so admin's next action (e.g. grant role)
    // can proceed without a second round-trip.
    logger.info({ email: input.email }, 'zitadel-user-provision: 409 duplicate — resolving existing user');
    const existing = await searchUsers(input.email, 1, 0, input.orgId).catch(() => null);
    const found = existing?.users.find((u) => u.email.toLowerCase() === input.email.toLowerCase());
    if (found) return { userId: found.id, alreadyExisted: true };
    // Rare: 409 but search does not find. Surface the error for admin to investigate.
    throw new ZitadelHttpError(409, `Zitadel createHumanUser 409 but existing user not found for ${input.email}`);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new ZitadelHttpError(res.status, `Zitadel createHumanUser error: HTTP ${res.status} ${body.slice(0, 200)}`);
  }

  const parsed = (await res.json()) as { userId?: string };
  if (!parsed.userId) {
    throw new Error('Zitadel createHumanUser: response missing userId');
  }

  logger.info({ user_id: parsed.userId, email: input.email }, 'zitadel-user-provision: created');
  return { userId: parsed.userId, alreadyExisted: false };
}

/**
 * Deactivate user — blocks new logins immediately. Existing sessions stay
 * valid until token expires (Zitadel does not revoke sessions on state change).
 * If ops needs force-logout, add a session-terminate step in a future phase.
 *
 * 200 idempotent on already-inactive user.
 */
export async function deactivateUser(userId: string, orgId: string): Promise<void> {
  const res = await mgmtPost(`/v2/users/${encodeURIComponent(userId)}/deactivate`, orgId, {});
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new ZitadelHttpError(res.status, `Zitadel deactivateUser error: HTTP ${res.status} ${body.slice(0, 200)}`);
  }
  logger.info({ user_id: userId }, 'zitadel-user-provision: deactivated');
}

/**
 * Reactivate user — restores login after a previous deactivate.
 * 200 idempotent on already-active user.
 */
export async function reactivateUser(userId: string, orgId: string): Promise<void> {
  const res = await mgmtPost(`/v2/users/${encodeURIComponent(userId)}/reactivate`, orgId, {});
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new ZitadelHttpError(res.status, `Zitadel reactivateUser error: HTTP ${res.status} ${body.slice(0, 200)}`);
  }
  logger.info({ user_id: userId }, 'zitadel-user-provision: reactivated');
}
