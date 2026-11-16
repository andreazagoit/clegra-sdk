// The warehouse as a MAP app, with REAL better-auth access tokens: the OAuth flow (sign in → authorize with PKCE
// and `resource` → consent → token) runs in-process against better-auth on a seeded in-memory PGlite, and every
// call goes through the app's own `resolve` (lib/modelapp-auth.ts) and the Next route handlers.
import assert from "node:assert/strict"
import { createHash, randomBytes } from "node:crypto"
import { readFileSync } from "node:fs"
import { after, before, describe, test } from "node:test"

import { decodeJwt, decodeProtectedHeader, generateKeyPair, SignJWT } from "jose"
import { SqlStore } from "modelapp"
import { toNextHandlers } from "modelapp/next"
import { checkApp, formatReport } from "modelapp/spec"
import { testClient } from "modelapp/testing"

process.env.PGLITE_DIR = "memory://"
process.env.BETTER_AUTH_SECRET = randomBytes(32).toString("base64url")
process.env.DEMO_PASSWORD = randomBytes(12).toString("base64url")
delete process.env.MODELAPP_PUBLIC_URL

const { closeDb, getDb, sql } = await import("../lib/db")
const { migrate } = await import("../lib/migrate")
const { seed } = await import("../lib/seed")
const { createAuth, getAuth } = await import("../lib/auth")
const { modelAppAuth } = await import("../lib/modelapp-auth")
const { createWarehouseApp } = await import("../lib/modelapp")
const { oauthAccessToken } = await import("../scripts/oauth-flow")
const { restartable, restartAuthorization, staleOAuthQuery } = await import("../lib/oauth-query")

const SITE = "http://localhost:3930"
const RESOURCE = `${SITE}/mcp`
const ISSUER = `${SITE}/api/auth`

type Client = Awaited<ReturnType<typeof testClient>>
type Rows = { rows: Record<string, unknown>[]; next?: string; total?: number }

const auth = await getAuth()
const app = createWarehouseApp({ auth: modelAppAuth(auth) })
const route = toNextHandlers(app, { publicUrl: SITE })
const handler = (request: Request) => auth.handler(request)

const ids: Record<string, { userId: string; orgId: string }> = {}
/** An access token for a demo person, by the real OAuth flow (a public client created for them). */
const tokenOf = async (email: string, extra: Partial<Parameters<typeof oauthAccessToken>[0]> = {}) =>
  (await oauthAccessToken({ authBaseURL: ISSUER, resource: RESOURCE, signIn: { email, password: process.env.DEMO_PASSWORD! }, fetch: handler, ...extra })).accessToken
const as = async (email: string): Promise<Client> => testClient(app, { token: await tokenOf(email) })

/** One JSON-RPC call through the Next route, as an MCP client makes it over HTTP. */
async function rpc(token: string | null, method: string, params: Record<string, unknown> = {}) {
  const response = await route.POST(
    new Request(`${SITE}/api/modelapp/mcp`, {
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
const stockOf = async (orgId: string, productId: string) => Number((await sql<{ stock: number }>(`SELECT stock FROM product_stock WHERE organization_id = $1 AND id = $2`, [orgId, productId]))[0]?.stock)

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

  test("the stock value fragment is for admins only", async () => {
    assert.ok(!(await luke.listTools()).some((t) => t.name === "show_stock_value"))
    const r = await ada.call("show_stock_value", {})
    const [expected] = await sql<{ v: string }>(`SELECT sum(purchase_cost * GREATEST(stock, 0)) AS v FROM product_stock WHERE organization_id = $1`, [aurora])
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
    assert.deepEqual(tools.get("product_get")!._meta!.modelapp, { entity: "product", kind: "product" })
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

describe("fragments and pages", () => {
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
    const report = await checkApp({ url: SITE, token, fetch: (r) => route[r.method as "GET"](r) })
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
      ["no scope", await resign(token, { scope: "openid profile" }), /modelapp scope/],
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
      const query = { response_type: "code", client_id: CLIENT_ID, redirect_uri: REDIRECT, scope: "modelapp", state: "s1", code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM", code_challenge_method: "S256", resource: RESOURCE }
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
    const query = new URLSearchParams({ response_type: "code", client_id: client.client_id, redirect_uri: redirectUri, scope: "openid email offline_access modelapp", state: "s-stale", code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256", resource: RESOURCE })
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
