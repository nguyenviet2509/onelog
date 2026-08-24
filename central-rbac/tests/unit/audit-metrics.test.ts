/**
 * audit-metrics.test.ts — Unit tests for in-process audit failure counter.
 * Simple coverage + correctness tests for the audit-metrics singleton.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  getAuditWriteFailures,
  incrementAuditWriteFailures,
  resetAuditWriteFailures,
} from '../../src/lib/audit-metrics.js';

describe('audit-metrics', () => {
  beforeEach(() => {
    resetAuditWriteFailures();
  });

  it('starts at 0 after reset', () => {
    expect(getAuditWriteFailures()).toBe(0);
  });

  it('increments by 1 on each call', () => {
    incrementAuditWriteFailures();
    expect(getAuditWriteFailures()).toBe(1);

    incrementAuditWriteFailures();
    expect(getAuditWriteFailures()).toBe(2);
  });

  it('resets to 0', () => {
    incrementAuditWriteFailures();
    incrementAuditWriteFailures();
    resetAuditWriteFailures();
    expect(getAuditWriteFailures()).toBe(0);
  });

  it('counts independently per increment', () => {
    for (let i = 0; i < 5; i++) incrementAuditWriteFailures();
    expect(getAuditWriteFailures()).toBe(5);
  });
});
