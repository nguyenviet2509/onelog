/**
 * zitadel-project-client.ts — Zitadel Mgmt API wrappers for project CRUD.
 * Phase 07 Admin Wizard.
 *
 * Endpoints:
 *   - POST   /management/v1/projects           → AddProject
 *   - POST   /management/v1/projects/_search   → SearchProjects (by name)
 *   - DELETE /management/v1/projects/{id}      → RemoveProject
 *
 * Idempotency: AddProject returns 409 on duplicate name — treat as success + fetch existing.
 * Retry-on-5xx handled by mgmtPost/mgmtDelete (zitadel-http.ts).
 */
import { config } from '../config.js';
import { mgmtPost, mgmtDelete } from './zitadel-http.js';
import { logger } from './logger.js';

export interface ZitadelProject {
  id: string;
  name: string;
  state?: string;
}

function orgId(): string {
  const o = config.ZITADEL_ORG_ID;
  if (!o) throw new Error('ZITADEL_ORG_ID not configured');
  return o;
}

/**
 * Create a Zitadel project. Returns projectId on success.
 * On 409 duplicate name: returns existing project ID via SearchProjects (idempotent).
 */
export async function addProject(name: string): Promise<{ id: string; created: boolean }> {
  const res = await mgmtPost('/management/v1/projects', orgId(), { name });

  if (res.status === 200 || res.status === 201) {
    const body = (await res.json()) as { id: string };
    logger.info({ project_id: body.id, name }, 'zitadel-project: created');
    return { id: body.id, created: true };
  }

  if (res.status === 409) {
    logger.info({ name }, 'zitadel-project: 409 duplicate → fetch existing');
    const existing = await findProjectByName(name);
    if (existing) return { id: existing.id, created: false };
    throw new Error(`Zitadel returned 409 for project "${name}" but SearchProjects found nothing`);
  }

  const errBody = await res.text().catch(() => '');
  throw new Error(`Zitadel AddProject failed ${res.status}: ${errBody}`);
}

/** Search projects by exact name. Returns first match or null. */
export async function findProjectByName(name: string): Promise<ZitadelProject | null> {
  const res = await mgmtPost('/management/v1/projects/_search', orgId(), {
    queries: [{ nameQuery: { name, method: 'TEXT_QUERY_METHOD_EQUALS' } }],
  });
  if (res.status !== 200) {
    const errBody = await res.text().catch(() => '');
    throw new Error(`Zitadel SearchProjects failed ${res.status}: ${errBody}`);
  }
  const body = (await res.json()) as { result?: ZitadelProject[] };
  return body.result?.[0] ?? null;
}

/**
 * Remove a Zitadel project by ID.
 * Returns true on 200/404 (idempotent), throws on other errors.
 * 404 = already removed → treat as success for rollback.
 */
export async function removeProject(projectId: string): Promise<boolean> {
  const res = await mgmtDelete(`/management/v1/projects/${projectId}`, orgId());
  if (res.status === 200 || res.status === 204 || res.status === 404) {
    logger.info({ project_id: projectId, status: res.status }, 'zitadel-project: removed');
    return true;
  }
  const errBody = await res.text().catch(() => '');
  throw new Error(`Zitadel RemoveProject ${projectId} failed ${res.status}: ${errBody}`);
}
