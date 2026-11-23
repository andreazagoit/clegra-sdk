// The warehouse as a Clegra app, with REAL better-auth access tokens: the OAuth flow (sign in → authorize with PKCE
// and `resource` → consent → token) runs in-process against better-auth on a seeded in-memory PGlite, and every
// call goes through the app's own `resolve` (lib/clegra-auth.ts) and the Next route handlers.
import assert from "node:assert/strict"
import { createHash, randomBytes } from "node:crypto"
import { readFileSync } from "node:fs"
import { after, before, describe, test } from "node:test"

import { decodeJwt, decodeProtectedHeader, generateKeyPair, SignJWT } from "jose"
import { SqlStore, type Person } from "@clegra/sdk"
import { toNextHandlers } from "@clegra/sdk/next"
import { checkApp, formatReport } from "@clegra/sdk/spec"
import { deviceKey, installationClient, testClient, testCore } from "@clegra/sdk/testing"

process.env.PGLITE_DIR = "memory://"
process.env.BETTER_AUTH_SECRET = randomBytes(32).toString("base64url")
process.env.DEMO_PASSWORD = randomBytes(12).toString("base64url")
delete process.env.CLEGRA_PUBLIC_URL

const { closeDb, getDb, sql } = await import("../lib/db")
const { migrate } = await import("../lib/migrate")
const { seed } = await import("../lib/seed")
const { createAuth, getAuth } = await import("../lib/auth")
const { clegraAuth } = await import("../lib/clegra-auth")
const { ALL_PERMISSIONS } = await import("../lib/permissions")
const { createWarehouseApp } = await import("../lib/clegra")
const { oauthAccessToken } = await import("../scripts/oauth-flow")
const { restartable, restartAuthorization, staleOAuthQuery } = await import("../lib/oauth-query")

const SITE = "http://localhost:3930"
const RESOURCE = `${SITE}/mcp`
const ISSUER = `${SITE}/api/auth`

type Client = Awaited<ReturnType<typeof testClient>>
type Rows = { rows: Record<string, unknown>[]; next?: string; total?: number }

const auth = await getAuth()
const app = createWarehouseApp({ auth: clegraAuth(async () => auth) })
const route = toNextHandlers(app, { publicUrl: SITE })
/** The site as an HTTP client reaches it: the clegra route (what Next does with withClegra's rewrites). */
const site = (r: Request) => route[r.method as "GET"](r)
const handler = (request: Request) => auth.handler(request)

const ids: Record<string, { userId: string; orgId: string }> = {}
/** An access token for a demo person, by the real OAuth flow (a public client created for them). */
const tokenOf = async (email: string, extra: Partial<Parameters<typeof oauthAccessToken>[0]> = {}) =>
  (await oauthAccessToken({ authBaseURL: ISSUER, resource: RESOURCE, signIn: { email, password: process.env.DEMO_PASSWORD! }, fetch: handler, ...extra })).accessToken
const as = async (email: string): Promise<Client> => testClient(app, { token: await tokenOf(email) })

/** One JSON-RPC call through the Next route, as an MCP client makes it over HTTP. */
async function rpc(token: string | null, method: string, params: Record<string, unknown> = {}) {
  const response = await route.POST(
    new Request(`${SITE}/api/clegra/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }),
  )
  const text = await response.text()
  if (response.status !== 200) return { status: response.status, headers: response.headers, text }
  const data = response.headers.get("content-type")?.includes("text/event-stream") ? JSON.parse(text.split("\n").filter((l) => l.startsWith("data:")).pop()!.slice(5)) : JSON.parse(text)
  return { status: 200, headers: response.headers, text, result: data.result }
}

const rows = (r: { structuredContent?: Record<string, unknown> }) => r.structuredContent as unknown as Rows
const errorOf = (r: { isError?: boolean; structuredContent?: Record<string, unknown> }) => (r.isError ? ((r.structuredContent?.error as { code: string; message: string }) ?? { code: "?", message: "" }) : null)
const stockOf = async (orgId: string, productId: string) => Number((await sql<{ stock: number }>(`SELECT stock FROM product_stock WHERE tenant_id = $1 AND id = $2`, [orgId, productId]))[0]?.stock)

let ada: Client, luke: Client, sophie: Client
let aurora = "", hummingbird = ""

before(async () => {
  await migrate()
  await seed()
  for (const r of await sql<{ email: string; userId: string; orgId: string }>(`SELECT u.email, u.id AS "userId", m."organizationId" AS "orgId" FROM "user" u JOIN member m ON m."userId" = u.id`)) ids[r.email] = { userId: r.userId, orgId: r.orgId }
  aurora = ids["ada.fernley@aurora.example"]!.orgId
  hummingbird = ids["sophie.green@hummingbird.example"]!.orgId
  ada = await as("ada.fernley@aurora.example")
  luke = await as("luke.marsh@aurora.example")
  sophie = await as("sophie.green@hummingbird.example")
})

after(async () => {
  await closeDb()
})

describe("tenant isolation", () => {
  test("each organization sees its own records only", async () => {
    const a = rows(await ada.call("product_list", { limit: 100 }))
    assert.equal(a.total, 25)
    assert.ok(a.rows.every((r) => String(r.id).startsWith("prd_aur_")))
    const s = rows(await sophie.call("product_list", { limit: 100 }))
    assert.equal(s.total, 6)
    assert.ok(s.rows.every((r) => String(r.id).startsWith("prd_hum_")))
    assert.equal(rows(await sophie.call("order_list", {})).total, 3)
    assert.equal(rows(await sophie.call("product_list", { query: "screw" })).total, 0, "Aurora's screws are not found from Hummingbird Crafts")
  })

  test("another organization's record is not found, and can't be acted on", async () => {
    assert.equal(errorOf(await ada.call("product_get", { id: "prd_hum_cndlav" }))?.code, "not_found")
    assert.equal(errorOf(await sophie.call("order_get", { id: "ord_aur_9" }))?.code, "not_found")
    const before = await stockOf(hummingbird, "prd_hum_cndlav")
    assert.equal(errorOf(await ada.call("product_register_movement", { id: "prd_hum_cndlav", kind: "out", quantity: 1 }))?.code, "not_found")
    assert.equal(await stockOf(hummingbird, "prd_hum_cndlav"), before)
  })
})

describe("purchase cost (products.cost)", () => {
  test("an admin sees it in rows and records", async () => {
    const r = rows(await ada.call("product_list", { query: "drill" }))
    assert.equal(r.rows[0]?.purchaseCost, 78)
    const rec = (await ada.call("product_get", { id: "prd_aur_drl18v" })).structuredContent?.record as Record<string, unknown>
    assert.equal(rec.purchaseCost, 78)
  })

  test("a member never gets it: not in rows, records, filters nor sorts", async () => {
    const r = rows(await luke.call("product_list", { limit: 100 }))
    assert.equal(r.rows.length, 25)
    assert.ok(r.rows.every((row) => !("purchaseCost" in row)))
    const rec = (await luke.call("product_get", { id: "prd_aur_drl18v" })).structuredContent?.record as Record<string, unknown>
    assert.equal(rec.salePrice, 129)
    assert.ok(!("purchaseCost" in rec))
    // Not even a parameter of the member's list tool: refused before the handler runs.
    const sorted = await luke.call("product_list", { sort: "purchaseCost", dir: "desc" })
    assert.ok(sorted.isError && /sort/.test(sorted.content?.[0]?.text ?? ""))
    const filtered = await luke.call("product_list", { purchaseCost: { gte: 50 } })
    assert.ok(filtered.isError && /purchaseCost/.test(filtered.content?.[0]?.text ?? ""))
    const tool = (await luke.listTools()).find((t) => t.name === "product_list")!
    assert.ok(!JSON.stringify(tool.inputSchema).includes("purchaseCost"))
  })

  test("the stock value artifact is for admins only", async () => {
    assert.ok(!(await luke.listTools()).some((t) => t.name === "show_stock_value"))
    const r = await ada.call("show_stock_value", {})
    const [expected] = await sql<{ v: string }>(`SELECT sum(purchase_cost * GREATEST(stock, 0)) AS v FROM product_stock WHERE tenant_id = $1`, [aurora])
    assert.equal((r.structuredContent?.data as { value: number }).value, Number(expected!.v))
  })
})

describe("kinds (product, order)", () => {
  test("products and orders say their kind; a product is found by its GTIN exactly, in SQL", async () => {
    const manifest = app.manifest()
    assert.deepEqual(manifest.entities.map((e) => [e.name, e.kind ?? null]), [["product", "product"], ["movement", null], ["order", "order"]])
    const all = rows(await ada.call("product_list", { limit: 100 })).rows
    const screws = all.find((r) => r.sku === "SCR-440")!
    assert.match(String(screws.gtin), /^20010{7}\d{2}$/, "an invented GTIN in the restricted range")
    // Spaces are taken out before the handler; the filter is exact.
    const spaced = String(screws.gtin).replace(/^(\d{4})(\d{4})/, "$1 $2 ")
    assert.deepEqual(rows(await ada.call("product_list", { gtin: spaced })).rows.map((r) => r.id), [screws.id])
    assert.deepEqual(rows(await ada.call("product_list", { gtin: String(screws.gtin).slice(0, 12) })).rows, [], "no prefix matching")
    assert.equal(errorOf(await ada.call("product_list", { gtin: "SCR-440" }))?.code, "invalid_input")
    const tools = new Map((await ada.listTools()).map((t) => [t.name, t]))
    assert.ok(tools.get("order_list")!.description!.endsWith(" Kind: order."))
    assert.deepEqual(tools.get("product_get")!._meta!.clegra, { entity: "product", kind: "product" })
  })
})

describe("lists: filters, sort, search, cursor", () => {
  test("filters by value, by range and by status", async () => {
    assert.equal(rows(await ada.call("product_list", { category: "tools" })).total, 5)
    assert.equal(rows(await ada.call("product_list", { stockStatus: "out" })).rows[0]?.sku, "ENM-BL")
    const low = rows(await ada.call("product_list", { stock: { lte: 5 }, limit: 100 }))
    assert.ok(low.total! > 0 && low.rows.every((r) => Number(r.stock) <= 5))
    const tools = rows(await luke.call("product_list", { category: { in: ["tools", "garden"] }, limit: 100 }))
    assert.ok(tools.rows.every((r) => r.category === "tools" || r.category === "garden"))
  })

  test("sorts by a declared field, and refuses any other", async () => {
    const byStock = rows(await ada.call("product_list", { sort: "stock", dir: "asc", limit: 100 })).rows.map((r) => Number(r.stock))
    assert.deepEqual(byStock, [...byStock].sort((a, b) => a - b))
    const byCost = rows(await ada.call("product_list", { sort: "purchaseCost", dir: "desc" })).rows
    assert.equal(byCost[0]?.sku, "DRL-18V")
    assert.ok((await ada.call("product_list", { sort: "reorderLevel" })).isError)
  })

  test("searches the search fields only, case-insensitive, with SQL wildcards taken literally", async () => {
    assert.deepEqual(rows(await ada.call("product_list", { query: "SCREW", sort: "sku" })).rows.map((r) => r.sku), ["SCR-440", "SCR-660", "SDR-SET"])
    assert.equal(rows(await ada.call("product_list", { query: "scr-" })).total, 2, "by SKU")
    assert.equal(rows(await ada.call("product_list", { query: "%" })).total, 0)
    assert.equal(rows(await ada.call("order_list", { query: "linden" })).total, 2, "by customer")
  })

  test("pages through with the cursor, without overlaps", async () => {
    const seen: string[] = []
    let cursor: string | undefined
    let pages = 0
    do {
      const r = rows(await luke.call("product_list", { sort: "name", limit: 10, ...(cursor ? { cursor } : {}) }))
      seen.push(...r.rows.map((x) => String(x.id)))
      cursor = r.next
      pages++
    } while (cursor && pages < 10)
    assert.equal(pages, 3)
    assert.equal(new Set(seen).size, 25)
    assert.equal(errorOf(await luke.call("product_list", { cursor: "not-a-number" }))?.code, "invalid_input")
  })
})

describe("register_movement", () => {
  test("changes the stock, by the person who registered it", async () => {
    const before = await stockOf(aurora, "prd_aur_scr440")
    const r = await luke.call("product_register_movement", { id: "prd_aur_scr440", kind: "in", quantity: 20, note: "Delivery 4471" })
    assert.ok(!r.isError, JSON.stringify(r.content))
    assert.equal(await stockOf(aurora, "prd_aur_scr440"), before + 20)
    const latest = rows(await luke.call("movement_list", { product: "prd_aur_scr440", sort: "date", dir: "desc", limit: 1 })).rows[0]!
    assert.equal(latest.note, "Delivery 4471")
    assert.equal(latest.by, ids["luke.marsh@aurora.example"]!.userId)
    await luke.call("product_register_movement", { id: "prd_aur_scr440", kind: "adjustment", quantity: -3, note: "Stocktake" })
    assert.equal(await stockOf(aurora, "prd_aur_scr440"), before + 17)
  })

  test("refuses taking out more than is in stock, and changes nothing", async () => {
    const before = await stockOf(aurora, "prd_aur_sdrset")
    const e = errorOf(await luke.call("product_register_movement", { id: "prd_aur_sdrset", kind: "out", quantity: before + 1 }))
    assert.equal(e?.code, "conflict")
    assert.match(e!.message, /Only \d+ pcs/)
    assert.equal(await stockOf(aurora, "prd_aur_sdrset"), before)
    assert.equal(errorOf(await luke.call("product_register_movement", { id: "prd_aur_sdrset", kind: "in", quantity: -4 }))?.code, "invalid_input")
  })
})

describe("confirm_order", () => {
  test("a member can't confirm orders", async () => {
    assert.ok(!(await luke.listTools()).some((t) => t.name === "order_confirm_order"))
    assert.ok((await luke.call("order_confirm_order", { id: "ord_aur_9" })).isError)
    assert.equal(((await luke.call("order_get", { id: "ord_aur_9" })).structuredContent?.record as Record<string, unknown>).status, "draft")
  })

  test("is marked destructive for plain clients, and refused when stock is short", async () => {
    const tool = (await ada.listTools()).find((t) => t.name === "order_confirm_order")!
    assert.equal(tool.annotations?.destructiveHint, true)
    const before = await stockOf(aurora, "prd_aur_drl18v")
    const e = errorOf(await ada.call("order_confirm_order", { id: "ord_aur_11" }))
    assert.equal(e?.code, "conflict")
    assert.match(e!.message, /Cordless drill 18 V \(needs 12, \d+ in stock\)/)
    assert.equal(await stockOf(aurora, "prd_aur_drl18v"), before, "nothing moved")
  })

  test("confirming moves the goods once: a second confirmation is a conflict", async () => {
    const led = "prd_aur_lede27"
    const before = await stockOf(aurora, led)
    const first = await ada.call("order_confirm_order", { id: "ord_aur_10" })
    assert.ok(!first.isError, JSON.stringify(first.content))
    assert.equal(await stockOf(aurora, led), before - 24)
    assert.equal(errorOf(await ada.call("order_confirm_order", { id: "ord_aur_10" }))?.code, "conflict")
    assert.equal(await stockOf(aurora, led), before - 24)
    assert.equal(((await ada.call("order_get", { id: "ord_aur_10" })).structuredContent?.record as Record<string, unknown>).status, "confirmed")
  })
})

describe("create_order", () => {
  test("creates a draft at today's prices; nothing leaves the warehouse", async () => {
    const before = await stockOf(aurora, "prd_aur_ham500")
    const r = await ada.call("create_order", { customer: "Woodland Joinery", lines: [{ product: "prd_aur_ham500", quantity: 2 }] })
    assert.ok(!r.isError, JSON.stringify(r.content))
    const draft = rows(await ada.call("order_list", { query: "Woodland" })).rows[0]!
    assert.equal(draft.status, "draft")
    assert.equal(draft.total, 37)
    assert.match(String(draft.number), /^SO-\d{4}-0013$/)
    assert.equal(await stockOf(aurora, "prd_aur_ham500"), before)
    assert.equal(errorOf(await ada.call("create_order", { customer: "X Y", lines: [{ product: "prd_hum_cndlav", quantity: 1 }] }))?.code, "not_found")
  })
})

// Clegra's core (a test one): its app key given to the app as a local key set, its tokens minted here, DPoP-bound.
const HOST = "https://core.test"
const core = await testCore({ resource: RESOURCE, issuer: HOST })
// Clegra's web client, which frames the app's own site (spec §5.1): one of the app's client origins.
const CLIENT = "https://app.clegra.test"
const hostApp = createWarehouseApp({ auth: { ...clegraAuth(async () => auth), clegra: core.options({ clientOrigins: [CLIENT] }) } })
const hostRoute = toNextHandlers(hostApp, { publicUrl: SITE })

describe("Clegra companies (CLEGRA_ISSUER)", () => {
  /** A person of a Clegra company (its administrator: every permission here), through a Clegra client: a fresh app token for each call. */
  const hostClient = (company: string, person: Person) => core.client(hostApp, { company, sub: person.id, name: person.name, role: "admin" })
  const carla = { id: "host-person-7", name: "Carla Test" }

  test("Clegra's core comes from the environment, with the app's one MCP address as the audience", () => {
    assert.equal("clegra" in clegraAuth(async () => auth, {}), false)
    const options = clegraAuth(async () => auth, { CLEGRA_ISSUER: "https://core.example.com", CLEGRA_ALLOWED_COMPANIES: "co-1,co-2" })
    assert.deepEqual([options.clegra, options.resource], [{ issuer: "https://core.example.com", allowedCompanies: ["co-1", "co-2"] }, RESOURCE])
  })

  test("a member has what the warehouse's administrator assigned; «who has what» is the administrator's", async () => {
    const member = await core.client(hostApp, { company: "shop-roles", sub: "host-person-9", name: "Dora Test", role: "member" })
    const before = (await member.listTools()).map((t) => t.name)
    assert.ok(!before.includes("clegra_roles"))
    await hostApp.roles.assign(`shop-roles@${HOST}`, "host-person-9", { permissions: ALL_PERMISSIONS })
    assert.ok((await member.listTools()).length > before.length, "the assigned permissions count on the next call")
    const admin = await hostClient("shop-roles", carla)
    const who = (await admin.call("clegra_roles")).structuredContent as { people: { sub: string; source: string }[] }
    assert.deepEqual(who.people.map((p) => [p.sub, p.source]).sort(), [["host-person-7", "company-admin"], ["host-person-9", "assigned"]])
  })

  test("an installation gets its own copy of the demo company once, and never sees an organization's data", async () => {
    const c = await hostClient("shop-1", carla)
    const products = rows(await c.call("product_list", { limit: 100 }))
    assert.equal(products.total, 25)
    assert.ok(products.rows.every((r) => /^prd_w[0-9a-f]{16}_/.test(String(r.id))), "its own ids, not Aurora's")
    assert.equal(rows(await c.call("order_list", {})).total, 12)
    assert.equal(errorOf(await c.call("product_get", { id: "prd_aur_drl18v" }))?.code, "not_found")
    assert.equal(errorOf(await c.call("order_get", { id: "ord_aur_9" }))?.code, "not_found")
    // Provisioned once: more calls (and the same installation of another person) add nothing.
    await (await hostClient("shop-1", { id: "host-person-8", name: "Dan Test" })).call("product_list", {})
    const [count] = await sql<{ tenants: number; products: number }>(`SELECT (SELECT count(*) FROM tenant WHERE id = $1)::integer AS tenants, (SELECT count(*) FROM product WHERE tenant_id = $1)::integer AS products`, [`shop-1@${HOST}`])
    assert.deepEqual(count, { tenants: 1, products: 25 })
    // Another installation: another copy; the organizations are untouched and don't see either.
    const other = rows(await (await hostClient("shop-2", carla)).call("product_list", { limit: 100 }))
    assert.equal(other.total, 25)
    assert.ok(other.rows.every((r) => !products.rows.some((p) => p.id === r.id)))
    const a = rows(await ada.call("product_list", { limit: 100 }))
    assert.equal(a.total, 25)
    assert.ok(a.rows.every((r) => String(r.id).startsWith("prd_aur_")))
    assert.equal(errorOf(await ada.call("product_get", { id: String(products.rows[0]!.id) }))?.code, "not_found")
  })

  test("the app's own site for a company's person: a site ticket, exchanged once, signs them in as a viewer of the installation", async () => {
    const { provisionWorkspace } = await import("../lib/tenants")
    const { listProducts } = await import("../lib/warehouse")
    assert.deepEqual(hostApp.manifest().site, { start: "/", tool: { name: "clegra_site", plain: false } })
    const c = await hostClient("shop-site", carla)
    const asked = await c.call("clegra_site", { origin: CLIENT, path: "/stock", theme: "light", locale: "en" })
    assert.ok(!asked.isError, JSON.stringify(asked.structuredContent))
    const t = asked.structuredContent as { action: string; field: string; ticket: string; path: string }
    assert.deepEqual([t.action, t.path], [`${SITE}/clegra/site`, "/stock"])
    assert.equal((await c.call("clegra_site", { origin: "https://evil.example" })).isError, true, "no ticket for another origin")
    // What the client's frame posts: the ticket in a form, never in the address.
    const post = (origin: string) => hostRoute.POST(new Request(t.action, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin, "sec-fetch-dest": "iframe" }, body: new URLSearchParams({ [t.field]: t.ticket }) }))
    assert.equal((await post("https://evil.example")).status, 403, "posted from another origin")
    const r = await post(CLIENT)
    assert.equal(r.status, 303)
    assert.equal(r.headers.get("location"), `${SITE}/stock`)
    const cookies = r.headers.getSetCookie()
    assert.equal(cookies.length, 2)
    assert.ok(cookies.every((x) => /; Path=\/; Max-Age=\d+; Secure; HttpOnly; SameSite=None; Partitioned$/.test(x)), cookies.join("\n"))
    assert.equal((await post(CLIENT)).status, 401, "a ticket is used once")
    // Every page reads the caller (getClegraCaller in lib/session.ts) and is framable by that client only.
    const page = new Request(`${SITE}/stock`, { headers: { cookie: cookies.map((x) => x.split(";")[0]).join("; "), "sec-fetch-dest": "iframe" } })
    const who = await hostApp.site!.caller(page)
    assert.deepEqual([who?.installation, who?.person?.name, who?.admin], [`shop-site@${HOST}`, "Carla Test", true])
    assert.deepEqual(ALL_PERMISSIONS.filter((p) => who?.can(p)), ALL_PERMISSIONS, "the company's administrator: every permission")
    assert.deepEqual((await hostApp.site!.guard(page)).headers, { "content-security-policy": `frame-ancestors 'self' ${CLIENT}` })
    // What the stock board does with it: the installation's own copy, never an organization's rows.
    await provisionWorkspace(who!.installation)
    const board = await listProducts(who!.installation, { limit: 200 })
    assert.equal(board.rows.length, 25)
    assert.ok(board.rows.every((p) => /^prd_w[0-9a-f]{16}_/.test(p.id)))
  })

  test("as a company's person the app passes the conformance checks, the site's included", async () => {
    const device = await deviceKey()
    const report = await checkApp({
      url: SITE,
      fetch: (r) => hostRoute[r.method as "GET"](r),
      clegra: { token: () => core.appToken({ company: "shop-check", sub: carla.id, name: carla.name, role: "admin", device }), proof: device.proof, clientOrigin: CLIENT },
    })
    assert.ok(report.ok, formatReport(report))
    for (const id of ["site.frame-ancestors", "site.ticket"]) assert.ok(report.checks.some((x) => x.id === id && x.ok && !x.skipped), `${id} ran: ${formatReport(report)}`)
  })

  test("a host person's change works and shows their name; the demo people are named too", async () => {
    const c = await hostClient("shop-3", carla)
    const drill = rows(await c.call("product_list", { query: "DRL-18V" })).rows[0]!
    const r = await c.call("product_register_movement", { id: String(drill.id), kind: "in", quantity: 3, note: "Host delivery" })
    assert.ok(!r.isError, JSON.stringify(r.content))
    const list = (await c.call("movement_list", { product: String(drill.id), sort: "date", dir: "desc", limit: 5 })).structuredContent as unknown as Rows & { refs: { by: Record<string, string> } }
    assert.equal(list.rows[0]!.by, carla.id)
    assert.equal(list.refs.by[carla.id], "Carla Test")
    assert.equal(list.refs.by["demo-ada-fernley"], "Ada Fernley", "the opening stock, by the demo company's admin")
    const order = await c.call("create_order", { customer: "Woodland Joinery", lines: [{ product: String(drill.id), quantity: 1 }] })
    assert.ok(!order.isError, JSON.stringify(order.content))
    const [row] = await sql<{ created_by: string }>(`SELECT created_by FROM sales_order WHERE tenant_id = $1 AND customer_name = 'Woodland Joinery'`, [`shop-3@${HOST}`])
    assert.equal(row?.created_by, carla.id)
  })
})

// The installation-level caller (a workspace host with no person: schedules, lifecycle tools) is the SDK's dev authority's,
// for development and tests (spec §7, «Development»): its tenants are `<installation>@clegra-dev`.
const DEV = "clegra-dev"
const devApp = createWarehouseApp({ auth: { ...clegraAuth(async () => auth), dev: { keyFile: false, code: "TEST" } } })

describe("the installation itself: the low-stock schedule and the lifecycle", () => {
  /** The installation-level caller: a dev workspace host's token with no person, listing exactly `permissions`. */
  const installation = (name: string, permissions: string[] = []) => installationClient(devApp, { installation: name, permissions })
  const person = (name: string) => testClient(devApp, { host: "workspace", installation: name, person: { id: "host-person-7", name: "Carla Test" }, permissions: ALL_PERMISSIONS })
  type Sent = { type?: string; title: string; body?: string; uri?: string; to: unknown }
  const sentOf = (r: { _meta?: Record<string, unknown> }) => ((r._meta?.clegra as { notifications?: Sent[] } | undefined)?.notifications ?? []) as Sent[]

  test("declared: the schedule, the typed notification, the lifecycle tools; app-only, never a model's", async () => {
    const m = devApp.manifest()
    assert.deepEqual(m.schedules, [{ name: "low_stock_check", action: "check_low_stock", tool: "check_low_stock", every: 60, maxSeconds: 30 }])
    assert.deepEqual(m.notifications?.map((n) => [n.type, n.default, n.permission]), [["low_stock", true, "products.view"]])
    assert.deepEqual(m.lifecycle, { installation: "clegra_installation", export: "clegra_export", delete: "clegra_delete" })
    const listed = await (await person("shop-life")).listTools()
    assert.equal((listed.find((t) => t.name === "check_low_stock")?._meta?.ui as { visibility?: string[] } | undefined)?.visibility?.join(), "app")
    assert.ok(!listed.some((t) => ["clegra_installation", "clegra_export", "clegra_delete"].includes(t.name)), "the lifecycle tools are the installation's own")
    const own = (await (await installation("shop-life", ["products.view"])).listTools()).map((t) => t.name)
    assert.ok(["clegra_installation", "clegra_export", "clegra_delete"].every((n) => own.includes(n)), own.join())
  })

  test("the schedule tells the company's administrators about each low product once, until it is back in stock", async () => {
    const host = await installation("shop-alerts", ["products.view"])
    const first = await host.schedule("low_stock_check")
    assert.ok(!first.isError, JSON.stringify(first.content))
    const sent = sentOf(first)
    const data = first.structuredContent?.data as { low: number; told: string[] }
    assert.ok(data.low > 0 && sent.length === data.low, JSON.stringify(first.structuredContent))
    assert.ok(sent.every((n) => n.type === "low_stock" && n.to === "admins" && n.uri?.startsWith("clegra://warehouse/product/")), JSON.stringify(sent))
    assert.ok(sent.some((n) => n.title === "Out of stock: Enamel paint, blue"), JSON.stringify(sent.map((n) => n.title)))
    // Again: nothing new to tell.
    assert.deepEqual(sentOf(await host.schedule("low_stock_check")), [])
    // Restocked, then out again: told again.
    const paint = decodeURIComponent(sent.find((n) => n.title === "Out of stock: Enamel paint, blue")!.uri!.split("/").pop()!)
    const carla = await person("shop-alerts")
    assert.ok(!(await carla.call("product_register_movement", { id: paint, kind: "in", quantity: 50 })).isError)
    assert.deepEqual(sentOf(await host.schedule("low_stock_check")), [])
    assert.ok(!(await carla.call("product_register_movement", { id: paint, kind: "out", quantity: 50 })).isError)
    assert.deepEqual(sentOf(await host.schedule("low_stock_check")).map((n) => n.title), ["Out of stock: Enamel paint, blue"])
  })

  test("a schedule's run is the installation's only: a person, or another tool's schedule, is refused", async () => {
    const code = (r: { structuredContent?: Record<string, unknown> }) => (r.structuredContent?.error as { code?: string } | undefined)?.code
    const carla = await person("shop-alerts")
    assert.equal(code(await carla.call("check_low_stock", {}, { clegra: { schedule: "low_stock_check" } })), "permission_denied")
    const host = await installation("shop-alerts", ["products.view"])
    assert.equal(code(await host.call("check_low_stock", {}, { clegra: { schedule: "nightly" } })), "permission_denied")
  })

  test("the installation's state is kept; its data exported as JSON, deleted once, and the export keeps working after", async () => {
    const host = await installation("shop-gone")
    for (const state of ["enabled", "disabled", "uninstalled"] as const) assert.deepEqual((await host.call("clegra_installation", { state })).structuredContent, { ok: true })
    assert.deepEqual(await sql(`SELECT state FROM installation_state WHERE tenant_id = $1`, [`shop-gone@${DEV}`]), [{ state: "uninstalled" }])

    const { file } = await host.exportData()
    assert.ok(file, "an export")
    assert.deepEqual([file.name, file.contentType, file.bytes], ["warehouse-export.json", "application/json", file.body.byteLength])
    assert.equal(file.sha256, createHash("sha256").update(file.body).digest("hex"))
    const data = JSON.parse(file.body.toString("utf8")) as { installation: string; state: string; products: { id: string; stock: number }[]; orders: { lines: unknown[] }[]; people: unknown[] }
    assert.deepEqual([data.installation, data.state, data.products.length, data.orders.length, data.people.length], [`shop-gone@${DEV}`, "uninstalled", 25, 12, 2])
    assert.ok(data.orders.every((o) => o.lines.length > 0))

    const deleted = await host.call("clegra_delete")
    const counts = (deleted.structuredContent as { deleted: boolean; counts: Record<string, number> }).counts
    assert.deepEqual([deleted.structuredContent?.deleted, counts.products, counts.orders, counts.movements! > 25], [true, 25, 12, true])
    assert.deepEqual(await sql(`SELECT (SELECT count(*) FROM tenant WHERE id = $1)::integer AS tenants, (SELECT count(*) FROM product WHERE tenant_id = $1)::integer AS products, (SELECT count(*) FROM installation_state WHERE tenant_id = $1)::integer AS states`, [`shop-gone@${DEV}`]), [{ tenants: 0, products: 0, states: 0 }])
    // Idempotent; the export after it: nothing kept. Uninstalled after the delete marks nothing.
    assert.deepEqual((await host.call("clegra_delete")).structuredContent, { deleted: true, counts: { products: 0, movements: 0, orders: 0 } })
    const after = await host.exportData()
    assert.deepEqual([after.file, after.result.structuredContent], [null, { empty: true }])
    assert.deepEqual((await host.call("clegra_installation", { state: "uninstalled" })).structuredContent, { ok: true })
    assert.deepEqual(await sql(`SELECT count(*)::integer AS n FROM tenant WHERE id = $1`, [`shop-gone@${DEV}`]), [{ n: 0 }])
    // The organizations are untouched.
    assert.equal(rows(await ada.call("product_list", { limit: 1 })).total, 25)
  })
})

describe("artifacts and pages", () => {
  test("low stock lists the emptiest products first", async () => {
    const r = await luke.call("show_low_stock", { limit: 3 })
    const items = (r.structuredContent?.data as { items: { title: string; status: string }[] }).items
    assert.equal(items.length, 3)
    assert.equal(items[0]?.title, "Enamel paint, blue")
    assert.equal(items[0]?.status, "Out of stock")
  })

  test("units out per week: one bar per week", async () => {
    const r = await ada.call("show_units_out_by_week", { weeks: 4 })
    assert.equal((r.structuredContent?.data as { points: unknown[] }).points.length, 4)
  })

  test("the manifest names the agent; a site only with Clegra's core", () => {
    const m = app.manifest()
    assert.ok(m.agents.some((a) => a.name === "assistant"))
    assert.equal(m.site, undefined)
  })

  test("the store's tables in the latest migration are the SDK's", () => {
    const migration = readFileSync(new URL("../db/migrations/007_clegra_roles.sql", import.meta.url), "utf8")
    assert.ok(migration.includes(SqlStore.schema()), "db/migrations/007_clegra_roles.sql must contain SqlStore.schema()")
  })
})

test("who may frame a page is said in proxy.ts alone: next.config sets no frame-ancestors", async () => {
  const config = (await import("../next.config")).default as { headers?: unknown }
  assert.equal(config.headers, undefined)
})

describe("MCP authorization (better-auth tokens, verified by the app)", () => {
  test("the metadata: the protected resource names better-auth; its AS metadata is served at the root", async () => {
    const prm = (await (await route.GET(new Request(`${SITE}/.well-known/oauth-protected-resource/mcp`))).json()) as { resource: string; authorization_servers: string[] }
    assert.equal(prm.resource, RESOURCE)
    assert.deepEqual(prm.authorization_servers, [ISSUER])
    for (const path of ["/.well-known/oauth-authorization-server/api/auth", "/.well-known/openid-configuration/api/auth"]) {
      const response = await route.GET(new Request(`${SITE}${path}`))
      assert.equal(response.status, 200, path)
      const meta = (await response.json()) as Record<string, unknown>
      assert.equal(meta.issuer, ISSUER)
      assert.deepEqual(meta.code_challenge_methods_supported, ["S256"])
      assert.equal(meta.client_id_metadata_document_supported, true)
      assert.ok(!("registration_endpoint" in meta), "dynamic client registration is off")
    }
  })

  test("no token: 401 with WWW-Authenticate pointing at the protected-resource metadata", async () => {
    const r = await rpc(null, "tools/list")
    assert.equal(r.status, 401)
    assert.match(r.headers.get("www-authenticate") ?? "", new RegExp(`resource_metadata="${SITE}/.well-known/oauth-protected-resource/mcp"`))
  })

  test("a token from the real flow is an audience-bound JWT carrying the organization, and passes the conformance checks", async () => {
    const token = await tokenOf("ada.fernley@aurora.example")
    assert.equal(decodeProtectedHeader(token).typ, "at+jwt")
    const claims = decodeJwt(token)
    assert.equal(claims.iss, ISSUER)
    assert.equal(claims.aud, RESOURCE)
    assert.equal(claims.org, aurora)
    const listed = (await rpc(token, "tools/list")).result as { tools: { name: string }[] }
    assert.ok(listed.tools.some((t) => t.name === "product_list"))
    const report = await checkApp({ url: SITE, token, fetch: site })
    assert.ok(report.ok && report.complete, formatReport(report))
    for (const id of ["kinds.known", "kinds.properties", "kinds.tools", "kinds.keys", "kinds.values"]) assert.ok(report.checks.some((c) => c.id === id && c.ok && !c.skipped), `${id} ran: ${formatReport(report)}`)
  })

  test("the organization comes from the token only, never from arguments", async () => {
    const token = await tokenOf("sophie.green@hummingbird.example")
    const r = await rpc(token, "tools/call", { name: "product_list", arguments: { installation: aurora, org: aurora, limit: 100 } })
    const ids = ((r.result as { structuredContent?: Rows } | undefined)?.structuredContent?.rows ?? []).map((x) => String(x.id))
    assert.ok(!ids.some((id) => id.startsWith("prd_aur_")), r.text)
  })

  test("refused: another audience, tampered, expired, opaque, DPoP-bound, two audiences, no scope, no organization, a foreign key, a wrong typ", async () => {
    const token = await tokenOf("ada.fernley@aurora.example")
    const [h, p, s] = token.split(".")
    const tampered = `${h}.${Buffer.from(JSON.stringify({ ...decodeJwt(token), org: hummingbird })).toString("base64url")}.${s}`
    const now = Math.floor(Date.now() / 1000)
    const cases: [string, string, RegExp][] = [
      ["other audience", await resign(token, { aud: "https://other.example.test/mcp" }), /another server/],
      ["tampered", tampered, /not valid/],
      ["expired", await resign(token, { exp: now - 120, iat: now - 3600 }), /expired/],
      ["opaque", "aBcDeFgHiJkLmNoPqRsTuVwXyZ012345", /not a JWT/],
      ["dpop", await resign(token, { cnf: { jkt: "x" } }), /DPoP/],
      ["two audiences", await resign(token, { aud: [RESOURCE, "https://other.example.test/mcp"] }), /several servers/],
      ["no scope", await resign(token, { scope: "openid profile" }), /clegra scope/],
      ["no organization", await resign(token, { org: undefined }), /no organization/],
      ["foreign key", await foreign(token), /not valid/],
      ["wrong typ", await resign(token, {}, "JWT"), /not valid/],
    ]
    for (const [name, bad, reason] of cases) {
      const r = await rpc(bad, "tools/list")
      assert.equal(r.status, 401, name)
      assert.match(r.headers.get("www-authenticate") ?? "", reason, name)
    }
    // Within the 30 s clock skew an expiry just passed still counts.
    assert.equal((await rpc(await resign(token, { exp: now - 10 }), "tools/list")).status, 200)
  })

  test("a role change counts on the next call; a removed member is refused with a token issued before", async () => {
    const luke = ids["luke.marsh@aurora.example"]!
    const token = await tokenOf("luke.marsh@aurora.example")
    const cost = async () => {
      const r = await rpc(token, "tools/call", { name: "product_get", arguments: { id: "prd_aur_drl18v" } })
      return ((r.result as { structuredContent: { record: Record<string, unknown> } }).structuredContent.record).purchaseCost
    }
    assert.equal(await cost(), undefined)
    await sql(`UPDATE member SET role = 'admin' WHERE "userId" = $1 AND "organizationId" = $2`, [luke.userId, luke.orgId])
    assert.equal(await cost(), 78)
    await sql(`UPDATE member SET role = 'member' WHERE "userId" = $1 AND "organizationId" = $2`, [luke.userId, luke.orgId])
    assert.equal(await cost(), undefined)
    const [row] = await sql<{ id: string }>(`DELETE FROM member WHERE "userId" = $1 AND "organizationId" = $2 RETURNING id`, [luke.userId, luke.orgId])
    try {
      const r = await rpc(token, "tools/list")
      assert.equal(r.status, 401)
      assert.match(r.headers.get("www-authenticate") ?? "", /no longer a member/)
    } finally {
      await sql(`INSERT INTO member (id, "organizationId", "userId", role, "createdAt") VALUES ($1, $2, $3, 'member', now())`, [row!.id, luke.orgId, luke.userId])
    }
    assert.equal((await rpc(token, "tools/list")).status, 200)
  })

  test("the pages' calls, step by step: authorize → /sign-in → (signed in) → /oauth/consent → allow → code; deny → access_denied", async () => {
    // A metadata-document client (CIMD), its document served by this test instead of the network.
    const CLIENT_ID = "https://client.example.test/oauth/client.json"
    const REDIRECT = "http://127.0.0.1:8976/callback"
    const document = { client_id: CLIENT_ID, client_name: "Example MCP client", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }
    const cimdAuth = createAuth((await getDb()).pool, {
      fetchClientMetadata: (async (input: RequestInfo | URL) => (String(input instanceof Request ? input.url : input) === CLIENT_ID ? Response.json(document, { headers: { "cache-control": "max-age=300" } }) : new Response("not found", { status: 404 }))) as never,
    })
    const flow = async (accept: boolean) => {
      const jar: string[] = []
      const send = async (path: string, init: { json?: unknown; query?: Record<string, string> } = {}) => {
        const url = new URL(`${ISSUER}${path}`)
        for (const [k, v] of Object.entries(init.query ?? {})) url.searchParams.set(k, v)
        const response = await cimdAuth.handler(new Request(url, { method: init.json ? "POST" : "GET", redirect: "manual", headers: { origin: SITE, accept: "application/json", cookie: jar.join("; "), ...(init.json ? { "content-type": "application/json" } : {}) }, ...(init.json ? { body: JSON.stringify(init.json) } : {}) }))
        for (const c of response.headers.getSetCookie()) jar.push(c.split(";")[0]!)
        return response
      }
      const query = { response_type: "code", client_id: CLIENT_ID, redirect_uri: REDIRECT, scope: "clegra", state: "s1", code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM", code_challenge_method: "S256", resource: RESOURCE }
      const authorized = await send("/oauth2/authorize", { query })
      const toLogin = new URL(authorized.headers.get("location") ?? ((await authorized.json()) as { url: string }).url, SITE)
      assert.equal(toLogin.pathname, "/sign-in")
      // What the sign-in page's server action posts: the credentials and the signed request.
      const signedIn = (await (await send("/sign-in/email", { json: { email: "owen.rivers@hummingbird.example", password: process.env.DEMO_PASSWORD, oauth_query: toLogin.searchParams.toString() } })).json()) as { url?: string; redirect?: boolean }
      assert.equal(signedIn.redirect, true, JSON.stringify(signedIn))
      const toConsent = new URL(signedIn.url!, SITE)
      assert.equal(toConsent.pathname, "/oauth/consent", "no organization step: the session already has the person's organization")
      const client = (await (await send("/oauth2/public-client", { query: { client_id: CLIENT_ID } })).json()) as { client_name?: string }
      assert.equal(client.client_name, "Example MCP client")
      const answered = (await (await send("/oauth2/consent", { json: { accept, oauth_query: toConsent.searchParams.toString() } })).json()) as { url?: string }
      return new URL(answered.url!)
    }
    const denied = await flow(false)
    assert.equal(denied.searchParams.get("error"), "access_denied")
    const back = await flow(true)
    assert.equal(`${back.origin}${back.pathname}`, REDIRECT)
    assert.ok(back.searchParams.get("code"))
    assert.equal(back.searchParams.get("state"), "s1")
  })

  test("a page left open past the signed request's ten minutes: refused, then the same authorization again after signing in goes on to consent; the token (openid asked, as ChatGPT does) works here", async () => {
    const jar = new Map<string, string>()
    const send = async (path: string, init: { json?: unknown; form?: Record<string, string> } = {}) => {
      const body = init.json ? JSON.stringify(init.json) : init.form ? new URLSearchParams(init.form).toString() : undefined
      const type = init.json ? "application/json" : init.form ? "application/x-www-form-urlencoded" : null
      const response = await handler(new Request(new URL(path, SITE), { method: body ? "POST" : "GET", redirect: "manual", headers: { origin: SITE, accept: "application/json", cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; "), ...(type ? { "content-type": type } : {}) }, ...(body ? { body } : {}) }))
      for (const c of response.headers.getSetCookie()) jar.set(c.slice(0, c.indexOf("=")), c.slice(c.indexOf("=") + 1).split(";")[0]!)
      return response
    }
    const next = async (response: Response) => new URL(response.headers.get("location") ?? ((await response.json()) as { url: string }).url, SITE)
    const email = "owen.rivers@hummingbird.example"
    await send("/api/auth/sign-in/email", { json: { email, password: process.env.DEMO_PASSWORD } })
    const redirectUri = "http://127.0.0.1:8978/callback"
    const client = (await (await send("/api/auth/oauth2/create-client", { json: { client_name: "Stale page test", redirect_uris: [redirectUri], application_type: "native", token_endpoint_auth_method: "none", grant_types: ["authorization_code"], response_types: ["code"] } })).json()) as { client_id: string }
    await send("/api/auth/sign-out", { json: {} })
    jar.clear()
    const verifier = randomBytes(32).toString("base64url")
    const query = new URLSearchParams({ response_type: "code", client_id: client.client_id, redirect_uri: redirectUri, scope: "openid email offline_access clegra", state: "s-stale", code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256", resource: RESOURCE })
    // The sign-in page as better-auth sent the person there eleven minutes ago (it gives ten).
    const now = Date.now
    Date.now = () => now() - 11 * 60_000
    const toSignIn = await next(await send(`/api/auth/oauth2/authorize?${query}`)).finally(() => (Date.now = now))
    assert.equal(toSignIn.pathname, "/sign-in")
    const oauthQuery = toSignIn.searchParams.toString()
    // Eleven minutes: started again. Two hours: the app has moved on, the person is told to start from it.
    assert.equal(restartable(oauthQuery), true)
    assert.equal(restartable(oauthQuery, Date.now() + 110 * 60_000), false)
    // What the sign-in action posts: refused as stale, so it signs in alone and asks for the same authorization again.
    const refused = await send("/api/auth/sign-in/email", { json: { email, password: process.env.DEMO_PASSWORD, oauth_query: oauthQuery } })
    assert.equal(staleOAuthQuery((await refused.json()) as Record<string, unknown>), true)
    assert.equal((await send("/api/auth/sign-in/email", { json: { email, password: process.env.DEMO_PASSWORD } })).status, 200)
    const toConsent = await next(await send(restartAuthorization(oauthQuery, { signedIn: true })))
    assert.equal(toConsent.pathname, "/oauth/consent")
    assert.deepEqual([toConsent.searchParams.get("state"), toConsent.searchParams.get("code_challenge")], [query.get("state"), query.get("code_challenge")], "the client's own request")
    const back = new URL(((await (await send("/api/auth/oauth2/consent", { json: { accept: true, oauth_query: toConsent.searchParams.toString() } })).json()) as { url: string }).url)
    assert.equal(`${back.origin}${back.pathname}`, redirectUri)
    const tokens = (await (await send("/api/auth/oauth2/token", { form: { grant_type: "authorization_code", code: back.searchParams.get("code")!, redirect_uri: redirectUri, client_id: client.client_id, code_verifier: verifier, resource: RESOURCE } })).json()) as { access_token: string }
    assert.deepEqual(decodeJwt(tokens.access_token).aud, [RESOURCE, `${ISSUER}/oauth2/userinfo`], "openid asked: better-auth adds its userinfo endpoint")
    assert.equal((await rpc(tokens.access_token, "tools/list")).status, 200)
  })
})

// The same claims re-signed with better-auth's own key: a token better-auth signed with other claims. `resolve`
// must refuse it on the claims alone.
async function resign(token: string, changes: Record<string, unknown>, typ = "at+jwt"): Promise<string> {
  const { signJWT } = await import("better-auth/plugins")
  const claims: Record<string, unknown> = { ...decodeJwt(token), ...changes }
  for (const [k, v] of Object.entries(changes)) if (v === undefined) delete claims[k]
  const jwtPlugin = (auth.options.plugins as { id: string; options?: unknown }[]).find((p) => p.id === "jwt")!
  return signJWT({ context: await auth.$context } as never, { options: jwtPlugin.options as never, payload: claims, header: { typ } } as never)
}

async function foreign(token: string): Promise<string> {
  const { privateKey } = await generateKeyPair("EdDSA")
  return new SignJWT(decodeJwt(token)).setProtectedHeader({ alg: "EdDSA", typ: "at+jwt", kid: decodeProtectedHeader(token).kid! }).sign(privateKey)
}
