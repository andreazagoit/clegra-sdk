import { getAuth } from "./auth"
import { sql, transaction, type Sql } from "./db"
import { COMPANIES, DEMO_USERS, demoPassword, type CompanySlug } from "./demo"
import { AURORA, demoGtin, HUMMINGBIRD, type CompanyData } from "./seed-data"

/**
 * The demo data, idempotent: run it as often as you like (`npm run db:seed`).
 * Users, organizations and memberships go through better-auth (so passwords
 * are hashed its way); the warehouse rows are plain INSERTs with fixed ids
 * and ON CONFLICT DO NOTHING. A changed DEMO_PASSWORD is applied to the demo
 * users on the next run.
 */

const DAY = 86_400_000
const keyOf = (sku: string) => sku.toLowerCase().replace(/[^a-z0-9]/g, "")
export const productId = (code: string, sku: string) => `prd_${code}_${keyOf(sku)}`

/** A moment `daysAgo` days before today, at a working hour that varies with `n`. */
function at(daysAgo: number, n: number): string {
  const today = new Date()
  const midnight = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())
  return new Date(midnight - daysAgo * DAY + (8 + (n % 9)) * 3_600_000 + (n % 4) * 900_000).toISOString()
}

/** The warehouse rows of one company, for the organization `orgId`. `code` keeps its ids apart from other companies'. */
export async function seedCompany(orgId: string, code: string, data: CompanyData, people: { admin: string | null; member: string | null }): Promise<void> {
  await transaction(async (tx: Sql) => {
    const year = new Date().getUTCFullYear()
    const price = new Map<string, number>()
    let n = 0
    const move = (id: string, sku: string, kind: "in" | "out" | "adjustment", quantity: number, occurredAt: string, note: string, user: string | null, order: string | null = null) =>
      tx(
        `INSERT INTO stock_movement (id, organization_id, product_id, kind, quantity, occurred_at, note, user_id, order_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (id) DO NOTHING`,
        [id, orgId, productId(code, sku), kind, quantity, occurredAt, note, user, order],
      )

    for (const [index, [sku, name, category, unit, sale, cost, reorder, opening, outs]] of data.products.entries()) {
      price.set(sku, sale)
      await tx(
        `INSERT INTO product (id, organization_id, sku, name, category, unit, sale_price, purchase_cost, reorder_level, gtin) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT DO NOTHING`,
        [productId(code, sku), orgId, sku, name, category, unit, sale, cost, reorder, demoGtin(data.gtinPrefix, index)],
      )
      await move(`mv_${code}_open_${keyOf(sku)}`, sku, "in", opening, at(63, n++), "Opening stock", people.admin)
      let i = 0
      for (const part of outs.split(" ").filter(Boolean)) {
        const [daysAgo, quantity] = part.split(":").map(Number) as [number, number]
        await move(`mv_${code}_out_${keyOf(sku)}_${++i}`, sku, "out", quantity, at(daysAgo, n++), "Counter sale", people.member)
      }
    }
    let i = 0
    for (const [sku, daysAgo, quantity] of data.restocks) await move(`mv_${code}_in_${++i}`, sku, "in", quantity, at(daysAgo, n++), "Delivery from the supplier", people.member)
    i = 0
    for (const [sku, daysAgo, quantity, note] of data.adjustments) await move(`mv_${code}_adj_${++i}`, sku, "adjustment", quantity, at(daysAgo, n++), note, people.admin)

    for (const [num, customer, status, daysAgo, lines] of data.orders) {
      const id = `ord_${code}_${num}`
      const number = `SO-${year}-${String(num).padStart(4, "0")}`
      const day = at(daysAgo, num).slice(0, 10)
      const moved = status === "confirmed" || status === "shipped"
      const inserted = await tx(
        `INSERT INTO sales_order (id, organization_id, number, customer_name, status, ordered_on, confirmed_at, confirmed_by, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT DO NOTHING RETURNING id`,
        [id, orgId, number, customer, status, day, moved ? at(daysAgo, num + 1) : null, moved ? people.admin : null, people.member],
      )
      if (!inserted.length) continue
      let lineNo = 0
      for (const line of lines.split(" ")) {
        const [sku, quantity] = line.split("×") as [string, string]
        await tx(`INSERT INTO sales_order_line (order_id, line_no, product_id, quantity, unit_price) VALUES ($1, $2, $3, $4, $5)`, [id, ++lineNo, productId(code, sku), Number(quantity), price.get(sku)])
        if (moved) await move(`mv_${code}_ord_${num}_${lineNo}`, sku, "out", Number(quantity), at(daysAgo, num + 1), `Order ${number}`, people.admin, id)
      }
    }
    const negative = await tx(`SELECT sku, stock FROM product_stock WHERE organization_id = $1 AND stock < 0`, [orgId])
    if (negative.length) throw new Error(`seed data of ${code} leaves negative stock: ${negative.map((r) => `${String(r.sku)} ${String(r.stock)}`).join(", ")}`)
  })
}

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
    await seedCompany(org.id, code, data, { admin: userIds.get(admin.email) ?? null, member: member ? (userIds.get(member.email) ?? null) : null })
    const [counts] = await sql<{ products: number; movements: number; orders: number }>(
      `SELECT (SELECT count(*) FROM product WHERE organization_id = $1)::integer AS products, (SELECT count(*) FROM stock_movement WHERE organization_id = $1)::integer AS movements, (SELECT count(*) FROM sales_order WHERE organization_id = $1)::integer AS orders`,
      [org.id],
    )
    log(`${company.name}: ${counts!.products} products, ${counts!.movements} movements, ${counts!.orders} orders`)
  }
}
