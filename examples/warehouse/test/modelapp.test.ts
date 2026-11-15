// The warehouse as a MAP app, over the real HTTP path (testClient), on a seeded in-memory PGlite.
// Callers are the app's own users: a test resolver stands in for the better-auth token check and then
// maps the person through `callerFor` (live membership and role → permissions), exactly as production does.
import assert from "node:assert/strict"
import { randomBytes } from "node:crypto"
import { readFileSync } from "node:fs"
import { after, before, describe, test } from "node:test"

import { SqlStore, type AuthOptions } from "@modelapp/server"
import { testClient } from "@modelapp/server/testing"

process.env.PGLITE_DIR = "memory://"
process.env.BETTER_AUTH_SECRET = randomBytes(32).toString("base64url")
process.env.DEMO_PASSWORD = randomBytes(12).toString("base64url")

const { closeDb, sql } = await import("../lib/db")
const { migrate } = await import("../lib/migrate")
const { seed, seedCompany } = await import("../lib/seed")
const { AURORA } = await import("../lib/seed-data")
const { callerFor } = await import("../lib/modelapp-auth")
const { createWarehouseApp } = await import("../lib/modelapp")

type Client = Awaited<ReturnType<typeof testClient>>
type Rows = { rows: Record<string, unknown>[]; next?: string; total?: number }

// A workspace host's installation is a tenant of its own (`<installation>@<issuer>`); the test gives it Aurora's data.
const WORKSPACE = "ws-aurora"
const WORKSPACE_TENANT = `${WORKSPACE}@modelapp-dev`

const tokens = new Map<string, { userId: string; orgId: string }>()
const auth: AuthOptions = {
  resolve: async (token) => {
    const t = tokens.get(token)
    return t ? callerFor(t.userId, t.orgId) : null
  },
  dev: { keyFile: false, installation: WORKSPACE, people: [{ id: "ws-person", name: "Workspace person", permissions: "all" }] },
}
const app = createWarehouseApp({ auth })

const ids: Record<string, { userId: string; orgId: string }> = {}
async function as(email: string): Promise<Client> {
  const token = randomBytes(16).toString("hex")
  tokens.set(token, ids[email]!)
  return testClient(app, { token })
}
const workspace = () => testClient(app, { host: "workspace", installation: WORKSPACE, person: "ws-person", permissions: "all" })

const rows = (r: { structuredContent?: Record<string, unknown> }) => r.structuredContent as unknown as Rows
const errorOf = (r: { isError?: boolean; structuredContent?: Record<string, unknown> }) => (r.isError ? ((r.structuredContent?.error as { code: string; message: string }) ?? { code: "?", message: "" }) : null)
const stockOf = async (orgId: string, productId: string) => Number((await sql<{ stock: number }>(`SELECT stock FROM product_stock WHERE organization_id = $1 AND id = $2`, [orgId, productId]))[0]?.stock)

let ada: Client, luca: Client, sofia: Client
let aurora = "", colibri = ""

before(async () => {
  await migrate()
  await seed()
  for (const r of await sql<{ email: string; userId: string; orgId: string }>(`SELECT u.email, u.id AS "userId", m."organizationId" AS "orgId" FROM "user" u JOIN member m ON m."userId" = u.id`)) ids[r.email] = { userId: r.userId, orgId: r.orgId }
  aurora = ids["ada.ferri@aurora.example"]!.orgId
  colibri = ids["sofia.greco@colibri.example"]!.orgId
  await sql(`INSERT INTO "organization" (id, name, slug, "createdAt") VALUES ($1, 'Ferramenta Aurora (workspace)', 'ws-aurora', now())`, [WORKSPACE_TENANT])
  await seedCompany(WORKSPACE_TENANT, "wsa", AURORA, { admin: null, member: null })
  ada = await as("ada.ferri@aurora.example")
  luca = await as("luca.marini@aurora.example")
  sofia = await as("sofia.greco@colibri.example")
})

after(async () => {
  await closeDb()
})

describe("tenant isolation", () => {
  test("each organization sees its own records only", async () => {
    const a = rows(await ada.call("product_list", { limit: 100 }))
    assert.equal(a.total, 25)
    assert.ok(a.rows.every((r) => String(r.id).startsWith("prd_aur_")))
    const s = rows(await sofia.call("product_list", { limit: 100 }))
    assert.equal(s.total, 6)
    assert.ok(s.rows.every((r) => String(r.id).startsWith("prd_col_")))
    assert.equal(rows(await sofia.call("order_list", {})).total, 3)
    assert.equal(rows(await sofia.call("product_list", { query: "screw" })).total, 0, "Aurora's screws are not found from Colibrì")
  })

  test("another organization's record is not found, and can't be acted on", async () => {
    assert.equal(errorOf(await ada.call("product_get", { id: "prd_col_cansoy" }))?.code, "not_found")
    assert.equal(errorOf(await sofia.call("order_get", { id: "ord_aur_9" }))?.code, "not_found")
    const before = await stockOf(colibri, "prd_col_cansoy")
    assert.equal(errorOf(await ada.call("product_register_movement", { id: "prd_col_cansoy", kind: "out", quantity: 1 }))?.code, "not_found")
    assert.equal(await stockOf(colibri, "prd_col_cansoy"), before)
  })

  test("a caller who left the organization is refused", async () => {
    const token = randomBytes(16).toString("hex")
    tokens.set(token, { userId: ids["sofia.greco@colibri.example"]!.userId, orgId: aurora })
    const c = await testClient(app, { token })
    assert.equal(c.status, 401)
  })
})

describe("purchase cost (products.cost)", () => {
  test("an admin sees it in rows and records", async () => {
    const r = rows(await ada.call("product_list", { query: "drill" }))
    assert.equal(r.rows[0]?.purchaseCost, 78)
    const rec = (await ada.call("product_get", { id: "prd_aur_tra18v" })).structuredContent?.record as Record<string, unknown>
    assert.equal(rec.purchaseCost, 78)
  })

  test("a member never gets it: not in rows, records, filters nor sorts", async () => {
    const r = rows(await luca.call("product_list", { limit: 100 }))
    assert.equal(r.rows.length, 25)
    assert.ok(r.rows.every((row) => !("purchaseCost" in row)))
    const rec = (await luca.call("product_get", { id: "prd_aur_tra18v" })).structuredContent?.record as Record<string, unknown>
    assert.equal(rec.salePrice, 129)
    assert.ok(!("purchaseCost" in rec))
    // Not even a parameter of the member's list tool: refused before the handler runs.
    const sorted = await luca.call("product_list", { sort: "purchaseCost", dir: "desc" })
    assert.ok(sorted.isError && /sort/.test(sorted.content?.[0]?.text ?? ""))
    const filtered = await luca.call("product_list", { purchaseCost: { gte: 50 } })
    assert.ok(filtered.isError && /purchaseCost/.test(filtered.content?.[0]?.text ?? ""))
    const tool = (await luca.listTools()).find((t) => t.name === "product_list")!
    assert.ok(!JSON.stringify(tool.inputSchema).includes("purchaseCost"))
  })

  test("the stock value fragment is for admins only", async () => {
    assert.ok(!(await luca.listTools()).some((t) => t.name === "show_stock_value"))
    const r = await ada.call("show_stock_value", {})
    const [expected] = await sql<{ v: string }>(`SELECT sum(purchase_cost * GREATEST(stock, 0)) AS v FROM product_stock WHERE organization_id = $1`, [aurora])
    assert.equal((r.structuredContent?.data as { value: number }).value, Number(expected!.v))
  })
})

describe("lists: filters, sort, search, cursor", () => {
  test("filters by value, by range and by status", async () => {
    assert.equal(rows(await ada.call("product_list", { category: "tools" })).total, 5)
    assert.equal(rows(await ada.call("product_list", { stockStatus: "out" })).rows[0]?.sku, "SMA-BL")
    const low = rows(await ada.call("product_list", { stock: { lte: 5 }, limit: 100 }))
    assert.ok(low.total! > 0 && low.rows.every((r) => Number(r.stock) <= 5))
    const tools = rows(await luca.call("product_list", { category: { in: ["tools", "garden"] }, limit: 100 }))
    assert.ok(tools.rows.every((r) => r.category === "tools" || r.category === "garden"))
  })

  test("sorts by a declared field, and refuses any other", async () => {
    const byStock = rows(await ada.call("product_list", { sort: "stock", dir: "asc", limit: 100 })).rows.map((r) => Number(r.stock))
    assert.deepEqual(byStock, [...byStock].sort((a, b) => a - b))
    const byCost = rows(await ada.call("product_list", { sort: "purchaseCost", dir: "desc" })).rows
    assert.equal(byCost[0]?.sku, "TRA-18V")
    assert.ok((await ada.call("product_list", { sort: "reorderLevel" })).isError)
  })

  test("searches the search fields only, case-insensitive, with SQL wildcards taken literally", async () => {
    assert.deepEqual(rows(await ada.call("product_list", { query: "SCREW", sort: "sku" })).rows.map((r) => r.sku), ["CAC-SET", "VIT-440", "VIT-660"])
    assert.equal(rows(await ada.call("product_list", { query: "vit-" })).total, 2, "by SKU")
    assert.equal(rows(await ada.call("product_list", { query: "%" })).total, 0)
    assert.equal(rows(await ada.call("order_list", { query: "tigli" })).total, 2, "by customer")
  })

  test("pages through with the cursor, without overlaps", async () => {
    const seen: string[] = []
    let cursor: string | undefined
    let pages = 0
    do {
      const r = rows(await luca.call("product_list", { sort: "name", limit: 10, ...(cursor ? { cursor } : {}) }))
      seen.push(...r.rows.map((x) => String(x.id)))
      cursor = r.next
      pages++
    } while (cursor && pages < 10)
    assert.equal(pages, 3)
    assert.equal(new Set(seen).size, 25)
    assert.equal(errorOf(await luca.call("product_list", { cursor: "not-a-number" }))?.code, "invalid_input")
  })
})

describe("register_movement", () => {
  test("changes the stock, by the person who registered it", async () => {
    const before = await stockOf(aurora, "prd_aur_vit440")
    const r = await luca.call("product_register_movement", { id: "prd_aur_vit440", kind: "in", quantity: 20, note: "Delivery 4471" })
    assert.ok(!r.isError, JSON.stringify(r.content))
    assert.equal(await stockOf(aurora, "prd_aur_vit440"), before + 20)
    const latest = rows(await luca.call("movement_list", { product: "prd_aur_vit440", sort: "date", dir: "desc", limit: 1 })).rows[0]!
    assert.equal(latest.note, "Delivery 4471")
    assert.equal(latest.by, ids["luca.marini@aurora.example"]!.userId)
    await luca.call("product_register_movement", { id: "prd_aur_vit440", kind: "adjustment", quantity: -3, note: "Stocktake" })
    assert.equal(await stockOf(aurora, "prd_aur_vit440"), before + 17)
  })

  test("refuses taking out more than is in stock, and changes nothing", async () => {
    const before = await stockOf(aurora, "prd_aur_cacset")
    const e = errorOf(await luca.call("product_register_movement", { id: "prd_aur_cacset", kind: "out", quantity: before + 1 }))
    assert.equal(e?.code, "conflict")
    assert.match(e!.message, /Only \d+ pcs/)
    assert.equal(await stockOf(aurora, "prd_aur_cacset"), before)
    assert.equal(errorOf(await luca.call("product_register_movement", { id: "prd_aur_cacset", kind: "in", quantity: -4 }))?.code, "invalid_input")
  })
})

describe("confirm_order", () => {
  test("a member can't confirm orders", async () => {
    assert.ok(!(await luca.listTools()).some((t) => t.name === "order_confirm_order"))
    assert.ok((await luca.call("order_confirm_order", { id: "ord_aur_9" })).isError)
    assert.equal(((await luca.call("order_get", { id: "ord_aur_9" })).structuredContent?.record as Record<string, unknown>).status, "draft")
  })

  test("is marked destructive for plain clients, and refused when stock is short", async () => {
    const tool = (await ada.listTools()).find((t) => t.name === "order_confirm_order")!
    assert.equal(tool.annotations?.destructiveHint, true)
    const before = await stockOf(aurora, "prd_aur_tra18v")
    const e = errorOf(await ada.call("order_confirm_order", { id: "ord_aur_11" }))
    assert.equal(e?.code, "conflict")
    assert.match(e!.message, /Cordless drill 18 V \(needs 12, \d+ in stock\)/)
    assert.equal(await stockOf(aurora, "prd_aur_tra18v"), before, "nothing moved")
  })

  test("a workspace host needs the person's confirmation; the confirmed call runs once", async () => {
    const ws = await workspace()
    assert.equal(ws.status, 200)
    const led = `prd_wsa_lede27`
    const before = await stockOf(WORKSPACE_TENANT, led)
    assert.equal(errorOf(await ws.call("order_confirm_order", { id: "ord_wsa_10" }))?.code, "confirmation_required")
    assert.equal(await stockOf(WORKSPACE_TENANT, led), before)

    const first = await ws.confirmed("order_confirm_order", { id: "ord_wsa_10" }, "call-confirm-10")
    assert.ok(!first.isError, JSON.stringify(first.content))
    assert.equal(await stockOf(WORKSPACE_TENANT, led), before - 24)
    // The same call again (a retry): the stored result, nothing moves twice.
    const retry = await ws.confirmed("order_confirm_order", { id: "ord_wsa_10" }, "call-confirm-10")
    assert.deepEqual(retry.structuredContent, first.structuredContent)
    assert.equal(await stockOf(WORKSPACE_TENANT, led), before - 24)
    // A new call: the order is already confirmed.
    assert.equal(errorOf(await ws.confirmed("order_confirm_order", { id: "ord_wsa_10" }, "call-confirm-10b"))?.code, "conflict")
    const order = (await ws.call("order_get", { id: "ord_wsa_10" })).structuredContent?.record as Record<string, unknown>
    assert.equal(order.status, "confirmed")
    // Aurora's own order of the same number is untouched.
    assert.equal(((await ada.call("order_get", { id: "ord_aur_10" })).structuredContent?.record as Record<string, unknown>).status, "draft")
  })
})

describe("create_order", () => {
  test("creates a draft at today's prices; nothing leaves the warehouse", async () => {
    const before = await stockOf(aurora, "prd_aur_mar500")
    const r = await ada.call("create_order", { customer: "Falegnameria Dal Bosco", lines: [{ product: "prd_aur_mar500", quantity: 2 }] })
    assert.ok(!r.isError, JSON.stringify(r.content))
    const draft = rows(await ada.call("order_list", { query: "Dal Bosco" })).rows[0]!
    assert.equal(draft.status, "draft")
    assert.equal(draft.total, 37)
    assert.match(String(draft.number), /^SO-\d{4}-0013$/)
    assert.equal(await stockOf(aurora, "prd_aur_mar500"), before)
    assert.equal(errorOf(await ada.call("create_order", { customer: "X Y", lines: [{ product: "prd_col_cansoy", quantity: 1 }] }))?.code, "not_found")
  })
})

describe("fragments and pages", () => {
  test("low stock lists the emptiest products first", async () => {
    const r = await luca.call("show_low_stock", { limit: 3 })
    const items = (r.structuredContent?.data as { items: { title: string; status: string }[] }).items
    assert.equal(items.length, 3)
    assert.equal(items[0]?.title, "Enamel paint, blue")
    assert.equal(items[0]?.status, "Out of stock")
  })

  test("units out per week: one bar per week", async () => {
    const r = await ada.call("show_units_out_by_week", { weeks: 4 })
    assert.equal((r.structuredContent?.data as { points: unknown[] }).points.length, 4)
  })

  test("the manifest names the same-site stock board and the agent", () => {
    const m = app.manifest() as unknown as { pages: { name: string; url?: string }[]; agents: { name: string }[] }
    assert.equal(m.pages.find((p) => p.name === "stock")?.url, "/embed/stock")
    assert.ok(m.agents.some((a) => a.name === "assistant"))
  })

  test("the idempotency table in the migration is the SDK's", () => {
    const migration = readFileSync(new URL("../db/migrations/002_modelapp_store.sql", import.meta.url), "utf8")
    assert.ok(migration.includes(SqlStore.schema()), "db/migrations/002_modelapp_store.sql must contain SqlStore.schema()")
  })
})
