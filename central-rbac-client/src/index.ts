/**
 * index.ts — Public entry point cho @onelog/central-rbac-client.
 * Phase 09 (plan 260910-1334) Phase 5.
 */
export { CentralRbacClient } from './client.js';
export { CentralRbacError, type ErrorCode } from './errors.js';
export type {
  CentralRbacClientConfig,
  ResolveResponse,
  PermissionCheck,
  EpochResponse,
  SdkLogger,
  TenantIdFrom,
} from './types.js';
