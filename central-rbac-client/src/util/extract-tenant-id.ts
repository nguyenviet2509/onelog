/**
 * util/extract-tenant-id.ts — Parse `tenantIdFrom` spec + extract value từ request.
 *
 * Spec format: `${location}.${key}` where location = query | params | headers | body.
 * Only string values accepted — no coercion (chống injection).
 * Returns null nếu missing / not string.
 */

export function extractTenantId(request: unknown, spec: string): string | null {
  if (!request || typeof request !== 'object') return null;
  const dotIdx = spec.indexOf('.');
  if (dotIdx === -1) return null;

  const location = spec.slice(0, dotIdx);
  const key = spec.slice(dotIdx + 1);

  const req = request as Record<string, unknown>;
  const source = req[location];
  if (!source || typeof source !== 'object') return null;

  const value = (source as Record<string, unknown>)[key];
  if (typeof value !== 'string' || value.length === 0) return null;

  return value;
}
