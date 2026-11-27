import "server-only"

import { headers } from "next/headers"
import { redirect } from "next/navigation"
import { cache } from "react"

import { getAuth } from "./auth"
import { sql } from "./db"
import { permissionsFor, type Permission } from "./permissions"
import type { Actor } from "./warehouse"

/**
 * Who is looking at a page or calling a server action: the person signed in to the warehouse itself, in their active
 * organization; also inside a workspace client's frame (its site, spec §5.1), where it is the same sign-in.
 */
export type Viewer = {
  userId: string
  name: string
  email: string
  /** The tenant: the organization's id. */
  orgId: string
  orgName: string
  role: string
  permissions: ReadonlySet<Permission>
  can(permission: Permission): boolean
  /** Who a change is recorded as. */
  actor: Actor
}

/** The person signed in to the warehouse, or null. */
export const getViewer = cache(async (): Promise<Viewer | null> => {
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
  return { userId: id, name, email, orgId, orgName: m.name, role: m.role, permissions, can: (p) => permissions.has(p), actor: { id } }
})

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
