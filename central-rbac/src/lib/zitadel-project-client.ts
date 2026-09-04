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

export interface ProjectAcrossOrg {
  id: string;
  name: string;
  orgId: string;
  orgName: string;
  state?: string;
}

/**
 * List all owned Zitadel projects across every org the SA has access to.
 *
 * Zitadel's project search is org-scoped (via x-zitadel-orgid header), so we
 * fan out: listAllOrgs → parallel per-org project search. Result includes
 * both `id` (Zitadel project id) and `orgId/orgName` so the UI can group by org.
 *
 * Not cached at this layer — callers (project route, apps route) short-lived
 * request-scoped. If org list stays hot, per-org project searches still hit
 * Zitadel each request; acceptable while org count is small (<20).
 */
export async function listAllProjectsAcrossOrgs(): Promise<ProjectAcrossOrg[]> {
  const { listAllOrgs } = await import('./zitadel-org-client.js');
  const anyOrg = orgId();
  const orgs = await listAllOrgs(anyOrg);
  if (orgs.length === 0) return [];

  const perOrg = await Promise.all(
    orgs.map(async (org) => {
      try {
        const res = await mgmtPost('/management/v1/projects/_search', org.id, {
          query: { offset: '0', limit: 100 },
        });
        if (!res.ok) {
          const body = await res.text().catch(() => '');
          logger.warn({ orgId: org.id, status: res.status, body: body.slice(0, 200) }, 'zitadel-project: search failed for org');
          return [] as ProjectAcrossOrg[];
        }
        const parsed = (await res.json()) as {
          result?: Array<{ id: string; name: string; state?: string }>;
        };
        return (parsed.result ?? [])
          .filter((p) => p.state !== 'PROJECT_STATE_REMOVED')
          .map((p) => ({ id: p.id, name: p.name, orgId: org.id, orgName: org.name, state: p.state }));
      } catch (err) {
        logger.warn({ orgId: org.id, err }, 'zitadel-project: search threw for org');
        return [] as ProjectAcrossOrg[];
      }
    }),
  );

  return perOrg.flat();
}
