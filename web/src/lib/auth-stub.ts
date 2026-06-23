/**
 * Stub auth — returns the seeded sysadmin user. Swap with real session lookup
 * (OIDC / email+pass) later; callers stay identical.
 */
export type CurrentUser = {
  id: number;
  email: string;
  name: string;
  role: "admin" | "viewer";
};

export function getCurrentUser(): CurrentUser {
  return { id: 1, email: "sysadmin@local", name: "sysadmin", role: "admin" };
}
