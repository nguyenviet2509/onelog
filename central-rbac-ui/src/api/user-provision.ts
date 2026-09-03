/**
 * api/user-provision.ts — Phase 02 admin user lifecycle endpoints.
 *
 * POST /v1/users                — create user + Zitadel invite email
 * POST /v1/users/:id/deactivate — block new logins
 * POST /v1/users/:id/reactivate — restore login
 *
 * All 3 endpoints backend-gated to rbac.admin.
 */
import { apiClient } from './client';

export type ProvisionMode = 'setup_later' | 'invite_email' | 'set_password';

export interface CreateUserPayload {
  email: string;
  first_name: string;
  last_name: string;
  display_name?: string;
  org_id?: string;
  mode: ProvisionMode;
  password?: string;
  password_change_required?: boolean;
  preferred_language?: string;
}

export interface CreateUserResponse {
  id: string;
  email: string;
  already_existed: boolean;
}

export interface PasswordPolicy {
  minLength: number;
  hasUppercase: boolean;
  hasLowercase: boolean;
  hasNumber: boolean;
  hasSymbol: boolean;
}

export interface UserProvisionConfig {
  smtp_enabled: boolean;
  password_policy: PasswordPolicy;
}

export async function getUserProvisionConfig(): Promise<UserProvisionConfig> {
  const res = await apiClient.get<UserProvisionConfig>('/users/config');
  return res.data;
}

export async function createUser(payload: CreateUserPayload): Promise<CreateUserResponse> {
  const res = await apiClient.post<CreateUserResponse>('/users', payload);
  return res.data;
}

export async function deactivateUser(userId: string, orgId?: string): Promise<void> {
  await apiClient.post(`/users/${userId}/deactivate`, orgId ? { org_id: orgId } : {});
}

export async function reactivateUser(userId: string, orgId?: string): Promise<void> {
  await apiClient.post(`/users/${userId}/reactivate`, orgId ? { org_id: orgId } : {});
}
