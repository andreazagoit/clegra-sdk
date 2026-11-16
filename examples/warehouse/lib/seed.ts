import { getAuth } from "./auth"
import { sql, transaction } from "./db"
import { COMPANIES, DEMO_USERS, demoPassword, type CompanySlug } from "./demo"
import { AURORA, HUMMINGBIRD, type CompanyData } from "./seed-data"
import { insertCompanyData } from "./tenants"

/**
 * The demo data, idempotent: run it as often as you like (`npm run db:seed`).
 * Users, organizations and memberships go through better-auth (so passwords
 * are hashed its way); the warehouse rows are plain INSERTs with fixed ids
 * and ON CONFLICT DO NOTHING. A changed DEMO_PASSWORD is applied to the demo
 * users on the next run. Each organization's tenant row is made when the
 * organization is created (lib/auth.ts, afterCreateOrganization).
 */

const DATA: Record<CompanySlug, { code: string; data: CompanyData }> = {
  "aurora-hardware": { code: "aur", data: AURORA },
  "hummingbird-crafts": { code: "hum", data: HUMMINGBIRD },
}

export async function seed(log: (line: string) => void = () => undefined): Promise<void> {
  const password = demoPassword()
  const auth = await getAuth()
  const ctx = await auth.$context
  const hash = await ctx.password.hash(password)

  const userIds = new Map<string, string>()
  for (const u of DEMO_USERS) {
    const existing = await ctx.internalAdapter.findUserByEmail(u.email)
    if (existing) {
      await ctx.internalAdapter.updatePassword(existing.user.id, hash)
      userIds.set(u.email, existing.user.id)
      continue
    }
    const user = await ctx.internalAdapter.createUser({ email: u.email, name: u.name, emailVerified: true }, { method: "admin" })
    await ctx.internalAdapter.linkAccount({ userId: user.id, providerId: "credential", accountId: user.id, password: hash })
    userIds.set(u.email, user.id)
    log(`user ${u.email} (${u.role})`)
  }

  for (const [slug, company] of Object.entries(COMPANIES) as [CompanySlug, { name: string }][]) {
    const people = DEMO_USERS.filter((u) => u.company === slug)
    const admin = people.find((u) => u.role === "admin")!
    let [org] = await sql<{ id: string }>(`SELECT id FROM "organization" WHERE slug = $1`, [slug])
    if (!org) {
      const created = await auth.api.createOrganization({ body: { name: company.name, slug, userId: userIds.get(admin.email)! } })
      if (!created) throw new Error(`could not create the organization ${slug}`)
      org = { id: created.id }
      log(`organization ${company.name}`)
    }
    for (const p of people) {
      const userId = userIds.get(p.email)!
      const [member] = await sql(`SELECT id FROM member WHERE "organizationId" = $1 AND "userId" = $2`, [org.id, userId])
      if (!member) await auth.api.addMember({ body: { userId, organizationId: org.id, role: p.role } })
    }
    const member = people.find((u) => u.role === "member")
    const { code, data } = DATA[slug]
    await transaction((tx) => insertCompanyData(tx, org.id, code, data, { admin: userIds.get(admin.email) ?? null, member: member ? (userIds.get(member.email) ?? null) : null }))
    const [counts] = await sql<{ products: number; movements: number; orders: number }>(
      `SELECT (SELECT count(*) FROM product WHERE tenant_id = $1)::integer AS products, (SELECT count(*) FROM stock_movement WHERE tenant_id = $1)::integer AS movements, (SELECT count(*) FROM sales_order WHERE tenant_id = $1)::integer AS orders`,
      [org.id],
    )
    log(`${company.name}: ${counts!.products} products, ${counts!.movements} movements, ${counts!.orders} orders`)
  }
}
