/**
 * zitadel-http.ts — Low-level HTTP transport helpers for Zitadel Management API.
 * Provides mgmtPost, mgmtDelete, mgmtPut with retry-once on 5xx (3s timeout).
 *
 * Consumed by zitadel-mgmt-client.ts — not intended for direct use in routes.
 *
 * SA: Authorization header uses ZITADEL_SA_PAT (PAT, never logged).
 * Phase 5: upgrade to JWT client_credentials (RFC 7523).
 */
import { config } from '../config.js';
import { logger } from './logger.js';

const REQUEST_TIMEOUT_MS = 3000;
const RETRY_DELAY_MS = 500;

/** Build Authorization header — throws if PAT not configured. */
export function getAuthHeader(): string {
  const pat = config.ZITADEL_SA_PAT;
  if (!pat) {
    throw new Error('ZITADEL_SA_PAT is not configured — cannot call Zitadel Mgmt API');
  }
  return `Bearer ${pat}`;
}

/** Build common request headers including org context. */
export function buildHeaders(orgId: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: getAuthHeader(),
    'x-zitadel-orgid': orgId,
    // Zitadel resolves instance from Host header when called via internal Docker alias
    ...(config.ZITADEL_EXTERNAL_HOST ? { Host: config.ZITADEL_EXTERNAL_HOST } : {}),
  };
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** POST to Zitadel Mgmt API — retry once on 5xx after 500ms. */
export async function mgmtPost(path: string, orgId: string, body: unknown): Promise<Response> {
  const url = `${config.ZITADEL_MGMT_URL}${path}`;
  const doRequest = () =>
    fetch(url, {
      method: 'POST',
      headers: buildHeaders(orgId),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

  const res = await doRequest();
  if (res.status >= 500) {
    logger.warn({ status: res.status, path }, 'zitadel-http: 5xx, retrying once');
    await sleep(RETRY_DELAY_MS);
    return doRequest();
  }
  return res;
}

/** DELETE to Zitadel Mgmt API — retry once on 5xx after 500ms. */
export async function mgmtDelete(path: string, orgId: string): Promise<Response> {
  const url = `${config.ZITADEL_MGMT_URL}${path}`;
  const doRequest = () =>
    fetch(url, {
      method: 'DELETE',
      headers: buildHeaders(orgId),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

  const res = await doRequest();
  if (res.status >= 500) {
    logger.warn({ status: res.status, path }, 'zitadel-http: 5xx DELETE, retrying once');
    await sleep(RETRY_DELAY_MS);
    return doRequest();
  }
  return res;
}

/** GET to Zitadel Mgmt API — retry once on 5xx after 500ms. */
export async function mgmtGet(path: string, orgId: string): Promise<Response> {
  const url = `${config.ZITADEL_MGMT_URL}${path}`;
  const doRequest = () =>
    fetch(url, {
      method: 'GET',
      headers: buildHeaders(orgId),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

  const res = await doRequest();
  if (res.status >= 500) {
    logger.warn({ status: res.status, path }, 'zitadel-http: 5xx GET, retrying once');
    await sleep(RETRY_DELAY_MS);
    return doRequest();
  }
  return res;
}

/** PUT to Zitadel Mgmt API — retry once on 5xx after 500ms. */
export async function mgmtPut(path: string, orgId: string, body: unknown): Promise<Response> {
  const url = `${config.ZITADEL_MGMT_URL}${path}`;
  const doRequest = () =>
    fetch(url, {
      method: 'PUT',
      headers: buildHeaders(orgId),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

  const res = await doRequest();
  if (res.status >= 500) {
    logger.warn({ status: res.status, path }, 'zitadel-http: 5xx PUT, retrying once');
    await sleep(RETRY_DELAY_MS);
    return doRequest();
  }
  return res;
}
