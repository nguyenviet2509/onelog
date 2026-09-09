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

export interface AuditListResult {
  rows: AuditLogRow[];
  total: number;
}

export async function listAudit(params: AuditListParams = {}): Promise<AuditListResult> {
  const res = await apiClient.get<{ data: AuditLogRow[]; count: number; total?: number }>('/audit', { params });
  return {
    rows: res.data.data,
    // Fallback = current page count if backend deploy lags (still lets pagination render).
    total: res.data.total ?? res.data.data.length,
  };
}

/**
 * Sentinel the backend recognizes as `app_id IS NULL` (internal rbac events).
 * Kept in sync with APP_ID_NULL_SENTINEL in central-rbac/src/db/queries/audit.ts.
 */
export const APP_ID_NULL_SENTINEL = '__null__';

export interface AuditAppFacet {
  /** null = internal rbac events (backend rows with app_id column NULL). */
  app_id: string | null;
  count: number;
}

export async function listAuditApps(): Promise<AuditAppFacet[]> {
  const res = await apiClient.get<{ apps: AuditAppFacet[] }>('/audit/apps');
  return res.data.apps;
}
