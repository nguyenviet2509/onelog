/**
 * api/audit.ts — GET /v1/audit query with filters.
 * Backend: routes/audit.ts (JWT auth via verifyJwt).
 */
import { apiClient } from './client';

export interface AuditLogRow {
  id: string;
  seq: string;
  ts: string;
  actor_id: string;
  actor_type: string;
  actor_email: string;
  action: string;
  target_type: string;
  target_id: string;
  before_state: unknown;
  after_state: unknown;
  ip: string | null;
  session_id: string | null;
  correlation_id: string | null;
  app_id: string | null;
  row_hash: string;
  prev_hash: string | null;
  chained_hash: string;
}

export interface AuditListParams {
  actor_id?: string;
  action?: string;
  app_id?: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

export async function listAudit(params: AuditListParams = {}): Promise<AuditLogRow[]> {
  const res = await apiClient.get<{ data: AuditLogRow[]; count: number }>('/audit', { params });
  return res.data.data;
}
