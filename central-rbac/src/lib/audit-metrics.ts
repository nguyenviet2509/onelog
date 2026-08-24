/**
 * audit-metrics.ts — In-process counters for audit subsystem.
 * Phase 2 will replace with prom-client gauges/counters.
 * Exposed on /v1/health so operators can Grafana-alert on failures.
 */

let auditWriteFailures = 0;

/** Increment the audit write failure counter (called by audit-log middleware). */
export function incrementAuditWriteFailures(): void {
  auditWriteFailures++;
}

/** Read current failure count for health endpoint. */
export function getAuditWriteFailures(): number {
  return auditWriteFailures;
}

/** Reset counter (used in tests). */
export function resetAuditWriteFailures(): void {
  auditWriteFailures = 0;
}
