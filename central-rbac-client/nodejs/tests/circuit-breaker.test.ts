/**
 * circuit-breaker.test.ts — Unit tests cho 3-state circuit breaker.
 */
import { describe, it, expect } from 'vitest';
import { CircuitBreaker } from '../src/circuit-breaker.js';

describe('CircuitBreaker', () => {
  it('starts in closed state, allows requests', () => {
    const cb = new CircuitBreaker(3, 1000);
    expect(cb.getState()).toBe('closed');
    expect(cb.canProceed()).toBe(true);
  });

  it('stays closed after failures under threshold', () => {
    const cb = new CircuitBreaker(3, 1000);
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.getState()).toBe('closed');
    expect(cb.canProceed()).toBe(true);
  });

  it('opens after consecutive failures reach threshold', () => {
    const cb = new CircuitBreaker(3, 1000);
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.getState()).toBe('open');
    expect(cb.canProceed()).toBe(false);
  });

  it('recordSuccess resets consecutive failures counter', () => {
    const cb = new CircuitBreaker(3, 1000);
    cb.recordFailure();
    cb.recordFailure();
    cb.recordSuccess();
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.getState()).toBe('closed'); // 2 fails after success ≠ threshold
  });

  it('transitions to half-open after resetMs elapses', async () => {
    const cb = new CircuitBreaker(2, 50);
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.getState()).toBe('open');
    await new Promise((r) => setTimeout(r, 60));
    expect(cb.canProceed()).toBe(true); // triggers half-open probe
    expect(cb.getState()).toBe('half-open');
  });

  it('half-open only allows 1 probe at a time (single-flight)', async () => {
    const cb = new CircuitBreaker(1, 50);
    cb.recordFailure();
    await new Promise((r) => setTimeout(r, 60));
    expect(cb.canProceed()).toBe(true);  // probe 1 allowed
    expect(cb.canProceed()).toBe(false); // probe 2 blocked
  });

  it('half-open probe success → closed', async () => {
    const cb = new CircuitBreaker(1, 50);
    cb.recordFailure();
    await new Promise((r) => setTimeout(r, 60));
    cb.canProceed();
    cb.recordSuccess();
    expect(cb.getState()).toBe('closed');
  });

  it('half-open probe failure → back to open', async () => {
    const cb = new CircuitBreaker(1, 50);
    cb.recordFailure();
    await new Promise((r) => setTimeout(r, 60));
    cb.canProceed();
    cb.recordFailure();
    expect(cb.getState()).toBe('open');
  });
});
