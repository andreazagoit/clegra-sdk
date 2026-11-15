import { randomUUID } from "node:crypto"

import { sql, transaction, type Row, type Sql } from "./db"
import { listPage, type ListPage, type ListQuery, type ListSpec } from "./sql-list"

/**
 * The warehouse itself: every read and write of the app, in plain SQL, always
 * scoped by the organization. The pages, the server actions and the MAP
 * definition all call these same functions.
 */

export const CATEGORIES = ["fasteners", "tools", "electrical", "plumbing", "paint", "garden", "household"] as const
export const UNITS = ["pcs", "box", "kg", "m", "l"] as const
export const STOCK_STATUSES = ["ok", "low", "out"] as const
export const MOVEMENT_KINDS = ["in", "out", "adjustment"] as const
export const ORDER_STATUSES = ["draft", "confirmed", "shipped", "cancelled"] as const

export type Category = (typeof CATEGORIES)[number]
export type Unit = (typeof UNITS)[number]
export type StockStatus = (typeof STOCK_STATUSES)[number]
export type MovementKind = (typeof MOVEMENT_KINDS)[number]
export type OrderStatus = (typeof ORDER_STATUSES)[number]

export type Product = {
  id: string
  sku: string
  name: string
  category: Category
  unit: Unit
  salePrice: number
  purchaseCost: number
  reorderLevel: number
  stock: number
  stockStatus: StockStatus
}

export type Movement = {
  id: string
  product: string
  productName: string
  /** «+20 box Wood screws …»: what happened, in one line. */
  summary: string
  kind: MovementKind
  /** As counted: positive for in and out, signed for an adjustment. */
  quantity: number
  date: string
  note?: string
  /** The user id of who registered it. */
  by?: string
  order?: string
}

export type OrderLine = { product: string; productName: string; quantity: number; unitPrice: number }

export type Order = {
  id: string
  number: string
  customer: string
  status: OrderStatus
  date: string
  total: number
  lineCount: number
  /** When it was confirmed (the goods left), for confirmed and shipped orders. */
  confirmedAt?: string
  lines?: OrderLine[]
}

/** A refusal the person can understand (not found, a conflict with the current state, a wrong value). */
export class WarehouseError extends Error {
  constructor(
    readonly code: "not_found" | "conflict" | "invalid",
    message: string,
  ) {
    super(message)
    this.name = "WarehouseError"
  }
}

const num = (v: unknown) => Number(v ?? 0)
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v))
const newId = (prefix: string) => `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 16)}`

// ------------------------------------------------------------------ products

const PRODUCT_SPEC = (orgId: string): ListSpec => ({
  select: `SELECT * FROM product_stock p`,
  where: [`p.organization_id = $1`],
  params: [orgId],
  columns: {
    id: "p.id",
    sku: "p.sku",
    name: "p.name",
    category: "p.category",
    unit: "p.unit",
    salePrice: "p.sale_price",
    purchaseCost: "p.purchase_cost",
    reorderLevel: "p.reorder_level",
    stock: "p.stock",
    stockStatus: "p.stock_status",
  },
  search: ["name", "sku"],
  defaultSort: { field: "name", dir: "asc" },
  tieBreak: "p.id",
})

const toProduct = (r: Row): Product => ({
  id: String(r.id),
  sku: String(r.sku),
  name: String(r.name),
  category: r.category as Category,
  unit: r.unit as Unit,
  salePrice: num(r.sale_price),
  purchaseCost: num(r.purchase_cost),
  reorderLevel: num(r.reorder_level),
  stock: num(r.stock),
  stockStatus: r.stock_status as StockStatus,
})

export function listProducts(orgId: string, q: ListQuery = {}): Promise<ListPage<Product>> {
  return listPage(sql, PRODUCT_SPEC(orgId), q, toProduct)
}

export async function getProduct(orgId: string, id: string): Promise<Product | null> {
  const [row] = await sql(`SELECT * FROM product_stock WHERE organization_id = $1 AND id = $2`, [orgId, id])
  return row ? toProduct(row) : null
}

/** Products at or under their reorder level, emptiest first. */
export async function lowStock(orgId: string, limit = 10): Promise<Product[]> {
  const rows = await sql(
    `SELECT * FROM product_stock WHERE organization_id = $1 AND stock_status <> 'ok'
     ORDER BY (stock::numeric / GREATEST(reorder_level, 1)) ASC, name ASC LIMIT $2`,
    [orgId, limit],
  )
  return rows.map(toProduct)
}

/** What the stock on hand cost to buy (purchase cost × stock, never negative stock). */
export async function stockValue(orgId: string): Promise<{ value: number; products: number; units: number }> {
  const [r] = await sql(
    `SELECT COALESCE(sum(purchase_cost * GREATEST(stock, 0)), 0) AS value, count(*)::integer AS products, COALESCE(sum(GREATEST(stock, 0)), 0)::integer AS units
     FROM product_stock WHERE organization_id = $1`,
    [orgId],
  )
  return { value: num(r?.value), products: num(r?.products), units: num(r?.units) }
}

// ------------------------------------------------------------------ movements

const MOVEMENT_SELECT = `SELECT m.*, p.name AS product_name, p.unit AS product_unit FROM stock_movement m JOIN product p ON p.id = m.product_id`

const MOVEMENT_SPEC = (orgId: string): ListSpec => ({
  select: MOVEMENT_SELECT,
  where: [`m.organization_id = $1`],
  params: [orgId],
  columns: { id: "m.id", product: "m.product_id", productName: "p.name", summary: "p.name", kind: "m.kind", quantity: "m.quantity", date: "m.occurred_at", note: "m.note", by: "m.user_id", order: "m.order_id" },
  search: ["productName", "note"],
  defaultSort: { field: "date", dir: "desc" },
  tieBreak: "m.id",
})

const signed = (kind: MovementKind, quantity: number) => (kind === "out" ? -quantity : quantity)

const toMovement = (r: Row): Movement => {
  const kind = r.kind as MovementKind
  const quantity = num(r.quantity)
  const delta = signed(kind, quantity)
  const label = kind === "adjustment" ? " (adjustment)" : ""
  return {
    id: String(r.id),
    product: String(r.product_id),
    productName: String(r.product_name),
    summary: `${delta > 0 ? "+" : "−"}${Math.abs(delta)} ${String(r.product_unit)} ${String(r.product_name)}${label}`,
    kind,
    quantity,
    date: iso(r.occurred_at),
    ...(r.note ? { note: String(r.note) } : {}),
    ...(r.user_id ? { by: String(r.user_id) } : {}),
    ...(r.order_id ? { order: String(r.order_id) } : {}),
  }
}

export function listMovements(orgId: string, q: ListQuery = {}): Promise<ListPage<Movement>> {
  return listPage(sql, MOVEMENT_SPEC(orgId), q, toMovement)
}

export async function getMovement(orgId: string, id: string): Promise<Movement | null> {
  const [row] = await sql(`${MOVEMENT_SELECT} WHERE m.organization_id = $1 AND m.id = $2`, [orgId, id])
  return row ? toMovement(row) : null
}

export type MovementInput = { productId: string; kind: MovementKind; quantity: number; note?: string | undefined }

const MAX_QUANTITY = 100_000

/** The stock of products, read inside a transaction after locking their rows (so two writers never both take the last piece). */
async function lockedStock(tx: Sql, orgId: string, productIds: string[]): Promise<Map<string, { name: string; unit: string; stock: number }>> {
  const ids = [...new Set(productIds)].sort()
  const locked = await tx(`SELECT id, name, unit FROM product WHERE organization_id = $1 AND id = ANY($2) ORDER BY id FOR UPDATE`, [orgId, ids])
  const stock = await tx(`SELECT id, stock FROM product_stock WHERE organization_id = $1 AND id = ANY($2)`, [orgId, ids])
  const byId = new Map(stock.map((r) => [String(r.id), num(r.stock)]))
  return new Map(locked.map((r) => [String(r.id), { name: String(r.name), unit: String(r.unit), stock: byId.get(String(r.id)) ?? 0 }]))
}

/** Registers goods in, goods out, or a counted adjustment. Stock never goes below zero. */
export async function registerMovement(orgId: string, userId: string | null, input: MovementInput): Promise<{ movement: Movement; stock: number }> {
  const { productId, kind } = input
  const quantity = Number(input.quantity)
  if (!MOVEMENT_KINDS.includes(kind)) throw new WarehouseError("invalid", `Unknown movement kind "${String(kind)}".`)
  if (!Number.isInteger(quantity) || quantity === 0 || Math.abs(quantity) > MAX_QUANTITY) throw new WarehouseError("invalid", `The quantity must be a whole number between 1 and ${MAX_QUANTITY}.`)
  if (kind !== "adjustment" && quantity < 0) throw new WarehouseError("invalid", "For goods in or out, give a positive quantity.")
  const note = input.note?.trim().slice(0, 500) || null
  return transaction(async (tx) => {
    const product = (await lockedStock(tx, orgId, [productId])).get(productId)
    if (!product) throw new WarehouseError("not_found", "No such product.")
    const after = product.stock + signed(kind, quantity)
    if (after < 0) throw new WarehouseError("conflict", `Only ${product.stock} ${product.unit} of ${product.name} in stock.`)
    const id = newId("mv")
    await tx(`INSERT INTO stock_movement (id, organization_id, product_id, kind, quantity, note, user_id) VALUES ($1, $2, $3, $4, $5, $6, $7)`, [id, orgId, productId, kind, quantity, note, userId])
    const [row] = await tx(`${MOVEMENT_SELECT} WHERE m.id = $1`, [id])
    return { movement: toMovement(row!), stock: after }
  })
}

/** Units that left the warehouse per week (Monday to Sunday), the last `weeks` weeks, oldest first. */
export async function outgoingByWeek(orgId: string, weeks = 8): Promise<{ week: string; units: number }[]> {
  const rows = await sql(
    `SELECT to_char(w.week, 'YYYY-MM-DD') AS week, COALESCE(sum(m.quantity), 0)::integer AS units
     FROM generate_series(date_trunc('week', now()) - (($2::integer - 1) * interval '1 week'), date_trunc('week', now()), interval '1 week') AS w(week)
     LEFT JOIN stock_movement m ON m.organization_id = $1 AND m.kind = 'out' AND m.occurred_at >= w.week AND m.occurred_at < w.week + interval '1 week'
     GROUP BY w.week ORDER BY w.week`,
    [orgId, weeks],
  )
  return rows.map((r) => ({ week: String(r.week), units: num(r.units) }))
}

// ------------------------------------------------------------------ orders

const ORDER_SPEC = (orgId: string): ListSpec => ({
  select: `SELECT o.*, to_char(o.ordered_on, 'YYYY-MM-DD') AS ordered_day FROM sales_order_total o`,
  where: [`o.organization_id = $1`],
  params: [orgId],
  columns: { id: "o.id", number: "o.number", customer: "o.customer_name", status: "o.status", date: "o.ordered_on", total: "o.total", lineCount: "o.line_count" },
  search: ["number", "customer"],
  defaultSort: { field: "date", dir: "desc" },
  tieBreak: "o.id",
})

const toOrder = (r: Row): Order => ({
  id: String(r.id),
  number: String(r.number),
  customer: String(r.customer_name),
  status: r.status as OrderStatus,
  date: String(r.ordered_day),
  total: num(r.total),
  lineCount: num(r.line_count),
  ...(r.confirmed_at ? { confirmedAt: iso(r.confirmed_at) } : {}),
})

export function listOrders(orgId: string, q: ListQuery = {}): Promise<ListPage<Order>> {
  return listPage(sql, ORDER_SPEC(orgId), q, toOrder)
}

async function orderWithLines(run: Sql, orgId: string, id: string): Promise<Order | null> {
  const [row] = await run(`SELECT o.*, to_char(o.ordered_on, 'YYYY-MM-DD') AS ordered_day FROM sales_order_total o WHERE o.organization_id = $1 AND o.id = $2`, [orgId, id])
  if (!row) return null
  const lines = await run(
    `SELECT l.product_id, p.name AS product_name, l.quantity, l.unit_price FROM sales_order_line l JOIN product p ON p.id = l.product_id WHERE l.order_id = $1 ORDER BY l.line_no`,
    [id],
  )
  return { ...toOrder(row), lines: lines.map((l) => ({ product: String(l.product_id), productName: String(l.product_name), quantity: num(l.quantity), unitPrice: num(l.unit_price) })) }
}

export function getOrder(orgId: string, id: string): Promise<Order | null> {
  return orderWithLines(sql, orgId, id)
}

export type OrderInput = { customer: string; lines: { productId: string; quantity: number }[] }

/** A new draft order, at today's sale prices. */
export async function createOrder(orgId: string, userId: string | null, input: OrderInput): Promise<Order> {
  const customer = input.customer.trim()
  if (customer.length < 2 || customer.length > 120) throw new WarehouseError("invalid", "Give the customer's name (2 to 120 characters).")
  if (!input.lines.length || input.lines.length > 50) throw new WarehouseError("invalid", "An order has 1 to 50 lines.")
  for (const l of input.lines) if (!Number.isInteger(l.quantity) || l.quantity < 1 || l.quantity > MAX_QUANTITY) throw new WarehouseError("invalid", `Each quantity is a whole number between 1 and ${MAX_QUANTITY}.`)
  return transaction(async (tx) => {
    const ids = [...new Set(input.lines.map((l) => l.productId))]
    const products = await tx(`SELECT id, sale_price FROM product WHERE organization_id = $1 AND id = ANY($2)`, [orgId, ids])
    const price = new Map(products.map((p) => [String(p.id), p.sale_price]))
    const missing = ids.filter((id) => !price.has(id))
    if (missing.length) throw new WarehouseError("not_found", `No such product: ${missing.join(", ")}.`)
    const year = new Date().getFullYear()
    // Numbers are per organization and year; the unique constraint keeps two concurrent orders from sharing one.
    const [last] = await tx(`SELECT max(substring(number from '\\d+$')::integer) AS n FROM sales_order WHERE organization_id = $1 AND number LIKE $2`, [orgId, `SO-${year}-%`])
    const number = `SO-${year}-${String(num(last?.n) + 1).padStart(4, "0")}`
    const id = newId("ord")
    await tx(`INSERT INTO sales_order (id, organization_id, number, customer_name, status, created_by) VALUES ($1, $2, $3, $4, 'draft', $5)`, [id, orgId, number, customer, userId])
    let lineNo = 0
    for (const l of input.lines) await tx(`INSERT INTO sales_order_line (order_id, line_no, product_id, quantity, unit_price) VALUES ($1, $2, $3, $4, $5)`, [id, ++lineNo, l.productId, l.quantity, price.get(l.productId)])
    return (await orderWithLines(tx, orgId, id))!
  })
}

/**
 * Confirms a draft order: in one transaction the goods leave the warehouse
 * (one `out` movement per line) and the order becomes confirmed. Refused when
 * the order is not a draft or a product is short, and then nothing changes.
 */
export async function confirmOrder(orgId: string, userId: string | null, orderId: string): Promise<Order> {
  return transaction(async (tx) => {
    const [order] = await tx(`SELECT id, number, status FROM sales_order WHERE organization_id = $1 AND id = $2 FOR UPDATE`, [orgId, orderId])
    if (!order) throw new WarehouseError("not_found", "No such order.")
    if (order.status !== "draft") throw new WarehouseError("conflict", `Order ${String(order.number)} is already ${String(order.status)}.`)
    const lines = await tx(`SELECT product_id, sum(quantity)::integer AS quantity FROM sales_order_line WHERE order_id = $1 GROUP BY product_id`, [orderId])
    if (!lines.length) throw new WarehouseError("conflict", `Order ${String(order.number)} has no lines.`)
    const stock = await lockedStock(tx, orgId, lines.map((l) => String(l.product_id)))
    const short = lines.flatMap((l) => {
      const p = stock.get(String(l.product_id))!
      return p.stock < num(l.quantity) ? [`${p.name} (needs ${num(l.quantity)}, ${p.stock} in stock)`] : []
    })
    if (short.length) throw new WarehouseError("conflict", `Not enough stock for order ${String(order.number)}: ${short.join("; ")}.`)
    for (const l of lines) {
      await tx(`INSERT INTO stock_movement (id, organization_id, product_id, kind, quantity, note, user_id, order_id) VALUES ($1, $2, $3, 'out', $4, $5, $6, $7)`, [newId("mv"), orgId, l.product_id, l.quantity, `Order ${String(order.number)}`, userId, orderId])
    }
    await tx(`UPDATE sales_order SET status = 'confirmed', confirmed_at = now(), confirmed_by = $3 WHERE organization_id = $1 AND id = $2`, [orgId, orderId, userId])
    return (await orderWithLines(tx, orgId, orderId))!
  })
}

/** Cancels a draft (a confirmed order has moved goods: it is not cancelled here). */
export async function cancelOrder(orgId: string, orderId: string): Promise<Order> {
  return transaction(async (tx) => {
    const [order] = await tx(`SELECT number, status FROM sales_order WHERE organization_id = $1 AND id = $2 FOR UPDATE`, [orgId, orderId])
    if (!order) throw new WarehouseError("not_found", "No such order.")
    if (order.status !== "draft") throw new WarehouseError("conflict", `Only a draft can be cancelled; order ${String(order.number)} is ${String(order.status)}.`)
    await tx(`UPDATE sales_order SET status = 'cancelled' WHERE organization_id = $1 AND id = $2`, [orgId, orderId])
    return (await orderWithLines(tx, orgId, orderId))!
  })
}

// ------------------------------------------------------------------ people

/** Names of the organization's members by user id (who registered a movement). Ids of other organizations stay unknown. */
export async function memberNames(orgId: string, userIds: string[]): Promise<Record<string, string>> {
  if (!userIds.length) return {}
  const rows = await sql(`SELECT u.id, u.name FROM member m JOIN "user" u ON u.id = m."userId" WHERE m."organizationId" = $1 AND u.id = ANY($2)`, [orgId, userIds])
  return Object.fromEntries(rows.map((r) => [String(r.id), String(r.name)]))
}
