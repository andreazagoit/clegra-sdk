// What a member of an organization may do, from their better-auth role.
// The same list is the Clegra app's `permissions` (clegra/app.ts): the UI and
// MCP callers are held to the same rules.

export const PERMISSIONS = ["deals.view", "deals.edit", "deals.values", "contacts.edit"] as const
export type Permission = (typeof PERMISSIONS)[number]

/** Every member: see and change deals, log calls. Money (`deals.values`) only for owners and admins. */
const MEMBER: readonly Permission[] = ["deals.view", "deals.edit", "contacts.edit"]

/** A role as better-auth stores it (`"member"`, `"admin"`, or several, comma-separated). */
export function permissionsForRole(role: string): readonly Permission[] {
  const roles = role.split(",").map((r) => r.trim())
  if (roles.includes("owner") || roles.includes("admin")) return PERMISSIONS
  if (roles.includes("member")) return MEMBER
  return []
}
