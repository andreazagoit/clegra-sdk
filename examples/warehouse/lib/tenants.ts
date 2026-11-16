import { createHash } from "node:crypto"

import { sql, transaction, type Sql } from "./db"
import { DEMO_USERS } from "./demo"
import { AURORA, demoGtin, type CompanyData } from "./seed-data"

/**
 * The tenants: a better-auth organization (its tenant row is made with it, lib/auth.ts) or a workspace host's
 * installation (`<installation>@<issuer>`), made here on its first call with its own copy of the demo company.
 */

/** A workspace host's installation (`<installation>@<issuer>`): never a better-auth organization id. */
export const isWorkspaceInstallation = (id: string) => id.includes("@")

const DAY = 86_400_000
const keyOf = (sku: string) => sku.toLowerCase().replace(/[^a-z0-9]/g, "")
export const productId = (code: string, sku: string) => `prd_${code}_${keyOf(sku)}`

/** A moment `daysAgo` days before today, at a working hour that varies with `n`. */
function at(daysAgo: number, n: number): string {
  const today = new Date()
  const midnight = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())
  return new Date(midnight - daysAgo * DAY + (8 + (n % 9)) * 3_600_000 + (n % 4) * 900_000).toISOString()
}

/**
 * The warehouse rows of one company for the tenant `tenantId`, inside the caller's transaction. `code` keeps its
 * ids apart from other tenants'; `people` are the person ids its movements and orders are registered by.
 * Idempotent (fixed ids, ON CONFLICT DO NOTHING).
 */
export async function insertCompanyData(tx: Sql, tenantId: string, code: string, data: CompanyData, people: { admin: string | null; member: string | null }): Promise<void> {
  const year = new Date().getUTCFullYear()
  const price = new Map<string, number>()
  let n = 0
  const move = (id: string, sku: string, kind: "in" | "out" | "adjustment", quantity: number, occurredAt: string, note: string, person: string | null, order: string | null = null) =>
    tx(
      `INSERT INTO stock_movement (id, tenant_id, product_id, kind, quantity, occurred_at, note, person_id, order_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (id) DO NOTHING`,
      [id, tenantId, productId(code, sku), kind, quantity, occurredAt, note, person, order],
    )

  for (const [index, [sku, name, category, unit, sale, cost, reorder, opening, outs]] of data.products.entries()) {
    price.set(sku, sale)
    await tx(
      `INSERT INTO product (id, tenant_id, sku, name, category, unit, sale_price, purchase_cost, reorder_level, gtin) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT DO NOTHING`,
      [productId(code, sku), tenantId, sku, name, category, unit, sale, cost, reorder, demoGtin(data.gtinPrefix, index)],
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
      `INSERT INTO sales_order (id, tenant_id, number, customer_name, status, ordered_on, confirmed_at, confirmed_by, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT DO NOTHING RETURNING id`,
      [id, tenantId, number, customer, status, day, moved ? at(daysAgo, num + 1) : null, moved ? people.admin : null, people.member],
    )
    if (!inserted.length) continue
    let lineNo = 0
    for (const line of lines.split(" ")) {
      const [sku, quantity] = line.split("×") as [string, string]
      await tx(`INSERT INTO sales_order_line (order_id, line_no, product_id, quantity, unit_price) VALUES ($1, $2, $3, $4, $5)`, [id, ++lineNo, productId(code, sku), Number(quantity), price.get(sku)])
      if (moved) await move(`mv_${code}_ord_${num}_${lineNo}`, sku, "out", Number(quantity), at(daysAgo, num + 1), `Order ${number}`, people.admin, id)
    }
  }
  const negative = await tx(`SELECT sku, stock FROM product_stock WHERE tenant_id = $1 AND stock < 0`, [tenantId])
  if (negative.length) throw new Error(`seed data of ${code} leaves negative stock: ${negative.map((r) => `${String(r.sku)} ${String(r.stock)}`).join(", ")}`)
}

/** The ids of an installation's rows: `w` and a digest of the installation (ids are unique across tenants). */
export const workspaceCode = (installation: string) => `w${createHash("sha256").update(installation).digest("hex").slice(0, 16)}`

/** The demo company's admin and member in a workspace copy: person ids of that tenant, named in `person`. */
const DEMO_PEOPLE = (["admin", "member"] as const).map((role) => {
  const u = DEMO_USERS.find((p) => p.company === "aurora-hardware" && p.role === role)!
  return { role, id: `demo-${u.email.split("@")[0]!.replace(/\./g, "-")}`, name: u.name }
})

const provisioned = new Set<string>()

/**
 * A workspace host's installation gets its own copy of the demo company (Aurora Hardware) the first time it calls:
 * one transaction, idempotent (a second caller, also a concurrent one, finds the tenant and adds nothing).
 */
export async function provisionWorkspace(installation: string): Promise<void> {
  if (!isWorkspaceInstallation(installation)) throw new Error(`"${installation}" is not a workspace installation`)
  if (provisioned.has(installation)) return
  await transaction(async (tx) => {
    const created = await tx(`INSERT INTO tenant (id, kind) VALUES ($1, 'workspace') ON CONFLICT (id) DO NOTHING RETURNING id`, [installation])
    if (!created.length) return
    for (const p of DEMO_PEOPLE) await tx(`INSERT INTO person (tenant_id, id, name) VALUES ($1, $2, $3)`, [installation, p.id, p.name])
    const person = (role: "admin" | "member") => DEMO_PEOPLE.find((p) => p.role === role)!.id
    await insertCompanyData(tx, installation, workspaceCode(installation), AURORA, { admin: person("admin"), member: person("member") })
  })
  provisioned.add(installation)
}

// ------------------------------------------------------------------ a workspace installation's lifecycle

export type InstallationState = "enabled" | "disabled" | "uninstalled"

/**
 * What the workspace host last told about its installation (`clegra_installation`). Enabled or disabled: the
 * installation gets its copy of the demo company if it has none yet. Uninstalled: recorded only while its data are
 * still here (after the host's delete there is nothing to mark).
 */
export async function setInstallationState(installation: string, state: InstallationState): Promise<void> {
  if (!isWorkspaceInstallation(installation)) throw new Error(`"${installation}" is not a workspace installation`)
  if (state !== "uninstalled") await provisionWorkspace(installation)
  await sql(
    `INSERT INTO installation_state (tenant_id, state) SELECT $1, $2 WHERE EXISTS (SELECT 1 FROM tenant WHERE id = $1)
     ON CONFLICT (tenant_id) DO UPDATE SET state = excluded.state, changed_at = now()`,
    [installation, state],
  )
}

export async function installationState(installation: string): Promise<InstallationState | null> {
  const [row] = await sql<{ state: InstallationState }>(`SELECT state FROM installation_state WHERE tenant_id = $1`, [installation])
  return row?.state ?? null
}

/**
 * Everything the warehouse keeps for a workspace installation, as plain rows (the host's export): null when it keeps
 * nothing (never called, or deleted). Reads only: an export never provisions the demo company.
 */
export async function exportWorkspace(installation: string) {
  if (!isWorkspaceInstallation(installation)) throw new Error(`"${installation}" is not a workspace installation`)
  const [tenant] = await sql<{ created_at: Date }>(`SELECT created_at FROM tenant WHERE id = $1`, [installation])
  if (!tenant) return null
  const [products, movements, orders, lines, people, state] = await Promise.all([
    sql(`SELECT id, sku, gtin, name, category, unit, sale_price::float8 AS "salePrice", purchase_cost::float8 AS "purchaseCost", reorder_level AS "reorderLevel", stock FROM product_stock WHERE tenant_id = $1 ORDER BY sku`, [installation]),
    sql(`SELECT id, product_id AS product, kind, quantity, occurred_at AS "occurredAt", note, person_id AS person, order_id AS "order" FROM stock_movement WHERE tenant_id = $1 ORDER BY occurred_at, id`, [installation]),
    sql(`SELECT id, number, customer_name AS customer, status, ordered_on::text AS "orderedOn", confirmed_at AS "confirmedAt", confirmed_by AS "confirmedBy", created_by AS "createdBy" FROM sales_order WHERE tenant_id = $1 ORDER BY number`, [installation]),
    sql(`SELECT l.order_id AS "order", l.line_no AS line, l.product_id AS product, l.quantity, l.unit_price::float8 AS "unitPrice" FROM sales_order_line l JOIN sales_order o ON o.id = l.order_id WHERE o.tenant_id = $1 ORDER BY l.order_id, l.line_no`, [installation]),
    sql(`SELECT id, name FROM person WHERE tenant_id = $1 ORDER BY id`, [installation]),
    installationState(installation),
  ])
  return { installation, since: tenant.created_at.toISOString(), state, products, movements, orders: orders.map((o) => ({ ...o, lines: lines.filter((l) => l.order === o.id).map(({ order: _, ...l }) => l) })), people }
}

/**
 * Deletes everything the warehouse keeps for a workspace installation (its tenant row, and with it every row of
 * its own, by the foreign keys), with how many of each there were. Idempotent: again, zeros. A later call of the
 * installation gets a fresh copy of the demo company.
 */
export async function deleteWorkspace(installation: string): Promise<Record<"products" | "movements" | "orders", number>> {
  if (!isWorkspaceInstallation(installation)) throw new Error(`"${installation}" is not a workspace installation`)
  const counts = await transaction(async (tx) => {
    const [n] = await tx<{ products: number; movements: number; orders: number }>(
      `SELECT (SELECT count(*) FROM product WHERE tenant_id = $1)::integer AS products,
              (SELECT count(*) FROM stock_movement WHERE tenant_id = $1)::integer AS movements,
              (SELECT count(*) FROM sales_order WHERE tenant_id = $1)::integer AS orders`,
      [installation],
    )
    await tx(`DELETE FROM tenant WHERE id = $1`, [installation])
    return { products: n?.products ?? 0, movements: n?.movements ?? 0, orders: n?.orders ?? 0 }
  })
  provisioned.delete(installation)
  return counts
}
