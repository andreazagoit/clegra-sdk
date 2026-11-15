// The demo accounts and data (invented). `npm run db:seed`; safe to run again:
// existing accounts get the current DEMO_PASSWORD, existing organizations keep their data.
import { member, organization, tenants } from "@/db/schema"

import { auth } from "./auth"
import { insertTenantData } from "./crm"
import { db } from "./db"
import { DEMO_USERS, ORGANIZATIONS, type OwnerKey } from "./demo-data"

export type SeedReport = { users: Record<OwnerKey, string>; created: string[]; kept: string[] }

export async function seed(password: string | undefined): Promise<SeedReport> {
  if (!password || password.length < 12) throw new Error("DEMO_PASSWORD must be set, at least 12 characters (`npm run setup` generates one in .env.local).")
  const ctx = await auth().$context
  const hash = await ctx.password.hash(password)

  const users = {} as Record<OwnerKey, string>
  for (const u of DEMO_USERS) {
    const found = await ctx.internalAdapter.findUserByEmail(u.email)
    if (found) {
      await ctx.internalAdapter.updatePassword(found.user.id, hash)
      users[u.key] = found.user.id
      continue
    }
    const created = await ctx.internalAdapter.createUser({ name: u.name, email: u.email, emailVerified: true }, { method: "admin" })
    await ctx.internalAdapter.linkAccount({ providerId: "credential", accountId: created.id, userId: created.id, password: hash })
    users[u.key] = created.id
  }

  const report: SeedReport = { users, created: [], kept: [] }
  for (const org of ORGANIZATIONS) {
    const made = await db().transaction(async (tx) => {
      const [row] = await tx.insert(organization).values({ id: org.id, name: org.name, slug: org.slug, createdAt: new Date() }).onConflictDoNothing().returning({ id: organization.id })
      if (!row) return false
      const members = DEMO_USERS.filter((u) => u.organization === org.id)
      await tx.insert(member).values(members.map((u) => ({ id: `${org.id}_${u.key}`, organizationId: org.id, userId: users[u.key], role: u.role, createdAt: new Date() })))
      await tx.insert(tenants).values({ id: org.id, kind: "organization" })
      await insertTenantData(tx, org.id, org.data, users)
      return true
    })
    ;(made ? report.created : report.kept).push(org.name)
  }
  return report
}
