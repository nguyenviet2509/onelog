/**
 * types.ts — Public types cho @onelog/central-rbac-client.
 * Phase 09 (plan 260910-1334) Phase 5.
 */

export interface CentralRbacClientConfig {
  /** Central RBAC base URL (e.g., https://rbacnb.000nethost.com) */
  centralUrl: string;
  /** App slug — this SDK instance resolves permissions cho app này */
  appSlug: string;
  /** Shared X-Rbac-Token secret (từ Central deployment env CENTRAL_RBAC_RESOLVE_TOKEN) */
  centralRbacToken: string;
  /** LRU cache TTL seconds. Default 60. */
  cacheTtlSec?: number;
  /** LRU cache max entries. Default 5000. */
  cacheMaxEntries?: number;
  /** Epoch poll interval seconds. Default 10. */
  epochPollIntervalSec?: number;
  /** Circuit breaker consecutive failure threshold. Default 5. */
  circuitBreakerThreshold?: number;
  /** Circuit breaker half-open reset seconds. Default 30. */
  circuitBreakerResetSec?: number;
  /** HTTP request timeout milliseconds. Default 500. */
  requestTimeoutMs?: number;
  /**
   * Failure mode when Central down:
   *   - 'closed' (default): reject requests (safe production behavior)
   *   - 'open': bypass RBAC allow (DEV ONLY — throws startup error nếu NODE_ENV=production)
   */
  failMode?: 'closed' | 'open';
  /** Optional logger (compatible với pino, console.log). Falls back to console if omitted. */
  logger?: SdkLogger;
}

export interface SdkLogger {
  debug: (obj: unknown, msg?: string) => void;
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
}

export interface ResolveResponse {
  user_sub: string;
  app_slug: string;
  tenant_id: string | null;
  effective_roles: string[];
  permissions: string[];
  epoch: number;
  cached: boolean;
}

export interface PermissionCheck {
  granted: boolean;
  reason?: string;
  resolvedRoles?: string[];
}

export interface EpochResponse {
  app_slug: string;
  epoch: number;
  cached: boolean;
}

/** Extract tenant_id spec dùng bởi Fastify/Express adapter. */
export interface TenantIdFrom {
  /**
   * Location + path key to extract tenant_id.
   *   'query.dept'    → req.query.dept
   *   'params.dept'   → req.params.dept
   *   'headers.x-tid' → req.headers['x-tid']
   *   'body.dept'     → req.body.dept
   */
  from: `query.${string}` | `params.${string}` | `headers.${string}` | `body.${string}`;
}
