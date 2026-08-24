/**
 * singleflight.ts — In-process request deduplication.
 * When N concurrent callers request the same cache key simultaneously,
 * only 1 backend call is made; all waiters receive the same result.
 *
 * Prevents cache stampede under high concurrent load (e.g., burst of token
 * issuances after a cold start or Redis flush).
 *
 * Intentionally simple: no timeout on the inflight promise — callers must
 * apply their own timeout before calling singleflight (F14 fix).
 */

type Resolver<T> = () => Promise<T>;

// Pending inflight requests keyed by cache key
const inflight = new Map<string, Promise<unknown>>();

/**
 * Execute fn() for key, or wait for an existing inflight call to complete.
 * All concurrent calls with the same key share a single Promise.
 * Once resolved, the entry is removed so future calls get fresh data.
 *
 * @param key   Cache/dedup key — should match the downstream cache key
 * @param fn    Async factory that fetches/computes the value
 * @returns     Resolved value from fn (or shared result from the winning call)
 */
export async function singleflight<T>(key: string, fn: Resolver<T>): Promise<T> {
  const existing = inflight.get(key);
  if (existing) {
    return existing as Promise<T>;
  }

  // Register a placeholder first so concurrent callers can attach immediately,
  // then start fn(). This ensures inflightCount() > 0 as soon as fn() begins.
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const placeholder = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  inflight.set(key, placeholder);

  fn().then(resolve, reject).finally(() => {
    inflight.delete(key);
  });

  return placeholder;
}

/**
 * Returns the number of currently inflight singleflight calls.
 * Useful for health/metrics inspection.
 */
export function inflightCount(): number {
  return inflight.size;
}
