import assert from "node:assert/strict"
import { createServer } from "node:http"
import { describe, test } from "node:test"

import { z } from "zod"

import { clegraMiddleware } from "./express"
import { defineAction, defineApp, defineArtifact, defineEntity, definePage, serve, type OpenApiDocument } from "./index"
import { devSignIn } from "./signin"
import { installationClient, testClient } from "./testing"

// THE DEFINITION AND ITS RUNTIME (spec §1): one thing per define* call, named by its handle; defineApp assembles and
// checks them and serves nothing; serve(app, …) runs them on Web APIs, with the index as OpenAPI and its operations
// over plain HTTP.

const deal = defineEntity({
  name: "deal",
  label: "Deal",
  schema: z.object({ id: z.string(), name: z.string().meta({ role: "title", label: "Name", search: true }), value: z.number().meta({ role: "amount", label: "Value", permission: "deals.values" }) }),
  permission: "deals.view",
  record: { fields: ["name", "value"] },
  get: (id) => (id === "d1" ? { id: "d1", name: "Acme renewal", value: 1200 } : null),
  list: () => ({ rows: [{ id: "d1", name: "Acme renewal", value: 1200 }] }),
})

const won: string[] = []
const markWon = defineAction({
  name: "mark_won",
  on: deal,
  featured: true,
  title: "Mark as won",
  input: z.object({ note: z.string().optional() }),
  permission: "deals.edit",
  // The record is typed from the entity's schema.
  run: (_input, _ctx, record) => {
    won.push(record.name)
    return { message: `${record.name} won` }
  },
})

const newDeal = defineAction({ name: "new_deal", creates: { of: deal, title: "New deal" }, title: "New deal", input: z.object({}), confirm: false, permission: "deals.edit", run: (_i, ctx) => ({ record: ctx.uri(deal, "d2") }) })
const total = defineArtifact({ name: "pipeline_total", title: "Pipeline", description: "Open value", params: z.object({}), template: "stat", widget: true, data: () => ({ label: "Open", value: 1200 }) })
const deals = definePage({ name: "deals", title: "Deals", list: deal, columns: ["name", "value"], actions: [newDeal], badge: total })

const app = defineApp({
  name: "deals",
  title: "Deals",
  version: "1.0.0",
  permissions: { "deals.view": { label: "See deals" }, "deals.edit": { label: "Change deals" }, "deals.values": { label: "See values" } },
  entities: [deal],
  actions: [markWon, newDeal],
  artifacts: [total],
  pages: [deals],
  nav: [{ pages: [deals] }],
})

describe("define* handles and defineApp", () => {
  test("the manifest from handles: names, featured actions, «+ Nuovo», widgets, badge", () => {
    const m = app.manifest()
    assert.equal(m.mcp.url, "/mcp")
    assert.deepEqual(m.auth.authorizationServers, [])
    const e = m.entities.find((x) => x.name === "deal")!
    assert.deepEqual(e.record, { fields: ["name", "value"], actions: ["mark_won"] })
    assert.equal(m.actions.find((a) => a.name === "mark_won")?.tool.name, "deal_mark_won")
    assert.equal(m.actions.find((a) => a.name === "mark_won")?.effect, "irreversible")
    assert.deepEqual(m.widgets, [{ artifact: "pipeline_total", sizes: ["medium", "large"], size: "medium" }])
    assert.equal(m.pages.find((p) => p.name === "deals")?.badge, "pipeline_total")
    assert.deepEqual(m.nav, [{ pages: ["deals"] }])
    assert.equal(app.uri(deal, "d1"), "clegra://deals/deal/d1")
  })

  test("a handle that is not the app's own is refused at definition", () => {
    const other = defineEntity({ ...deal.definition, name: "other" })
    const stray = defineAction({ name: "stray", on: other, title: "Stray", input: z.object({}), run: () => {} })
    assert.throws(() => defineApp({ name: "deals", title: "Deals", version: "1.0.0", entities: [deal], actions: [stray] }), /entity "other" is not one of defineApp's entities/)
    const page = definePage({ name: "others", title: "Others", list: other, columns: ["name"] })
    assert.throws(() => defineApp({ name: "deals", title: "Deals", version: "1.0.0", permissions: { "deals.view": { label: "x" }, "deals.values": { label: "y" } }, entities: [deal], pages: [page] }), /not one of defineApp's entities/)
  })

  test("a featured action needs its entity's record template", () => {
    const bare = defineEntity({ ...deal.definition, name: "bare", record: undefined, permission: undefined })
    const act = defineAction({ name: "go", on: bare, featured: true, title: "Go", input: z.object({}), run: () => {} })
    assert.throws(() => defineApp({ name: "deals", title: "Deals", version: "1.0.0", permissions: { "deals.values": { label: "y" } }, entities: [bare], actions: [act] }), /record: \{ fields \}/)
  })
})

describe("serve", () => {
  const served = serve(app, { auth: { signIn: devSignIn(app) } })

  test("the served manifest names the sign-in", () => {
    assert.deepEqual(served.manifest().auth.authorizationServers, ["http://localhost:3000"])
    assert.equal(served.app, app)
  })

  test("a development token calls a record action; a workspace host confirms it", async () => {
    const c = await testClient(served, { permissions: "all" })
    const listed = (await c.listTools()).map((t) => t.name)
    assert.ok(listed.includes("deal_mark_won"), listed.join(", "))
    const host = await testClient(served, { host: "workspace", permissions: "all" })
    const unconfirmed = await host.call("deal_mark_won", { id: "d1" })
    assert.equal((unconfirmed.structuredContent as { error: { code: string } }).error.code, "confirmation_required")
    const ok = await host.confirmed("deal_mark_won", { id: "d1" })
    assert.ok(!ok.isError, JSON.stringify(ok))
    assert.ok(won.includes("Acme renewal"))
  })

  test("development tokens count only from a loopback caller", async () => {
    const c = await testClient(served, { remoteAddress: "203.0.113.7" })
    assert.equal(c.status, 401)
  })

  test("the installation-level caller is a development workspace host's", async () => {
    const c = await installationClient(served)
    assert.equal(c.status, 200)
  })

  test("the dev login: test people and the console code", async () => {
    const dev = served.dev!
    const page = await served.fetch(new Request("http://localhost:3000/oauth/dev-login?return=/x"))
    assert.equal(page.status, 200)
    assert.match(await page.text(), /Test person/)
    const wrong = await served.fetch(new Request("http://localhost:3000/oauth/dev-login", { method: "POST", body: new URLSearchParams({ person: "test-person", code: "nope", return: "/x" }) }))
    assert.equal(wrong.status, 401)
    const right = await served.fetch(new Request("http://localhost:3000/oauth/dev-login", { method: "POST", body: new URLSearchParams({ person: "test-person", code: dev.code, return: "/x" }) }))
    assert.equal(right.status, 303)
    assert.equal(right.headers.get("location"), "/x")
    assert.match(right.headers.get("set-cookie") ?? "", /dev_session=/)
  })

  test("devSignIn is refused in production", () => {
    const env = process.env as Record<string, string | undefined>
    const was = env.NODE_ENV
    env.NODE_ENV = "production"
    try {
      assert.throws(() => devSignIn(app), /refused when NODE_ENV is production/)
    } finally {
      env.NODE_ENV = was
    }
  })
})

describe("the index as OpenAPI", () => {
  const served = serve(app, { auth: { signIn: devSignIn(app) } })

  test("every operation a plain client may call, with its effect, behind the sign-in", async () => {
    const r = await served.fetch(new Request("http://localhost:3000/openapi.json"))
    assert.equal(r.status, 200)
    const doc = (await r.json()) as OpenApiDocument
    assert.equal(doc.openapi, "3.1.1")
    const op = doc.paths["/operations/deal_mark_won"]!.post as Record<string, unknown>
    assert.equal(op.operationId, "deal_mark_won")
    assert.equal(op["x-clegra-effect"], "irreversible")
    assert.equal(op["x-clegra-entity"], "deal")
    assert.equal((doc.paths["/operations/deal_list"]!.post as Record<string, unknown>)["x-clegra-effect"], "read")
    assert.ok(!Object.keys(doc.paths).some((p) => p.includes("clegra_")), Object.keys(doc.paths).join(", "))
    assert.equal((doc.components.securitySchemes as { signIn: { type: string } }).signIn.type, "oauth2")
    assert.deepEqual(doc.security, [{ signIn: [] }])
    assert.deepEqual(doc["x-clegra-pages"].map((p) => p.name), ["deals"])
  })

  test("an operation over HTTP: the same caller, checks and results as its tool", async () => {
    const token = await served.dev!.token({ permissions: ["deals.view"] })
    const call = (tool: string, body: unknown, bearer: string | null = token) =>
      served.fetch(new Request(`http://localhost:3000/operations/${tool}`, { method: "POST", headers: { "content-type": "application/json", ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) }, body: JSON.stringify(body) }), { remoteAddress: "127.0.0.1" })
    const got = await call("deal_get", { id: "d1" })
    assert.equal(got.status, 200)
    const record = (await got.json()) as Record<string, unknown>
    assert.equal(JSON.stringify(record).includes("Acme renewal"), true)
    // No value: the caller may not see it.
    assert.equal(JSON.stringify(record).includes("1200"), false)
    assert.equal((await call("deal_get", { id: "nope" })).status, 404)
    assert.equal((await call("deal_mark_won", { id: "d1" })).status, 404, "a tool the caller may not use is not there")
    assert.equal((await call("deal_get", { id: "d1" }, null)).status, 401)
    assert.equal((await call("clegra_view", {})).status, 404)
    const bad = await served.fetch(new Request("http://localhost:3000/operations/deal_get", { method: "POST", headers: { authorization: `Bearer ${token}` }, body: "[1]" }), { remoteAddress: "127.0.0.1" })
    assert.equal(bad.status, 400)
  })
})

describe("adapters", () => {
  test("Express middleware: the app's routes, everything else to the next middleware", async () => {
    const served = serve(app, { auth: { signIn: devSignIn(app) } })
    const middleware = clegraMiddleware(served)
    const http = createServer((req, res) => void middleware(req, res, () => res.writeHead(418).end("next")))
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve))
    const port = (http.address() as { port: number }).port
    try {
      const manifest = await fetch(`http://127.0.0.1:${port}/.well-known/clegra.json`)
      assert.equal(manifest.status, 200)
      assert.equal(((await manifest.json()) as { name: string }).name, "deals")
      const other = await fetch(`http://127.0.0.1:${port}/about`)
      assert.equal(other.status, 418)
    } finally {
      await new Promise((resolve) => http.close(resolve))
    }
  })
})
