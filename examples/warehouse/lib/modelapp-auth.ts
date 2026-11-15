import type { ResolvedCaller } from "modelapp"

import { sql } from "./db"
import { permissionsFor } from "./permissions"

/**
 * Who an MCP caller is, once its access token is verified: the person, in the
 * organization the token was issued for, with the permissions of their role
 * there — read live, so a removed member or a changed role counts at once.
 * Null when the person is no longer a member: the call is refused.
 *
 * The token itself (better-auth's MCP access token) is verified by the app's
 * own `auth.resolve`, which then calls this.
 */
export async function callerFor(userId: string, organizationId: string): Promise<ResolvedCaller | null> {
  const [m] = await sql<{ role: string; name: string }>(
    `SELECT m.role, u.name FROM member m JOIN "user" u ON u.id = m."userId" WHERE m."organizationId" = $1 AND m."userId" = $2`,
    [organizationId, userId],
  )
  if (!m) return null
  return { installation: organizationId, person: { id: userId, name: m.name }, permissions: permissionsFor(m.role), subject: userId }
}
