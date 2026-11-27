// Who looks at a page or calls a server action (server only). Every page and every action calls it: a server action
// is a public POST endpoint. The person signed in to the CRM itself (better-auth), also inside a workspace client's
// frame (the CRM's site, spec §5.1): there too it is the CRM's own sign-in.
import { headers } from "next/headers"
import { redirect } from "next/navigation"
import { cache } from "react"

import { auth, membership } from "./auth"
import { permissionsForRole, type Permission } from "./permissions"

export type Member = {
  user: { id: string; name: string; email: string }
  /** The tenant: the session's active organization. */
  orgId: string
  organizationName: string
  role: string
  permissions: readonly Permission[]
  can(permission: Permission): boolean
}

/** The person signed in to the CRM, or null. */
export const currentMember = cache(async (): Promise<Member | null> => {
  // The request first: it makes the page dynamic before the database is touched (never at build time).
  const requestHeaders = await headers()
  const session = await auth().api.getSession({ headers: requestHeaders })
  const orgId = session?.session.activeOrganizationId
  if (!session || !orgId) return null
  const m = await membership(orgId, session.user.id)
  if (!m) return null
  const permissions = permissionsForRole(m.role)
  return {
    user: { id: session.user.id, name: session.user.name, email: session.user.email },
    orgId,
    organizationName: m.organizationName,
    role: m.role,
    permissions,
    can: (p) => permissions.includes(p),
  }
})

/** The member, or a redirect to the sign-in page. */
export async function requireMember(): Promise<Member> {
  const member = await currentMember()
  if (!member) redirect("/sign-in")
  return member
}

/** The member, when they hold `permission`; else a plain refusal (pages show it, actions stop). */
export async function requirePermission(permission: Permission): Promise<Member> {
  const member = await requireMember()
  if (!member.can(permission)) throw new Error(`You don't have the permission "${permission}".`)
  return member
}

/** Who records a change. */
export const ownerOf = (member: Member): { id: string } => ({ id: member.user.id })
