/**
 * constant-time-compare.ts — Timing-safe string comparison for shared secrets.
 * Prevents timing attacks on token comparison.
 */
import { timingSafeEqual } from 'node:crypto';

/**
 * Compare two strings in constant time.
 * Returns false immediately if lengths differ (length IS observable, but
 * that's acceptable for shared-secret tokens of fixed expected length).
 */
export function constantTimeCompare(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, 'utf8');
  const bBuf = Buffer.from(b, 'utf8');
  // Byte-length must match before timingSafeEqual (different byte lengths = false)
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}
