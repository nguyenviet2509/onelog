/**
 * zitadel-mgmt-client.ts — Re-export barrel for Zitadel Management API operations.
 *
 * Consumers import from this file; implementation lives in:
 *   - zitadel-http.ts               HTTP transport (mgmtPost/Delete/Put + auth headers)
 *   - zitadel-user-grants-client.ts listUserGrants, addUserGrant, updateUserGrant, removeUserGrant
 *   - zitadel-project-roles-client.ts addProjectRole, removeProjectRole, listProjectRoles
 *
 * Split reason (L2 fix 2026-08-25): original file was 391 LOC, over the 200-LOC project rule.
 */

export type { UserGrant, AddUserGrantResult } from './zitadel-user-grants-client.js';
export {
  listUserGrants,
  addUserGrant,
  updateUserGrant,
  removeUserGrant,
} from './zitadel-user-grants-client.js';

export type { ProjectRole } from './zitadel-project-roles-client.js';
export {
  addProjectRole,
  removeProjectRole,
  listProjectRoles,
} from './zitadel-project-roles-client.js';
