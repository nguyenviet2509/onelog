/**
 * client.ts — CentralRbacClient core class.
 * Phase 09 (plan 260910-1334) Phase 5.
 *
 * Public methods:
 *   - resolve(userSub, tenantId?)      → ResolveResponse
 *   - checkPermission(userSub, key, tenantId?) → PermissionCheck
 *   - getEpoch()                       → number
 *   - flushCache()                     → void
 *   - close()                          → void (stop epoch poller)
 *
 * Behavior:
 *   - Cache LRU keyed by SHA256(user_sub + tenant_id + epoch)
 *   - Circuit breaker rejects requests khi Central down (fail-closed default)
 *   - Epoch poller background, invalidates cache khi epoch changes
 *   - Verifies X-Api-Version: 2 response header
 *   - Production fail-open guard hardcoded (NODE_ENV=production && failMode=open → throw)
 */
import { createHash } from 'node:crypto';
import { request as undiciRequest, type Dispatcher } from 'undici';
import { LRUCache } from 'lru-cache';
import type {
  CentralRbacClientConfig,
  ResolveResponse,
  PermissionCheck,
  SdkLogger,
} from './types.js';
import { CentralRbacError } from './errors.js';
import { CircuitBreaker } from './circuit-breaker.js';
import { EpochPoller } from './epoch-poller.js';

const DEFAULT_CACHE_TTL_SEC = 60;
const DEFAULT_CACHE_MAX_ENTRIES = 5000;
const DEFAULT_EPOCH_POLL_SEC = 10;
const DEFAULT_CB_THRESHOLD = 5;
const DEFAULT_CB_RESET_SEC = 30;
const DEFAULT_TIMEOUT_MS = 500;

const noopLogger: SdkLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: (obj: unknown, msg?: string) => console.warn(msg ?? '', obj),
  error: (obj: unknown, msg?: string) => console.error(msg ?? '', obj),
};

export class CentralRbacClient {
  private readonly cache: LRUCache<string, ResolveResponse>;
  private readonly breaker: CircuitBreaker;
  private readonly poller: EpochPoller;
  private readonly logger: SdkLogger;
  private readonly config: Required<Omit<CentralRbacClientConfig, 'logger'>>;
  private closed = false;

  constructor(inputConfig: CentralRbacClientConfig) {
    // ── Config validation ────────────────────────────────────────────────
    if (!inputConfig.centralUrl) {
      throw new CentralRbacError('RBAC_SDK_CONFIG_ERROR', 'centralUrl required');
    }
    if (!inputConfig.appSlug) {
      throw new CentralRbacError('RBAC_SDK_CONFIG_ERROR', 'appSlug required');
    }
    if (!inputConfig.centralRbacToken) {
      throw new CentralRbacError('RBAC_SDK_CONFIG_ERROR', 'centralRbacToken required');
    }

    const failMode = inputConfig.failMode ?? 'closed';

    // ── HARDCODED production+failMode=open reject (no loophole) ──────────
    if (process.env['NODE_ENV'] === 'production' && failMode === 'open') {
      throw new CentralRbacError(
        'RBAC_SDK_CONFIG_ERROR',
        'failMode=open is DEV ONLY and cannot be used in production. ' +
          'Central down = apps must return 503, never bypass RBAC. ' +
          'If Central is down persistently, fix the root cause (HA setup, incident response).',
      );
    }

    this.logger = inputConfig.logger ?? noopLogger;
    this.config = {
      centralUrl: inputConfig.centralUrl.replace(/\/+$/, ''),
      appSlug: inputConfig.appSlug,
      centralRbacToken: inputConfig.centralRbacToken,
      cacheTtlSec: inputConfig.cacheTtlSec ?? DEFAULT_CACHE_TTL_SEC,
      cacheMaxEntries: inputConfig.cacheMaxEntries ?? DEFAULT_CACHE_MAX_ENTRIES,
      epochPollIntervalSec: inputConfig.epochPollIntervalSec ?? DEFAULT_EPOCH_POLL_SEC,
      circuitBreakerThreshold: inputConfig.circuitBreakerThreshold ?? DEFAULT_CB_THRESHOLD,
      circuitBreakerResetSec: inputConfig.circuitBreakerResetSec ?? DEFAULT_CB_RESET_SEC,
      requestTimeoutMs: inputConfig.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS,
      failMode,
    };

    this.cache = new LRUCache({
      max: this.config.cacheMaxEntries,
      ttl: this.config.cacheTtlSec * 1000,
    });
    this.breaker = new CircuitBreaker(
      this.config.circuitBreakerThreshold,
      this.config.circuitBreakerResetSec * 1000,
    );
    this.poller = new EpochPoller({
      intervalMs: this.config.epochPollIntervalSec * 1000,
      fetchEpoch: () => this.fetchEpoch(),
      onEpochChange: (newEpoch, oldEpoch) => {
        this.logger.info(
          { newEpoch, oldEpoch, appSlug: this.config.appSlug },
          'central-rbac-client: epoch changed, flushing cache',
        );
        this.flushCache();
      },
      logger: this.logger,
    });
    this.poller.start();
  }

  // ── Public API ─────────────────────────────────────────────────────────

  async resolve(userSub: string, tenantId?: string | null): Promise<ResolveResponse> {
    const tid = tenantId ?? null;
    const cacheKey = this.buildCacheKey(userSub, tid);

    const cached = this.cache.get(cacheKey);
    if (cached) {
      this.logger.debug({ userSub, tenantId: tid, cached: true }, 'central-rbac-client: cache hit');
      return { ...cached, cached: true };
    }

    if (!this.breaker.canProceed()) {
      if (this.config.failMode === 'open') {
        this.logger.warn(
          { userSub, appSlug: this.config.appSlug },
          'central-rbac-client: SDK_FAILOPEN_BYPASS — circuit open + failMode=open (DEV ONLY)',
        );
        return this.emptyBypassResponse(userSub, tid);
      }
      throw new CentralRbacError('RBAC_CIRCUIT_OPEN', 'Central unreachable, circuit open (failMode=closed)');
    }

    try {
      const result = await this.callResolve(userSub, tid);
      this.breaker.recordSuccess();
      this.cache.set(cacheKey, result);
      return { ...result, cached: false };
    } catch (err) {
      this.breaker.recordFailure();
      if (this.config.failMode === 'open') {
        this.logger.warn(
          { userSub, appSlug: this.config.appSlug, err },
          'central-rbac-client: SDK_FAILOPEN_BYPASS — call failed + failMode=open (DEV ONLY)',
        );
        return this.emptyBypassResponse(userSub, tid);
      }
      throw err;
    }
  }

  async checkPermission(
    userSub: string,
    permissionKey: string,
    tenantId?: string | null,
  ): Promise<PermissionCheck> {
    const result = await this.resolve(userSub, tenantId);
    const granted = result.permissions.includes(permissionKey);
    return granted
      ? { granted: true, resolvedRoles: result.effective_roles }
      : { granted: false, reason: `permission '${permissionKey}' not in resolved set`, resolvedRoles: result.effective_roles };
  }

  async getEpoch(): Promise<number> {
    return this.fetchEpoch();
  }

  flushCache(): void {
    this.cache.clear();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.poller.stop();
    this.cache.clear();
  }

  // ── Internal HTTP ──────────────────────────────────────────────────────

  private async callResolve(userSub: string, tenantId: string | null): Promise<ResolveResponse> {
    const url = `${this.config.centralUrl}/v2/resolve`;
    const body = JSON.stringify({
      user_sub: userSub,
      app_slug: this.config.appSlug,
      tenant_id: tenantId,
    });
    const res = await this.httpPost(url, body);
    const raw = (await res.body.json()) as ResolveResponse;
    return raw;
  }

  private async fetchEpoch(): Promise<number> {
    const url = `${this.config.centralUrl}/v2/epoch/${encodeURIComponent(this.config.appSlug)}`;
    const res = await this.httpGet(url);
    const raw = (await res.body.json()) as { epoch: number };
    return raw.epoch;
  }

  private async httpPost(url: string, body: string): Promise<Dispatcher.ResponseData> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);
    try {
      const res = await undiciRequest(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-rbac-token': this.config.centralRbacToken,
        },
        body,
        signal: controller.signal,
      });
      this.verifyResponse(res, url);
      return res;
    } catch (err) {
      throw this.wrapNetworkError(err, url);
    } finally {
      clearTimeout(timer);
    }
  }

  private async httpGet(url: string): Promise<Dispatcher.ResponseData> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);
    try {
      const res = await undiciRequest(url, {
        method: 'GET',
        headers: { 'x-rbac-token': this.config.centralRbacToken },
        signal: controller.signal,
      });
      this.verifyResponse(res, url);
      return res;
    } catch (err) {
      throw this.wrapNetworkError(err, url);
    } finally {
      clearTimeout(timer);
    }
  }

  private verifyResponse(res: Dispatcher.ResponseData, url: string): void {
    // Verify X-Api-Version = 2 (throw RBAC_MANIFEST_MISMATCH nếu Central return v1)
    const apiVersion = res.headers['x-api-version'];
    if (apiVersion !== '2' && apiVersion !== undefined) {
      throw new CentralRbacError(
        'RBAC_MANIFEST_MISMATCH',
        `Central returned X-Api-Version=${String(apiVersion)}, expected 2. Check Central deploy version.`,
      );
    }

    if (res.statusCode === 401) {
      throw new CentralRbacError('RBAC_INVALID_TOKEN', 'X-Rbac-Token rejected by Central', {
        httpStatus: 401,
      });
    }
    if (res.statusCode === 404) {
      throw new CentralRbacError('RBAC_APP_NOT_FOUND', `Central 404: ${url}`, { httpStatus: 404 });
    }
    if (res.statusCode >= 500) {
      throw new CentralRbacError('RBAC_CENTRAL_5XX', `Central 5xx: ${res.statusCode}`, {
        httpStatus: res.statusCode,
      });
    }
    if (res.statusCode >= 400) {
      throw new CentralRbacError('RBAC_CENTRAL_4XX', `Central 4xx: ${res.statusCode}`, {
        httpStatus: res.statusCode,
      });
    }
  }

  private wrapNetworkError(err: unknown, url: string): CentralRbacError {
    if (err instanceof CentralRbacError) return err;
    const msg = err instanceof Error ? err.message : String(err);
    return new CentralRbacError('RBAC_CENTRAL_UNREACHABLE', `Central ${url} unreachable: ${msg}`, {
      cause: err,
    });
  }

  private buildCacheKey(userSub: string, tenantId: string | null): string {
    return createHash('sha256')
      .update(`${userSub}|${this.config.appSlug}|${tenantId ?? 'NULL'}`)
      .digest('hex');
  }

  private emptyBypassResponse(userSub: string, tenantId: string | null): ResolveResponse {
    return {
      user_sub: userSub,
      app_slug: this.config.appSlug,
      tenant_id: tenantId,
      effective_roles: [],
      permissions: [],
      epoch: 0,
      cached: false,
    };
  }
}
