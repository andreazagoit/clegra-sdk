import "server-only"

import { headers } from "next/headers"
import { redirect } from "next/navigation"
import { cache } from "react"

import { getAuth } from "./auth"
import { sql } from "./db"
import { permissionsFor, type Permission } from "./permissions"

/** Who is looking at a page or calling a server action: the signed-in person in their active organization. */
export type Viewer = {
  userId: string
  name: string
  email: string
  orgId: string
  orgName: string
  role: string
  permissions: ReadonlySet<Permission>
  can(permission: Permission): boolean
}

/** The viewer of this request, or null when nobody is signed in (or the person belongs to no organization any more). */
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
  return { userId: session.user.id, name: session.user.name, email: session.user.email, orgId, orgName: m.name, role: m.role, permissions, can: (p) => permissions.has(p) }
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
