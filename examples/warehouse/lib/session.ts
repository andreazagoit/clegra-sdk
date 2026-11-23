import "server-only"

import { getClegraCaller } from "@clegra/sdk/next"
import { headers } from "next/headers"
import { redirect } from "next/navigation"
import { cache } from "react"

import { warehouseApp } from "./app"
import { getAuth } from "./auth"
import { sql } from "./db"
import { ALL_PERMISSIONS, permissionsFor, type Permission } from "./permissions"
import { isWorkspaceInstallation, provisionWorkspace } from "./tenants"
import type { Actor } from "./warehouse"

/**
 * Who is looking at a page or calling a server action: the person signed in to the warehouse itself, in their active
 * organization, or the person a Clegra client shows the warehouse's site to (spec §5.1), signed in by its site ticket.
 */
export type Viewer = {
  userId: string
  name: string
  email: string
  /** The tenant: an organization's id, or a Clegra company's installation (`<company>@<issuer>`). */
  orgId: string
  orgName: string
  role: string
  permissions: ReadonlySet<Permission>
  can(permission: Permission): boolean
  /** Signed in to the warehouse itself, or shown its site by a Clegra client (no sign-out here: the client signs in). */
  via: "warehouse" | "clegra"
  /** Who a change is recorded as: a Clegra person is no user here, so their name is kept with the tenant. */
  actor: Actor
}

/** The person signed in to the warehouse itself, or null. The sign-in and consent pages ask this one only. */
export const sessionViewer = cache(async (): Promise<Viewer | null> => {
  // The request's headers first: this makes every page that asks dynamic, before the database is touched.
  const requestHeaders = await headers()
  const session = await (await getAuth()).api.getSession({ headers: requestHeaders })
  const orgId = session?.session.activeOrganizationId
  if (!session || !orgId) return null
  // The membership is read on every request: a removed member or a changed role counts at once.
  const [m] = await sql<{ role: string; name: string }>(`SELECT m.role, o.name FROM member m JOIN "organization" o ON o.id = m."organizationId" WHERE m."organizationId" = $1 AND m."userId" = $2`, [orgId, session.user.id])
  if (!m) return null
  const permissions = new Set(permissionsFor(m.role))
  const { id, name, email } = session.user
  return { userId: id, name, email, orgId, orgName: m.name, role: m.role, permissions, can: (p) => permissions.has(p), via: "warehouse", actor: { id } }
})

/**
 * The person a Clegra client shows the warehouse's site to, as a viewer: the tenant exactly as the MCP handlers get
 * it (`caller.installation`, its own copy of the demo company made on first use), the permissions the warehouse's
 * roles give them there (`caller.permissions`), nothing more. Null outside a Clegra session.
 */
export const clegraViewer = cache(async (): Promise<Viewer | null> => {
  const caller = await getClegraCaller(warehouseApp)
  if (!caller) return null
  if (isWorkspaceInstallation(caller.installation)) await provisionWorkspace(caller.installation)
  const permissions = new Set(ALL_PERMISSIONS.filter((p) => caller.can(p)))
  const id = caller.person?.id ?? "unknown"
  const name = caller.person?.name ?? caller.email ?? "Clegra"
  return { userId: id, name, email: caller.email ?? "", orgId: caller.installation, orgName: "Clegra", role: caller.admin ? "admin" : "member", permissions, can: (p) => permissions.has(p), via: "clegra", actor: { id, name } }
})

/** Who looks: a Clegra client's person first (in its frame the warehouse's own cookie never arrives), else the own session. */
export const getViewer = cache(async (): Promise<Viewer | null> => (await clegraViewer()) ?? (await sessionViewer()))

export async function requireViewer(): Promise<Viewer> {
  const viewer = await getViewer()
  if (!viewer) redirect("/sign-in")
  return viewer
}

/** For server actions: the viewer, who must hold `permission` (a refusal is an error, not a redirect: the UI never offers it). */
export async function requirePermission(permission: Permission): Promise<Viewer> {
  const viewer = await requireViewer()
  if (!viewer.can(permission)) throw new Error(`You may not do this (${permission}).`)
  return viewer
}
