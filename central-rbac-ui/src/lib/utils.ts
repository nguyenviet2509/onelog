/**
 * lib/utils.ts — Shared utility helpers.
 */
import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Debounce a callback by `delay` ms. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function debounce<T extends (...args: any[]) => void>(
  fn: T,
  delay: number,
): (...args: Parameters<T>) => void {
  let timer: ReturnType<typeof setTimeout>;
  return (...args: Parameters<T>) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

/** Parse `rbac_degraded` claim from a JWT payload (base64url). Returns false on any error. */
export function parseRbacDegraded(token: string | undefined): boolean {
  if (!token) return false;
  try {
    const payload = token.split('.')[1];
    if (!payload) return false;
    const decoded = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))) as Record<string, unknown>;
    return decoded['rbac_degraded'] === true;
  } catch {
    return false;
  }
}

/** Extract permissions array from JWT payload. Returns [] on any error. */
export function parsePermissions(token: string | undefined): string[] {
  if (!token) return [];
  try {
    const payload = token.split('.')[1];
    if (!payload) return [];
    const decoded = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))) as Record<string, unknown>;
    const perms = decoded['permissions'];
    return Array.isArray(perms) ? (perms as string[]) : [];
  } catch {
    return [];
  }
}

/**
 * Extract roles array from JWT payload (`roles` claim set by Zitadel Action).
 * Returns [] on any error.
 */
export function parseRoles(token: string | undefined): string[] {
  if (!token) return [];
  try {
    const payload = token.split('.')[1];
    if (!payload) return [];
    const decoded = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))) as Record<string, unknown>;
    const roles = decoded['roles'];
    return Array.isArray(roles) ? (roles as string[]) : [];
  } catch {
    return [];
  }
}
