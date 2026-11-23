// Who looks at a page or calls a server action (server only). Every page and every action calls it: a server action
// is a public POST endpoint. Two kinds of member: a person signed in to the CRM itself (better-auth), and a person a
// Clegra client shows the CRM's site to (spec §5.1), signed in by the client's site ticket.
import { getClegraCaller } from "@clegra/sdk/next"
import { headers } from "next/headers"
import { redirect } from "next/navigation"
import { cache } from "react"

import { crmApp } from "@/clegra"

import { auth, membership } from "./auth"
import { isWorkspaceInstallation, provisionWorkspace } from "./crm"
import { PERMISSIONS, permissionsForRole, type Permission } from "./permissions"

export type Member = {
  user: { id: string; name: string; email: string }
  /** The tenant: the session's active organization, or a Clegra company's installation (`<company>@<issuer>`). */
  orgId: string
  organizationName: string
  role: string
  permissions: readonly Permission[]
  can(permission: Permission): boolean
  /** Signed in to the CRM itself, or shown the CRM's site by a Clegra client (no sign-out here: the client signs in). */
  via: "crm" | "clegra"
}

/** The person signed in to the CRM itself, or null. The sign-in and consent pages ask this one only. */
export const sessionMember = cache(async (): Promise<Member | null> => {
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
    via: "crm",
  }
})

/**
 * The person a Clegra client shows the CRM's site to, as a member: the tenant exactly as the MCP handlers get it
 * (`caller.installation`, its own copy of the demo data made on first use), the permissions the CRM's roles give
 * them there (`caller.permissions`), nothing more. Null outside a Clegra session.
 */
export const clegraMember = cache(async (): Promise<Member | null> => {
  const caller = await getClegraCaller(crmApp)
  if (!caller) return null
  if (isWorkspaceInstallation(caller.installation)) await provisionWorkspace(caller.installation)
  const permissions = PERMISSIONS.filter((p) => caller.can(p))
  return {
    user: { id: caller.person?.id ?? "unknown", name: caller.person?.name ?? caller.email ?? "Clegra", email: caller.email ?? "" },
    orgId: caller.installation,
    organizationName: "Clegra",
    role: caller.admin ? "admin" : "member",
    permissions,
    can: (p) => permissions.includes(p),
    via: "clegra",
  }
})

/** Who looks: a Clegra client's person first (in its frame the CRM's own cookie never arrives), else the CRM's own session. */
export const currentMember = cache(async (): Promise<Member | null> => (await clegraMember()) ?? (await sessionMember()))

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

/** Who records a change: a Clegra person is no user of the CRM, so their name is kept with the tenant. */
export const ownerOf = (member: Member): { id: string; name?: string } => (member.via === "clegra" ? { id: member.user.id, name: member.user.name } : { id: member.user.id })
