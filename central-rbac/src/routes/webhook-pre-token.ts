/**
 * webhook-pre-token.ts — POST /v1/webhooks/pre-token
 * Zitadel Action webhook handler: resolves permissions for a user and injects
 * claims into the JWT being issued by Zitadel.
 *
 * Flow:
 *   1. Verify HMAC (zitadel-signature header)
 *   2. Parse Zitadel webhook payload
 *   3. Break-glass shortcut if userId matches BREAK_GLASS_USER_ID
 *   4. Fetch user grants from Redis cache → Zitadel Mgmt API on miss
 *   5. Resolve permissions from Redis cache → DB on miss (singleflight guarded)
 *   6. Return { append_claims: [...] } response
 *   7. On any error: return degraded claims { rbac_degraded:true, permissions:[] }
 *
 * Admin fail-close (F8 partial): if any role matches FAIL_CLOSE_ROLE_PATTERN and
 * resolve fails, return HTTP 500. Requires Zitadel Target interruptOnError:true
 * to block token issuance (see ops-runbook deferred item in Phase 3).
 * For Phase 2: single target interruptOnError:false; degraded claim enforced by apps.
 */
import type { FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import { verifyZitadelActionHmac } from '../middleware/zitadel-action-hmac.js';
import { redis } from '../lib/redis-client.js';
import { singleflight } from '../lib/singleflight.js';
import { isBreakGlassUser, getBreakGlassPerms, emitBreakGlassAlert } from '../lib/break-glass.js';
import { listUserGrants } from '../lib/zitadel-mgmt-client.js';
import { resolvePermissions } from '../db/queries/resolve.js';
import { getResolveEpoch } from '../db/queries/resolve-epoch.js';
import { writerPool } from '../db/writer-pool.js';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';

// TTLs in seconds
const USER_GRANTS_TTL_S = 5 * 60;   // 5 min — grants change rarely
const RESOLVE_CACHE_TTL_S = 15 * 60; // 15 min — epoch handles invalidation

// Inline permissions only when count is small (JWT size guard, F11)
const INLINE_PERMS_MAX = 30;

// Zitadel webhook payload types (derived from Day 1 gate S4)
interface ZitadelHumanUser {
  first_name?: string;
  last_name?: string;
  display_name?: string;
  email?: string;
}

interface ZitadelMachineUser {
  name?: string;
  description?: string;
}

interface ZitadelUser {
  id: string;
  username?: string;
  preferred_login_name?: string;
  resource_owner?: string;
  human?: ZitadelHumanUser;
  machine?: ZitadelMachineUser;
}

interface ZitadelOrg {
  id: string;
  name?: string;
  primary_domain?: string;
}

interface ZitadelApplication {
  client_id?: string;
}

interface ZitadelWebhookPayload {
  function?: string;
  userinfo?: { sub?: string };
  user: ZitadelUser;
  org?: ZitadelOrg;
  application?: ZitadelApplication;
  // amr is NOT present in Zitadel v4.16.1 webhook payload (Day 1 F4 finding)
}

interface AppendClaim {
  key: string;
  value: string | number | boolean | string[];
}

interface WebhookResponse {
  append_claims: AppendClaim[];
}

/** SHA-256 hash of sorted comma-joined role keys — used as cache discriminator */
function hashRoleKeys(roleKeys: string[]): string {
  const sorted = [...roleKeys].sort().join(',');
  return createHash('sha256').update(sorted).digest('hex');
}

/**
 * Fetch user grants with Redis cache.
 * Key: user-grants:v{epoch}:{userId}  TTL: 5min
 */
async function fetchUserGrantsCached(
  userId: string,
  orgId: string,
  epoch: number,
): Promise<string[]> {
  const cacheKey = `user-grants:v${epoch}:${userId}`;

  try {
    const cached = await redis.get(cacheKey);
    if (cached) {
      logger.debug({ userId, cacheKey }, 'webhook-pre-token: user-grants cache hit');
      return JSON.parse(cached) as string[];
    }
  } catch (err) {
    logger.warn({ err, cacheKey }, 'webhook-pre-token: Redis get failed for user-grants');
  }

  // Cache miss — call Zitadel Mgmt API
  const grants = await listUserGrants(userId, orgId);
  const roleKeys = grants.flatMap((g) => g.roleKeys);

  try {
    await redis.setex(cacheKey, USER_GRANTS_TTL_S, JSON.stringify(roleKeys));
  } catch (err) {
    logger.warn({ err, cacheKey }, 'webhook-pre-token: Redis setex failed for user-grants');
  }

  return roleKeys;
}

/**
 * Resolve permissions with Redis cache + singleflight dedup.
 * Key: resolve:v{epoch}:{sha256(sorted_roleKeys)}  TTL: 15min
 */
async function resolvePermissionsCached(
  roleKeys: string[],
  epoch: number,
): Promise<{ permissions: string[]; permissions_hash: string }> {
  const rolesHash = hashRoleKeys(roleKeys);
  const cacheKey = `resolve:v${epoch}:${rolesHash}`;

  try {
    const cached = await redis.get(cacheKey);
    if (cached) {
      logger.debug({ rolesHash, cacheKey }, 'webhook-pre-token: resolve cache hit');
      return JSON.parse(cached) as { permissions: string[]; permissions_hash: string };
    }
  } catch (err) {
    logger.warn({ err, cacheKey }, 'webhook-pre-token: Redis get failed for resolve');
  }

  // Cache miss — singleflight guards against stampede
  const result = await singleflight(cacheKey, async () => {
    const { permissions } = await resolvePermissions(writerPool, roleKeys);
    const sorted = [...permissions].sort();
    const permissions_hash = createHash('sha256').update(sorted.join(',')).digest('hex');
    return { permissions: sorted, permissions_hash };
  });

  // Write resolve result to Redis
  try {
    await redis.setex(cacheKey, RESOLVE_CACHE_TTL_S, JSON.stringify(result));
    // Also cache by hash for /v1/permissions-lookup (Phase 2 bonus)
    await redis.setex(
      `perm-hash:${result.permissions_hash}`,
      RESOLVE_CACHE_TTL_S,
      JSON.stringify(result.permissions),
    );
  } catch (err) {
    logger.warn({ err, cacheKey }, 'webhook-pre-token: Redis setex failed for resolve');
  }

  return result;
}

/** Build degraded response — always include rbac_degraded:true */
function degradedResponse(): WebhookResponse {
  return {
    append_claims: [
      { key: 'permissions', value: [] },
      { key: 'rbac_degraded', value: true },
      { key: 'ver', value: 1 },
    ],
  };
}

export async function webhookPreTokenRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: ZitadelWebhookPayload }>(
    '/v1/webhooks/pre-token',
    { preHandler: [verifyZitadelActionHmac] },
    async (request, reply) => {
      const correlationId = request.id;
      const body = request.body;
      const userId = body.user?.id;
      const orgId = body.org?.id ?? config.ZITADEL_ORG_ID;
      const appId = body.application?.client_id ?? 'unknown';

      if (!userId) {
        logger.error({ correlationId }, 'webhook-pre-token: missing user.id in payload');
        return reply.status(400).send({ error: 'Missing user.id' });
      }

      logger.debug(
        { userId, orgId, appId, correlationId, fn: body.function },
        'webhook-pre-token: received',
      );

      // ── Break-glass path ──────────────────────────────────────────────────
      if (isBreakGlassUser(userId)) {
        // NOTE: amr is NOT in Zitadel v4.16.1 webhook payload (Day 1 F4).
        // Break-glass MFA check cannot be done via amr in payload.
        // Mitigation: require break-glass user to have MFA enrolled at Zitadel level.
        // Phase 3: verify via Zitadel Mgmt API user auth methods endpoint.
        // For Phase 2: grant perms but always emit alert; app-layer enforces MFA policy.
        try {
          const perms = getBreakGlassPerms();
          emitBreakGlassAlert('break-glass-used', userId, correlationId, appId);
          return reply.send({
            append_claims: [
              { key: 'permissions', value: perms },
              { key: 'break_glass', value: true },
              { key: 'ver', value: 1 },
            ],
          } satisfies WebhookResponse);
        } catch (err) {
          logger.error({ err, userId, correlationId }, 'webhook-pre-token: break-glass perms error');
          emitBreakGlassAlert('break-glass-mfa-missing', userId, correlationId, appId);
          return reply.send(degradedResponse());
        }
      }

      // ── Normal path ───────────────────────────────────────────────────────
      // Note: config.FAIL_CLOSE_ROLE_PATTERN wired for Phase 3 admin fail-close.
      try {
        // Step 1: get current epoch (in-process cache avoids DB on warm path)
        const epoch = await getResolveEpoch(writerPool);

        // Step 2: fetch role keys (Redis cache → Mgmt API)
        const roleKeys = await fetchUserGrantsCached(userId, orgId, epoch);

        logger.debug(
          { userId, roleCount: roleKeys.length, correlationId },
          'webhook-pre-token: roles fetched',
        );

        // Step 3: resolve permissions (Redis cache → DB singleflight)
        const { permissions, permissions_hash } = await resolvePermissionsCached(roleKeys, epoch);

        // Step 4: build response claims
        const claims: AppendClaim[] = [
          { key: 'permissions_hash', value: permissions_hash },
          { key: 'roles', value: roleKeys },
          { key: 'ver', value: 1 },
        ];

        // Inline permissions only for small sets (F11 JWT size guard)
        if (permissions.length <= INLINE_PERMS_MAX) {
          claims.push({ key: 'permissions', value: permissions });
        }

        logger.info(
          { userId, permCount: permissions.length, inlined: permissions.length <= INLINE_PERMS_MAX, correlationId },
          'webhook-pre-token: resolved ok',
        );

        return reply.send({ append_claims: claims } satisfies WebhookResponse);
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        logger.error(
          { err: errMsg, userId, orgId, correlationId },
          'webhook-pre-token: resolve failed — returning degraded',
        );
        // Admin fail-close (F8) deferred to Phase 3: needs 2 Zitadel Targets +
        // per-role Execution condition with interruptOnError:true.
        return reply.send(degradedResponse());
      }
    },
  );
}
