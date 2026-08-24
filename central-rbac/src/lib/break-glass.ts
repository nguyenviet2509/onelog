/**
 * break-glass.ts — Break-glass emergency access module.
 * Provides a human user with explicit (non-wildcard) permissions
 * when the normal RBAC resolve path is unavailable or insufficient.
 *
 * Security constraints (non-negotiable):
 * - BREAK_GLASS_PERMS must NEVER contain '*' — startup validation enforces this
 * - BREAK_GLASS_PERMS must not be empty — startup validation enforces this
 * - Usage emits a WARN log with [BREAK-GLASS-USED] tag — VL alert picks up
 * - User ID is sealed at startup — no runtime override possible
 */
import { config } from '../config.js';
import { logger } from './logger.js';

// Cache parsed perms to avoid re-splitting on every token issuance
let _perms: string[] | null = null;

/**
 * Validate break-glass config at startup.
 * Called once from app.ts before listening.
 * Throws if config is unsafe.
 */
export function validateBreakGlassConfig(): void {
  const { BREAK_GLASS_USER_ID, BREAK_GLASS_PERMS } = config;

  // In production, break-glass must be fully configured
  if (config.NODE_ENV === 'production') {
    if (!BREAK_GLASS_USER_ID || BREAK_GLASS_USER_ID.trim() === '') {
      throw new Error('BREAK_GLASS_USER_ID is required in production');
    }
  }

  // Parse and validate perms if configured
  if (BREAK_GLASS_PERMS) {
    const perms = BREAK_GLASS_PERMS.split(',')
      .map((p) => p.trim())
      .filter(Boolean);

    if (perms.length === 0) {
      throw new Error('BREAK_GLASS_PERMS must contain at least one permission');
    }

    const hasWildcard = perms.some((p) => p.includes('*'));
    if (hasWildcard) {
      throw new Error('BREAK_GLASS_PERMS must not contain wildcard (*) — use explicit permission keys');
    }

    _perms = perms;
  }
}

/**
 * Returns true if userId matches the configured break-glass user ID.
 * Returns false if BREAK_GLASS_USER_ID is not configured.
 */
export function isBreakGlassUser(userId: string): boolean {
  const id = config.BREAK_GLASS_USER_ID;
  if (!id || id.trim() === '') return false;
  return userId === id.trim();
}

/**
 * Returns the configured break-glass permission list.
 * Throws if called when perms are not configured or failed validation.
 * Never returns '*' or empty array (startup validation guarantees this).
 */
export function getBreakGlassPerms(): string[] {
  if (!_perms) {
    // Lazy parse on first call in case validateBreakGlassConfig wasn't called
    const raw = config.BREAK_GLASS_PERMS ?? '';
    const perms = raw.split(',').map((p) => p.trim()).filter(Boolean);

    if (perms.length === 0) {
      throw new Error('BREAK_GLASS_PERMS is empty — cannot return break-glass permissions');
    }
    if (perms.some((p) => p.includes('*'))) {
      throw new Error('BREAK_GLASS_PERMS contains wildcard — this must never happen');
    }
    _perms = perms;
  }
  return _perms;
}

/**
 * Emit a warning log with [BREAK-GLASS-USED] tag.
 * VictoriaLogs alert rule filters on: _stream=rbac-alerts AND msg CONTAINS "[BREAK-GLASS-USED]"
 * Never throws — alert emission must not block token issuance.
 */
export function emitBreakGlassAlert(
  event: 'break-glass-used' | 'break-glass-mfa-missing',
  userId: string,
  correlationId: string,
  appId: string,
): void {
  logger.warn(
    {
      tag: '[BREAK-GLASS-USED]',
      event,
      userId,
      correlationId,
      appId,
      ts: new Date().toISOString(),
    },
    `[BREAK-GLASS-USED] event=${event} userId=${userId} app=${appId} correlationId=${correlationId}`,
  );
}
