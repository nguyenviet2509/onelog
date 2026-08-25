/**
 * token-bucket.ts — In-process token bucket rate limiter.
 *
 * Used by outbox-worker to cap Zitadel Mgmt API calls at `opsPerSec`.
 * Dependency-free: no p-throttle or external lib (YAGNI).
 *
 * Note (L5 / M2): bucket starts full so first tick allows up to opsPerSec ops
 * immediately before the first refill. This burst is acceptable for the current
 * single-worker setup. If central-rbac scales to multiple replicas, replace with
 * a Redis-backed distributed rate limiter (M2 — deferred to Phase 4 backlog).
 */
export class TokenBucket {
  private tokens: number;
  private lastRefill: number;

  constructor(private readonly opsPerSec: number) {
    this.tokens = opsPerSec;
    this.lastRefill = Date.now();
  }

  /**
   * Returns ms to wait before consuming a token; 0 means consume immediately.
   * Caller should await a setTimeout of the returned value before proceeding.
   */
  waitMs(): number {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    const refill = Math.floor((elapsed / 1000) * this.opsPerSec);
    if (refill > 0) {
      this.tokens = Math.min(this.opsPerSec, this.tokens + refill);
      this.lastRefill = now;
    }
    if (this.tokens > 0) {
      this.tokens--;
      return 0;
    }
    // Return time (ms) until next token becomes available
    return Math.ceil(1000 / this.opsPerSec);
  }
}
