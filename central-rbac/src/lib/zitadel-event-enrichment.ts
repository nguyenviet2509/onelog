/**
 * zitadel-event-enrichment.ts — Cached resolvers for adapter webhook.
 *
 * 1) resolveAppSlug(clientId)
 *    Zitadel OIDC application client_id → app slug (from rbac.apps table).
 *    Redis cache TTL 10 min. Cache miss → DB SELECT → cache.
 *    Auto-updates when new app registered qua Central RBAC wizard.
 *
 * 2) resolveUserEmail(userId, orgId)
 *    Zitadel user ID → email/preferredLoginName via Mgmt API.
 *    Redis cache TTL 24h. Failures don't propagate (audit best-effort).
 *
 * Both return undefined on miss/error — caller falls back to id/null.
 */
import { writerPool } from '../db/writer-pool.js';
import { redis } from './redis-client.js';
import { getUserById } from './zitadel-user-search-client.js';
import { logger } from './logger.js';

const APP_CACHE_TTL_SEC = 10 * 60;
const USER_CACHE_TTL_SEC = 24 * 60 * 60;

const APP_KEY = (clientId: string): string => `zitadel-app:v1:${clientId}`;
const USER_KEY = (userId: string): string => `zitadel-user-email:v1:${userId}`;
const NEGATIVE_SENTINEL = '__none__';

export async function resolveAppSlug(clientId: string | undefined): Promise<string | undefined> {
  if (!clientId) return undefined;
  const key = APP_KEY(clientId);

  try {
    const cached = await redis.get(key);
    if (cached === NEGATIVE_SENTINEL) return undefined;
    if (cached) return cached;
  } catch {
    // Redis miss — proceed to DB
  }

  try {
    const res = await writerPool.query<{ slug: string }>(
      'SELECT slug FROM rbac.apps WHERE zitadel_client_id = $1 LIMIT 1',
      [clientId],
    );
    const slug = res.rows[0]?.slug;
    // Cache both hit + negative (avoid DB spam for unknown client_ids)
    await redis
      .set(key, slug ?? NEGATIVE_SENTINEL, 'EX', APP_CACHE_TTL_SEC)
      .catch(() => {}); // cache failure non-fatal
    return slug;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ clientId, err: msg }, 'zitadel-event-enrichment: app slug lookup failed');
    return undefined;
  }
}

export async function resolveUserEmail(
  userId: string | undefined,
  orgId: string | undefined,
): Promise<string | undefined> {
  if (!userId || userId === 'SYSTEM' || userId === 'unknown' || !orgId) return undefined;
  const key = USER_KEY(userId);

  try {
    const cached = await redis.get(key);
    if (cached === NEGATIVE_SENTINEL) return undefined;
    if (cached) return cached;
  } catch {
    // Redis miss — proceed to API
  }

  try {
    const user = await getUserById(userId, orgId);
    const email = user?.email;
    await redis
      .set(key, email ?? NEGATIVE_SENTINEL, 'EX', USER_CACHE_TTL_SEC)
      .catch(() => {});
    return email;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ userId, orgId, err: msg }, 'zitadel-event-enrichment: user email lookup failed');
    return undefined;
  }
}
