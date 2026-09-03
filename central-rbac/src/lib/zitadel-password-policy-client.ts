/**
 * zitadel-password-policy-client.ts — Fetch Zitadel password complexity policy
 * for a given org context. Used by Phase 03 create-user UI so the admin sees the
 * same rules Zitadel will enforce (12 chars, upper, lower, digit, symbol, etc.).
 *
 * Endpoint: GET /management/v1/policies/password/complexity
 *   Returns the effective policy for the org — either the org's own override or
 *   the instance default. Falls through to sane defaults on Zitadel errors so
 *   the UI never blocks admin.
 */
import { mgmtGet } from './zitadel-http.js';
import { ZitadelHttpError } from './zitadel-http-error.js';
import { logger } from './logger.js';

export interface PasswordPolicy {
  minLength: number;
  hasUppercase: boolean;
  hasLowercase: boolean;
  hasNumber: boolean;
  hasSymbol: boolean;
}

/** Zitadel default when the API is unreachable — matches most secure baseline. */
export const DEFAULT_PASSWORD_POLICY: PasswordPolicy = {
  minLength: 12,
  hasUppercase: true,
  hasLowercase: true,
  hasNumber: true,
  hasSymbol: true,
};

interface ZitadelPolicyResponse {
  policy?: {
    minLength?: string;
    hasUppercase?: boolean;
    hasLowercase?: boolean;
    hasNumber?: boolean;
    hasSymbol?: boolean;
  };
}

export async function getPasswordPolicy(orgId: string): Promise<PasswordPolicy> {
  try {
    const res = await mgmtGet('/management/v1/policies/password/complexity', orgId);
    if (!res.ok) {
      throw new ZitadelHttpError(res.status, `Zitadel password policy HTTP ${res.status}`);
    }
    const body = (await res.json()) as ZitadelPolicyResponse;
    const p = body.policy;
    if (!p) return DEFAULT_PASSWORD_POLICY;
    return {
      minLength: Number.parseInt(p.minLength ?? '12', 10) || 12,
      hasUppercase: p.hasUppercase ?? true,
      hasLowercase: p.hasLowercase ?? true,
      hasNumber: p.hasNumber ?? true,
      hasSymbol: p.hasSymbol ?? true,
    };
  } catch (err) {
    logger.warn({ err, orgId }, 'zitadel-password-policy: fetch failed — falling back to defaults');
    return DEFAULT_PASSWORD_POLICY;
  }
}
