/**
 * constant-time-compare.test.ts — Unit tests for timing-safe string comparison.
 */
import { describe, it, expect } from 'vitest';
import { constantTimeCompare } from '../../src/lib/constant-time-compare.js';

describe('constantTimeCompare', () => {
  it('returns true for identical strings', () => {
    expect(constantTimeCompare('secret-token-abc', 'secret-token-abc')).toBe(true);
  });

  it('returns false for different strings of same length', () => {
    expect(constantTimeCompare('secret-token-abc', 'secret-token-xyz')).toBe(false);
  });

  it('returns false for different length strings', () => {
    expect(constantTimeCompare('short', 'longer-string')).toBe(false);
  });

  it('returns false for empty vs non-empty', () => {
    expect(constantTimeCompare('', 'something')).toBe(false);
  });

  it('returns true for empty vs empty', () => {
    expect(constantTimeCompare('', '')).toBe(true);
  });

  it('returns false for case difference', () => {
    expect(constantTimeCompare('Token', 'token')).toBe(false);
  });

  it('returns false for unicode vs ascii lookalike', () => {
    // 'a' (U+0061, 1 byte UTF-8) vs 'а' (Cyrillic U+0430, 2 bytes UTF-8)
    // Byte-length check catches this; timingSafeEqual never called
    expect(constantTimeCompare('a', 'а')).toBe(false);
  });

  it('handles long strings correctly', () => {
    const long = 'x'.repeat(1000);
    expect(constantTimeCompare(long, long)).toBe(true);
    expect(constantTimeCompare(long, long.slice(0, -1) + 'y')).toBe(false);
  });
});
