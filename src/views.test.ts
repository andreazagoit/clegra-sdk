import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { z } from "zod"

import { defineApp, MemoryStore } from "./index"
import { testCore } from "./testing"
import type { ViewTicket } from "./views"

// Views at the app's own origin (spec §5.3): a Clegra client asks the app for a one-minute, single-use view ticket
// with the person's app token and posts it into its frame; the app answers with the view, framed only by that client.

const RES = "https://pipeline.test/mcp"
const APP = "https://pipeline.test"
const CLIENT = "https://app.clegra.test"
const OTHER = "https://other-app.test"
const core = await testCore({ resource: RES, issuer: "https://core.test" })

function makeApp(store = new MemoryStore()) {
  return defineApp({
    name: "pipeline",
    title: "Pipeline",
    version: "1.0.0",
    store,
    auth: { resource: RES, clegra: core.options({ clientOrigins: [CLIENT, "app://client"] }) },
    entities: { deal: { label: "Deal", schema: z.object({ id: z.string(), name: z.string().meta({ role: "title" }) }), get: () => null, list: () => ({ rows: [] }) } },
    pages: { board: { title: "Board", dashboard: [] }, notes: { title: "Notes", view: { html: "<!doctype html><html><head><title>n</title></head><body>n</body></html>", csp: { connectDomains: ["https://api.pipeline.test"] } } } },
  })
}

const VIEW = "ui://pipeline/view"
const who = { company: "co-1", sub: "ada" }

async function ticketFor(app: ReturnType<typeof makeApp>, input: { view?: string; origin?: string } = {}) {
  const c = await core.client(app, who)
  return c.call("clegra_view", { view: input.view ?? VIEW, origin: input.origin ?? CLIENT })
}

/** What a browser sends when the client's document posts the form into its frame. */
const post = (app: ReturnType<typeof makeApp>, ticket: string, init: { origin?: string | null; dest?: string | null; path?: string; method?: string } = {}) => {
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" }
  if (init.origin !== null) headers.origin = init.origin ?? CLIENT
  if (init.dest !== null) headers["sec-fetch-dest"] = init.dest ?? "iframe"
  const method = init.method ?? "POST"
  return app.fetch(new Request(`${APP}${init.path ?? "/clegra/views/view"}`, { method, headers, ...(method === "POST" ? { body: new URLSearchParams({ ticket }) } : {}) }))
}

describe("views at the app's own origin", () => {
  test("the ticket tool: app-only, for a person's app token, a ticket for one view and one client origin", async () => {
    const app = makeApp()
    const c = await core.client(app, who)
    const tool = (await c.listTools()).find((t) => t.name === "clegra_view")
    assert.ok(tool)
    assert.deepEqual((tool._meta as { ui: unknown }).ui, { visibility: ["app"] })
    const r = await c.call("clegra_view", { view: VIEW, origin: CLIENT })
    assert.ok(!r.isError, JSON.stringify(r.structuredContent))
    const t = r.structuredContent as unknown as ViewTicket
    assert.equal(t.action, `${APP}/clegra/views/view`)
    assert.equal(t.field, "ticket")
    assert.equal(t.view, VIEW)
    assert.match(t.ticket, /^[A-Za-z0-9_-]{43}$/)
    assert.ok(!t.action.includes(t.ticket), "the ticket is never in the address")
    assert.ok(Date.parse(t.expiresAt) - Date.now() <= 60_000)
  })

  test("a ticket only for a client origin the app lists, and a view the app has", async () => {
    const app = makeApp()
    const other = await ticketFor(app, { origin: OTHER })
    assert.equal(other.isError, true)
    assert.match(JSON.stringify(other.structuredContent), /not one of this app's Clegra client origins/)
    const missing = await ticketFor(app, { view: "ui://pipeline/pages/nowhere" })
    assert.equal(missing.isError, true)
    const foreign = await ticketFor(app, { view: "ui://crm/view" })
    assert.equal(foreign.isError, true)
  })

  test("an agent acting for the person gets no view ticket (the tool is not there)", async () => {
    const app = makeApp()
    const c = await core.client(app, { ...who, act: "device-agent:abc" })
    assert.ok(!(await c.listTools()).some((t) => t.name === "clegra_view"))
  })

  test("the posted ticket opens the view: framed by that client only, the client's origin for the bridge, no cache, no referrer", async () => {
    const app = makeApp()
    const t = (await ticketFor(app)).structuredContent as unknown as ViewTicket
    const r = await post(app, t.ticket)
    assert.equal(r.status, 200)
    const csp = r.headers.get("content-security-policy") ?? ""
    assert.match(csp, /frame-ancestors https:\/\/app\.clegra\.test$/)
    assert.match(csp, /default-src 'none'/)
    assert.match(csp, /connect-src 'none'/)
    assert.equal(r.headers.get("x-frame-options"), null)
    assert.equal(r.headers.get("cache-control"), "no-store")
    // same-origin: the view's own requests keep their Origin; other origins get no referrer (spec §5.3).
    assert.equal(r.headers.get("referrer-policy"), "same-origin")
    const html = await r.text()
    assert.match(html, /<meta name="clegra-host" content="https:\/\/app\.clegra\.test">/)
    assert.match(html, /postMessage\(m, HOST \|\| "\*"\)/)
  })

  test("a hand-written view: its declared domains in its policy, the client's origin added to its head", async () => {
    const app = makeApp()
    const t = (await ticketFor(app, { view: "ui://pipeline/pages/notes" })).structuredContent as unknown as ViewTicket
    assert.equal(t.action, `${APP}/clegra/views/pages/notes`)
    const r = await post(app, t.ticket, { path: "/clegra/views/pages/notes" })
    assert.equal(r.status, 200)
    assert.match(r.headers.get("content-security-policy") ?? "", /connect-src https:\/\/api\.pipeline\.test;/)
    assert.match(await r.text(), /^<!doctype html><html><head><meta name="clegra-host" content="https:\/\/app\.clegra\.test"><title>/)
  })

  test("the desktop app's origin (app://client) is a client origin too", async () => {
    const app = makeApp()
    const t = (await ticketFor(app, { origin: "app://client" })).structuredContent as unknown as ViewTicket
    const r = await post(app, t.ticket, { origin: "app://client" })
    assert.equal(r.status, 200)
    assert.match(r.headers.get("content-security-policy") ?? "", /frame-ancestors app:\/\/client$/)
  })

  test("refused: used twice, from another origin, outside a frame, for another view, by GET, with no ticket", async () => {
    const app = makeApp()
    const ticket = async () => ((await ticketFor(app)).structuredContent as unknown as ViewTicket).ticket
    const once = await ticket()
    assert.equal((await post(app, once)).status, 200)
    assert.equal((await post(app, once)).status, 403)
    assert.equal((await post(app, await ticket(), { origin: OTHER })).status, 403)
    assert.equal((await post(app, await ticket(), { origin: null })).status, 403)
    assert.equal((await post(app, await ticket(), { dest: "document" })).status, 403)
    assert.equal((await post(app, await ticket(), { path: "/clegra/views/pages/board" })).status, 403)
    assert.equal((await post(app, await ticket(), { method: "GET" })).status, 405)
    assert.equal((await post(app, "")).status, 400)
    assert.equal((await post(app, await ticket(), { path: "/clegra/views/nowhere" })).status, 404)
    const refused = await post(app, once)
    assert.match(refused.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/)
  })

  test("a ticket from one instance opens the view at another (the store is shared)", async () => {
    const store = new MemoryStore()
    const one = makeApp(store)
    const two = makeApp(store)
    const t = (await ticketFor(one)).structuredContent as unknown as ViewTicket
    assert.equal((await post(two, t.ticket)).status, 200)
    assert.equal((await post(one, t.ticket)).status, 403)
  })

  test("a person removed from the company after the ticket gets no view", async () => {
    const app = makeApp()
    const t = (await ticketFor(app)).structuredContent as unknown as ViewTicket
    assert.equal((await core.deliver(app, await core.event("member.removed", { company: "co-1", sub: "ada" }))).status, 204)
    assert.equal((await post(app, t.ticket)).status, 403)
  })
})
