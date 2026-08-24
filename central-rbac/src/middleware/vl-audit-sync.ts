/**
 * vl-audit-sync.ts — Dual-write audit entries to VictoriaLogs.
 * Non-blocking: caller does .catch() — failures log but don't throw.
 * Falls back gracefully if VL_INGEST_URL not configured.
 */
import { config } from '../config.js';
import { logger } from '../lib/logger.js';
import type { AuditLogRow } from '../db/queries/audit.js';

export async function sendToVictoriaLogs(entry: AuditLogRow): Promise<void> {
  if (!config.VL_INGEST_URL) return;

  const line = JSON.stringify({
    _time: entry.ts,
    _stream: 'rbac-audit',
    service: 'central-rbac',
    level: 'info',
    audit_id: entry.id,
    actor_id: entry.actor_id,
    actor_email: entry.actor_email,
    action: entry.action,
    target_type: entry.target_type,
    target_id: entry.target_id,
    ip: entry.ip,
    correlation_id: entry.correlation_id,
    chained_hash: entry.chained_hash,
  });

  const res = await fetch(config.VL_INGEST_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-ndjson' },
    body: line + '\n',
    signal: AbortSignal.timeout(3000),
  });

  if (!res.ok) {
    logger.warn({ status: res.status, url: config.VL_INGEST_URL }, 'vl-audit-sync: non-2xx response');
  }
}
