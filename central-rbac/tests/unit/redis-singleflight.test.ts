/**
 * redis-singleflight.test.ts — Unit tests for singleflight dedup.
 * Critical invariant: N concurrent identical calls → exactly 1 backend invocation.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { singleflight, inflightCount } from '../../src/lib/singleflight.js';

describe('singleflight', () => {
  beforeEach(() => {
    // Each test starts with a clean inflight map — singleflight cleans up on resolve
  });

  it('calls fn() once for a single request', async () => {
    const fn = vi.fn().mockResolvedValue('result-a');
    const result = await singleflight('key-1', fn);
    expect(result).toBe('result-a');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('deduplicates 10 concurrent identical calls to 1 backend invocation', async () => {
    let callCount = 0;
    const fn = vi.fn(async () => {
      callCount++;
      // Simulate async backend work
      await new Promise((r) => setTimeout(r, 20));
      return `value-${callCount}`;
    });

    // Fire 10 concurrent calls with the same key
    const results = await Promise.all(
      Array.from({ length: 10 }, () => singleflight('stampede-key', fn)),
    );

    // fn should have been called exactly once
    expect(fn).toHaveBeenCalledTimes(1);
    // All 10 results should be identical (the single call's result)
    expect(new Set(results).size).toBe(1);
    expect(results[0]).toBe('value-1');
  });

  it('allows distinct keys to call fn() independently', async () => {
    const fn = vi.fn(async (key: string) => `result-for-${key}`);
    const fnA = () => fn('a');
    const fnB = () => fn('b');

    const [ra, rb] = await Promise.all([
      singleflight('key-a', fnA),
      singleflight('key-b', fnB),
    ]);

    expect(fn).toHaveBeenCalledTimes(2);
    expect(ra).toBe('result-for-a');
    expect(rb).toBe('result-for-b');
  });

  it('removes inflight entry after resolution so next call invokes fn() again', async () => {
    const fn = vi.fn().mockResolvedValue('fresh-value');

    await singleflight('reuse-key', fn);
    expect(fn).toHaveBeenCalledTimes(1);

    // After first call resolves, a second call should invoke fn() again
    await singleflight('reuse-key', fn);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('removes inflight entry after rejection so next call retries', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('transient failure'))
      .mockResolvedValueOnce('recovered');

    await expect(singleflight('fail-key', fn)).rejects.toThrow('transient failure');
    // After rejection, entry should be cleaned up
    const result = await singleflight('fail-key', fn);
    expect(result).toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('propagates rejection to all concurrent waiters', async () => {
    const fn = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 10));
      throw new Error('backend-error');
    });

    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => singleflight('error-key', fn)),
    );

    // fn called once
    expect(fn).toHaveBeenCalledTimes(1);
    // All 5 should have rejected with the same error
    for (const r of results) {
      expect(r.status).toBe('rejected');
      expect((r as PromiseRejectedResult).reason.message).toBe('backend-error');
    }
  });

  it('inflightCount returns 0 when no calls are active', async () => {
    // Ensure previous tests cleaned up
    await singleflight('count-check', async () => 'ok');
    expect(inflightCount()).toBe(0);
  });

  it('inflightCount returns > 0 while calls are inflight', async () => {
    let capturedCount = 0;
    const fn = vi.fn(async () => {
      capturedCount = inflightCount();
      await new Promise((r) => setTimeout(r, 10));
      return 'done';
    });

    await singleflight('inflight-count-key', fn);
    expect(capturedCount).toBe(1);
    expect(inflightCount()).toBe(0); // cleaned up after
  });
});
