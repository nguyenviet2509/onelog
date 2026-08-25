/**
 * lib/types.ts — Shared domain types matching backend API contracts.
 */

export interface Role {
  key: string;
  display_name: string;
  description?: string;
  parent_key?: string | null;
}

export interface Project {
  id: string;
  name: string;
}

export interface Grant {
  id: string;           // grantId from Zitadel
  project_id: string;
  project_name?: string;
  role_keys: string[];
  granted_at?: string;
  granted_by?: string;
}

export interface ZitadelUser {
  id: string;
  email: string;
  display_name: string;
  organization?: string;
  grant_count: number;
}

export interface UserDetail extends ZitadelUser {
  grants: Grant[];
}

export interface AssignmentRequest {
  user_id: string;
  role_key: string;
}

export interface AssignmentResponse {
  status: 'queued';
  operation: string;
  outbox_id: string;
  user_id: string;
  role_key: string;
}

export interface ApiError {
  error: string;
  detail?: string;
  details?: unknown[];
}

export interface BulkGrantResult {
  uid: string;
  email: string;
  status: 'success' | 'failed';
  error?: string;
}
