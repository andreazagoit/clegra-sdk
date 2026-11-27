import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { z } from "zod"

import { agentDigest } from "./agents"
import { defineApp } from "./app"
import { defineAgent, defineBadge, defineEntity, definePage, defineTool, defineWidget } from "./define"
import { serve, type ServedApp } from "./server"
import { devSignIn } from "./signin/dev"
import { MemoryStore } from "./store"
import { confirmOnPage, testClient } from "./testing"

const ORIGIN = "http://localhost:3000"
type Job = { id: string; title: string; status: "open" | "done"; customer: string; owner: string; version: number }

function fixture(options: { link?: boolean; waitMs?: number; fetch?: typeof fetch } = {}) {
  const jobs = new Map<string, Job>([
    ["1", { id: "1", title: "Replace boiler", status: "open", customer: "Harbor Supplies Ltd", owner: "ada", version: 1 }],
    ["2", { id: "2", title: "Paint the hall", status: "open", customer: "North Office", owner: "bob", version: 1 }],
  ])
  const job = defineEntity({
    name: "job",
    title: { en: "Job", it: "Lavoro" },
    path: "/jobs/{id}",
    schema: z.object({ id: z.string(), title: z.string(), status: z.enum(["open", "done"]), customer: z.string(), owner: z.string(), version: z.number() }),
    card: { title: "title", subtitle: "customer", status: "status" },
    get: ({ id }) => jobs.get(id!) ?? null,
    list: () => ({ rows: [...jobs.values()] }),
    shareAs: [{ type: "contact", fields: { name: "/customer" } }],
  })
  const open = defineBadge({ name: "open", value: () => [...jobs.values()].filter((j) => j.status === "open").length })
  const jobsPage = definePage({ name: "jobs", title: { en: "Jobs", it: "Lavori" }, path: "/jobs{?status}", role: "list", entity: job, nav: { section: { en: "Work", it: "Lavoro" }, order: 10 }, badge: open, frame: true })
  const jobPage = definePage({ name: "job", title: "Job", path: "/jobs/{id}", role: "record", entity: job, frame: true })
  const adminPage = definePage({ name: "admin", title: "Admin", path: "/admin", role: "settings", allow: (ctx) => ctx.person.id === "ada" })
  const getJob = defineTool({ name: "job.get", title: "Get job", description: "One job", input: z.object({ id: z.string() }), annotations: { readOnly: true }, entity: job, on: "record", page: jobPage, run: (_i, _c, record) => ({ data: record, records: [{ entity: job, record }] }) })
  const listJobs = defineTool({ name: "job.list", title: "List jobs", description: "Jobs", input: z.object({ status: z.enum(["open", "done"]).optional() }), annotations: { readOnly: true }, entity: job, page: jobsPage, run: ({ status }) => ({ data: { rows: [...jobs.values()].filter((j) => !status || j.status === status) } }) })
  const complete = defineTool({
    name: "job.complete",
    title: { en: "Complete job", it: "Completa lavoro" },
    description: "Closes a job",
    input: z.object({ id: z.string() }),
    annotations: { readOnly: false, destructive: false, idempotent: true },
    entity: job,
    on: "record",
    page: jobPage,
    run: (_i, ctx, record) => {
      record.status = "done"
      record.version++
      ctx.changed(open)
      return { records: [{ entity: job, record }], text: "Done" }
    },
  })
  let sent = 0
  const sendReport = defineTool({
    name: "job.send_report",
    title: "Send report",
    description: "Sends the job's report to the customer",
    input: z.object({ id: z.string(), note: z.string().optional() }),
    annotations: { readOnly: false, destructive: false, openWorld: true },
    entity: job,
    on: "record",
    confirm: { message: (_i, _c, r) => `Send the report of «${r.title}» to ${r.customer}?`, values: (_i, _c, r) => ({ customer: r.customer, version: r.version }) },
    run: () => {
      sent++
      return { data: { sent } }
    },
  })
  const removeJob = defineTool({
    name: "job.delete",
    title: "Delete job",
    description: "Deletes a job for good",
    input: z.object({ id: z.string() }),
    annotations: { readOnly: false, destructive: true },
    entity: job,
    on: "record",
    confirm: { message: (_i, _c, r) => `Delete «${r.title}» for good?` },
    run: (_i, _c, record) => {
      jobs.delete(record.id)
      return { data: { deleted: record.id } }
    },
  })
  const createJob = defineTool({
    name: "job.create",
    title: { en: "New job", it: "Nuovo lavoro" },
    description: "Creates a job",
    input: z.strictObject({ title: z.string(), customer: z.string().optional() }),
    annotations: { readOnly: false, destructive: false },
    entity: job,
    accepts: [{ type: "message", title: { en: "New job", it: "Nuovo lavoro" }, map: { title: "headline" } }],
    plugins: [{ target: { builtin: "mail" }, recordType: "message", title: "New job", map: { title: "/headline" } }],
    run: ({ title, customer }, ctx) => {
      const id = String(jobs.size + 1)
      const record: Job = { id, title, status: "open", customer: customer ?? "", owner: ctx.person.id, version: 1 }
      jobs.set(id, record)
      return { records: [{ entity: job, record }], data: { id, source: ctx.source } }
    },
  })
  const pings: unknown[] = []
  const notifyTool = defineTool({
    name: "job.ping",
    title: "Ping",
    description: "Notifies",
    input: z.object({}),
    annotations: { readOnly: false, destructive: false },
    run: async (_i, ctx) => {
      await ctx.notify({ type: "job.assigned", title: { en: "New job", it: "Nuovo lavoro" }, url: `${ctx.origin}/jobs/1`, dedupe: "job:1" })
      return {}
    },
  })
  const tile = defineWidget({ name: "open-jobs", title: "Open jobs", sizes: ["small", "medium"], data: (ctx) => ({ title: "Open jobs", value: [...jobs.values()].filter((j) => j.status === "open").length, url: `${ctx.origin}/jobs?status=open` }) })
  const helper = defineAgent({ name: "triage", description: "Sorts new jobs", instructions: "Look at open jobs.", tools: [listJobs, getJob, complete], tier: "fast", starters: ["What is open?"], schedules: [{ name: "morning", cron: "0 8 * * 1-5", starter: 0 }] })
  const app = defineApp({
    name: "jobs",
    title: { en: "Jobs", it: "Lavori" },
    description: "Job requests",
    version: "1.0.0",
    entities: [job],
    tools: [getJob, listJobs, complete, sendReport, removeJob, createJob, notifyTool],
    pages: [jobsPage, jobPage, adminPage],
    badges: [open],
    widgets: [tile],
    agents: [helper],
    notifications: { "job.assigned": { title: "A job was assigned to you" } },
    sessionTransfer: { link: options.link ?? false },
  })
  const signIn = devSignIn(app, { issuer: ORIGIN, people: [{ id: "ada", name: "Ada" }, { id: "bob", name: "Bob" }], code: "CODE1234" })
  const served = serve(app, { origin: ORIGIN, auth: { signIn }, store: new MemoryStore(), confirmWaitMs: options.waitMs ?? 0, pages: "generated", events: { fetch: options.fetch ?? (async (_u, init) => (pings.push(JSON.parse(String(init?.body))), new Response(null, { status: 204 }))) } })
  return { app, served, signIn, jobs, pings, sentCount: () => sent }
}

async function login(served: ServedApp, person: string): Promise<string> {
  const r = await served.fetch(new Request(`${ORIGIN}/oauth/dev-login`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN }, body: new URLSearchParams({ person, code: "CODE1234", return: "/" }) }))
  const cookie = r.headers.get("set-cookie")
  assert.ok(cookie, `dev login: ${r.status}`)
  return cookie.split(";")[0]!
}

describe("web-map", () => {
  test("server/discover declares the extensions with the origin", async () => {
    const { served, signIn } = fixture()
    const c = testClient(served, { token: await signIn.dev.token({ person: "ada" }) })
    const d = await c.discover()
    assert.deepEqual(d.capabilities.extensions?.["com.clegra/web-map"], { revision: "0.2", origin: ORIGIN })
    assert.deepEqual(d.capabilities.extensions?.["com.clegra/app-share"], { revision: "0.1" })
    assert.ok(d.capabilities.extensions?.["io.modelcontextprotocol/events"])
    assert.ok(d.capabilities.extensions?.["io.modelcontextprotocol/skills"])
  })

  test("tools carry web-map _meta and truthful annotations", async () => {
    const { served, signIn } = fixture()
    const tools = await testClient(served, { token: await signIn.dev.token({ person: "ada" }) }).listTools()
    const get = tools.find((t) => t.name === "job.get")!
    assert.deepEqual(get._meta?.["com.clegra/web-map"], { entity: "job", on: "record", recordArg: "id", page: `${ORIGIN}/jobs/{id}` })
    assert.equal(get.annotations?.readOnlyHint, true)
    const send = tools.find((t) => t.name === "job.send_report")!
    assert.equal(send.annotations?.destructiveHint, false)
    assert.equal(send.annotations?.openWorldHint, true)
    const bound = tools.find((t) => t.name === "create_bound_browser_session")!
    assert.deepEqual(bound._meta?.["com.clegra/session-transfer"], { revision: "0.3", mode: "bound" })
    assert.deepEqual(bound._meta?.ui, { visibility: ["app"] })
    assert.ok(!tools.some((t) => t.name === "create_browser_session"), "the link mode is off unless the app offers it")
  })

  test("titles follow the person's language", async () => {
    const { served, signIn } = fixture()
    const tools = await testClient(served, { token: await signIn.dev.token({ person: "ada" }), language: "it" }).listTools()
    assert.equal(tools.find((t) => t.name === "job.complete")?.title, "Completa lavoro")
  })

  test("records are resources at their web URL; a bearer GET returns the same JSON", async () => {
    const { served, signIn } = fixture()
    const token = await signIn.dev.token({ person: "ada" })
    const c = testClient(served, { token })
    const templates = await c.listTemplates()
    const t = templates.find((x) => x.name === "job")!
    assert.equal(t.uriTemplate, `${ORIGIN}/jobs/{id}`)
    assert.deepEqual((t._meta?.["com.clegra/web-map"] as { record: unknown }).record, { entity: "job", get: "job.get", list: "job.list", card: { title: "title", subtitle: "customer", status: "status" } })
    assert.deepEqual(t._meta?.["com.clegra/app-share"], { shareAs: [{ type: "contact", fields: { name: "/customer" } }] })
    const viaMcp = await c.readJson(`${ORIGIN}/jobs/1`)
    const viaWeb = await served.fetch(new Request(`${ORIGIN}/jobs/1`, { headers: { authorization: `Bearer ${token}` } }))
    assert.equal(viaWeb.status, 200)
    assert.equal(viaWeb.headers.get("vary"), "Authorization")
    assert.match(viaWeb.headers.get("cache-control") ?? "", /private/)
    assert.deepEqual(await viaWeb.json(), viaMcp)
    const bad = await served.fetch(new Request(`${ORIGIN}/jobs/1`, { headers: { authorization: "Bearer nope" } }))
    assert.equal(bad.status, 401)
    assert.match(bad.headers.get("www-authenticate") ?? "", /resource_metadata=/)
    // Without a bearer token: the page (here the generated one, behind the app's sign-in).
    const page = await served.fetch(new Request(`${ORIGIN}/jobs/1`))
    assert.equal(page.status, 303)
  })

  test("a tool takes the record's URL or its bare id; results link records and say what changed", async () => {
    const { served, signIn } = fixture()
    const c = testClient(served, { token: await signIn.dev.token({ person: "ada" }) })
    const r = await c.call("job.complete", { id: `${ORIGIN}/jobs/1` })
    assert.equal(r.isError, undefined)
    assert.deepEqual(r.content?.[1], { type: "resource_link", uri: `${ORIGIN}/jobs/1`, name: "Replace boiler", mimeType: "application/json" })
    assert.deepEqual((r._meta?.["com.clegra/web-map"] as { changed: string[] }).changed.sort(), [`${ORIGIN}/jobs/1`, "webmap://badges/open"].sort())
    const byId = await c.call("job.get", { id: "2" })
    assert.equal((byId.structuredContent as Job).title, "Paint the hall")
    const missing = await c.call("job.get", { id: "99" })
    assert.equal((missing.structuredContent?.error as { code: string }).code, "not_found")
    const other = await c.call("job.get", { id: "https://elsewhere.example/jobs/1" })
    assert.equal((other.structuredContent?.error as { code: string }).code, "invalid_input")
  })

  test("the pages resource lists what this person may open; badges and widgets are resources", async () => {
    const { served, signIn } = fixture()
    const ada = testClient(served, { token: await signIn.dev.token({ person: "ada" }) })
    const bob = testClient(served, { token: await signIn.dev.token({ person: "bob" }) })
    const pages = (await ada.readJson<{ pages: { name: string; url: string; badge?: string; nav?: unknown; frame?: boolean }[] }>("webmap://pages")).pages
    assert.deepEqual(pages.map((p) => p.name), ["jobs", "job", "admin"])
    assert.equal(pages[0]!.url, `${ORIGIN}/jobs{?status}`)
    assert.equal(pages[0]!.badge, "webmap://badges/open")
    assert.deepEqual(pages[0]!.nav, { section: "Work", order: 10 })
    assert.deepEqual((await bob.readJson<{ pages: { name: string }[] }>("webmap://pages")).pages.map((p) => p.name), ["jobs", "job"])
    assert.deepEqual(await ada.readJson("webmap://badges/open"), { value: 2 })
    const resources = await ada.listResources()
    const w = resources.find((r) => r.uri === "webmap://widgets/open-jobs")!
    assert.deepEqual(w._meta?.["com.clegra/web-map"], { widget: { sizes: ["small", "medium"] } })
    assert.equal((await ada.readJson<{ value: number }>("webmap://widgets/open-jobs")).value, 2)
    assert.ok(!resources.some((r) => r.uri.startsWith(`${ORIGIN}/`)), "no page is an MCP resource")
  })

  test("nothing of the map is public: the Server Card carries only its schema, name, icons, description and the endpoint; the AI Catalog lists it", async () => {
    const { served } = fixture()
    const card = await served.fetch(new Request(`${ORIGIN}/mcp/server-card`))
    assert.equal(card.headers.get("content-type"), "application/mcp-server-card+json")
    const body = (await card.json()) as Record<string, unknown>
    assert.deepEqual(Object.keys(body).sort(), ["$schema", "description", "name", "remotes", "title", "version"])
    assert.equal(body.$schema, "https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json")
    assert.match(String(body.name), /^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/)
    assert.deepEqual(body.remotes, [{ type: "streamable-http", url: `${ORIGIN}/mcp` }])
    assert.equal(card.headers.get("access-control-allow-origin"), "*")
    const etag = card.headers.get("etag")
    assert.ok(etag)
    assert.equal((await served.fetch(new Request(`${ORIGIN}/mcp/server-card`, { headers: { "if-none-match": etag } }))).status, 304)
    const catalogAnswer = await served.fetch(new Request(`${ORIGIN}/.well-known/ai-catalog.json`))
    assert.equal(catalogAnswer.headers.get("content-type"), "application/ai-catalog+json")
    const catalog = (await catalogAnswer.json()) as Record<string, unknown>
    const host = new URL(ORIGIN).hostname
    assert.deepEqual(catalog, {
      specVersion: "0.9",
      host: { displayName: body.title },
      entries: [{ identifier: `urn:air:${host}:${String(body.name).split("/")[1]}:mcp`, type: "application/mcp-server-card+json", url: `${ORIGIN}/mcp/server-card` }],
    })
    const preflight = await served.fetch(new Request(`${ORIGIN}/.well-known/ai-catalog.json`, { method: "OPTIONS" }))
    assert.equal(preflight.status, 204)
    assert.equal(preflight.headers.get("access-control-allow-headers"), "Content-Type, If-None-Match")
    const unauth = await served.fetch(new Request(`${ORIGIN}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "resources/read", params: { uri: "webmap://pages" } }) }))
    assert.equal(unauth.status, 401)
    const prm = (await (await served.fetch(new Request(`${ORIGIN}/.well-known/oauth-protected-resource/mcp`))).json()) as { resource: string; scopes_supported: string[] }
    assert.equal(prm.resource, `${ORIGIN}/mcp`)
    assert.ok(!prm.scopes_supported.includes("browser_session"))
  })
})

describe("access", () => {
  test("a write above the token's scope gets the standard step-up", async () => {
    const { served, signIn } = fixture()
    const c = testClient(served, { token: await signIn.dev.token({ person: "ada", scopes: ["web.read"] }) })
    assert.equal((await c.call("job.get", { id: "1" })).isError, undefined)
    const r = await c.call("job.complete", { id: "1" })
    assert.equal(r.status, 403)
    assert.match(r.headers.get("www-authenticate") ?? "", /insufficient_scope/)
    assert.match(r.headers.get("www-authenticate") ?? "", /web\.write/)
    const w = testClient(served, { token: await signIn.dev.token({ person: "ada", scopes: ["web.read", "web.write"] }) })
    const irr = await w.call("job.send_report", { id: "1" })
    assert.equal(irr.status, 403)
    assert.match(irr.headers.get("www-authenticate") ?? "", /web\.irreversible/)
  })

  test("changes are logged per person; revoking refuses the grant's tokens", async () => {
    const { served, signIn } = fixture()
    const token = await signIn.dev.token({ person: "ada" })
    const c = testClient(served, { token })
    await c.call("job.complete", { id: "1" })
    const log = await served.log("ada")
    assert.ok(log.some((e) => e.tool === "job.complete" && e.record === `${ORIGIN}/jobs/1` && e.outcome === "done"))
    await served.revoke(`dev:ada:${"https://dev.clegra.invalid/client.json"}`)
    assert.equal((await c.rpc("tools/list")).status, 401)
  })
})

describe("confirmation", () => {
  test("URL elicitation: no run on accept alone; the person confirms on the app's page; one run, a repeat returns the first result", async () => {
    const f = fixture()
    const c = testClient(f.served, { token: await f.signIn.dev.token({ person: "ada" }) })
    const first = await c.call("job.send_report", { id: "1" })
    assert.equal(first.resultType, "input_required")
    const ask = first.inputRequests!.confirm!
    assert.equal(ask.params.mode, "url")
    assert.match(ask.params.message!, /Send the report of «Replace boiler» to Harbor Supplies Ltd/)
    const state = first.requestState!
    const early = await c.call("job.send_report", { id: "1" }, { inputResponses: { confirm: { action: "accept" } }, requestState: state })
    assert.equal(early.resultType, "input_required", "accept proves nothing (CNF-1)")
    assert.equal(f.sentCount(), 0)
    const ok = await confirmOnPage(f.served, ask.params.url!, await login(f.served, "ada"))
    assert.equal(ok.status, 200)
    const run = await c.call("job.send_report", { id: "1" }, { inputResponses: { confirm: { action: "accept" } }, requestState: state })
    assert.deepEqual(run.structuredContent, { sent: 1 })
    const again = await c.call("job.send_report", { id: "1" }, { inputResponses: { confirm: { action: "accept" } }, requestState: state })
    assert.deepEqual(again.structuredContent, { sent: 1 })
    assert.equal(f.sentCount(), 1)
    assert.ok((await f.served.log("ada")).some((e) => e.kind === "confirmation" && e.outcome === "confirmed"))
  })

  test("fallback for clients without URL elicitation: the error with the link, then the same call runs once", async () => {
    const f = fixture()
    const c = testClient(f.served, { token: await f.signIn.dev.token({ person: "ada" }), elicitation: false })
    const first = await c.call("job.send_report", { id: "1" })
    const error = first.structuredContent?.error as { code: string; url: string; expiresAt: string }
    assert.equal(error.code, "confirmation_required")
    assert.ok(first.content?.some((x) => x.type === "resource_link" && x.uri === error.url))
    await confirmOnPage(f.served, error.url, await login(f.served, "ada"))
    const changedArgs = await c.call("job.send_report", { id: "1", note: "x" })
    assert.equal((changedArgs.structuredContent?.error as { code: string }).code, "confirmation_required", "other arguments need their own confirmation")
    const run = await c.call("job.send_report", { id: "1" })
    assert.deepEqual(run.structuredContent, { sent: 1 })
  })

  test("a repeat of a confirmed call that deleted its record returns the first result", async () => {
    const f = fixture()
    const c = testClient(f.served, { token: await f.signIn.dev.token({ person: "ada" }) })
    const first = await c.call("job.delete", { id: "2" })
    await confirmOnPage(f.served, first.inputRequests!.confirm!.params.url!, await login(f.served, "ada"))
    const more = { inputResponses: { confirm: { action: "accept" } }, requestState: first.requestState! }
    assert.deepEqual((await c.call("job.delete", { id: "2" }, more)).structuredContent, { deleted: "2" })
    assert.deepEqual((await c.call("job.delete", { id: "2" }, more)).structuredContent, { deleted: "2" })
  })

  test("decline, a changed record and another person's session", async () => {
    const f = fixture()
    const c = testClient(f.served, { token: await f.signIn.dev.token({ person: "ada" }), elicitation: false })
    const url = ((await c.call("job.send_report", { id: "1" })).structuredContent?.error as { url: string }).url
    const bob = await confirmOnPage(f.served, url, await login(f.served, "bob")).catch((e: Error) => e)
    assert.ok(bob instanceof Error || bob.status === 403)
    const page = await f.served.fetch(new Request(url, { headers: { cookie: await login(f.served, "bob") } }))
    assert.equal(page.status, 403)
    assert.match(page.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/)
    await confirmOnPage(f.served, url, await login(f.served, "ada"), "decline")
    assert.equal(((await c.call("job.send_report", { id: "1" })).structuredContent?.error as { code: string }).code, "confirmation_declined")
    const url2 = ((await c.call("job.send_report", { id: "1" })).structuredContent?.error as { url: string }).url
    await confirmOnPage(f.served, url2, await login(f.served, "ada"))
    f.jobs.get("1")!.customer = "Someone Else"
    assert.equal(((await c.call("job.send_report", { id: "1" })).structuredContent?.error as { code: string }).code, "confirmation_stale")
    assert.equal(f.sentCount(), 0)
  })

  test("a transferred session cannot confirm", async () => {
    const f = fixture()
    const token = await f.signIn.dev.token({ person: "ada" })
    const c = testClient(f.served, { token, elicitation: false })
    const url = ((await c.call("job.send_report", { id: "1" })).structuredContent?.error as { url: string }).url
    const cookie = await transferBound(f.served, c, `${ORIGIN}/jobs/1`)
    const page = await f.served.fetch(new Request(url, { headers: { cookie } }))
    assert.equal(page.status, 403)
  })
})

async function pkce() {
  const verifier = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url")
  const challenge = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))).toString("base64url")
  return { verifier, challenge }
}

async function transferBound(served: ServedApp, c: ReturnType<typeof testClient>, target: string): Promise<string> {
  const { verifier, challenge } = await pkce()
  const r = await c.call("create_bound_browser_session", { target, challenge })
  const url = (r.structuredContent as { url: string }).url
  const redeem = await served.fetch(new Request(url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "sec-fetch-site": "none" }, body: new URLSearchParams({ verifier }) }))
  assert.equal(redeem.status, 303)
  assert.equal(redeem.headers.get("location"), target)
  return redeem.headers.get("set-cookie")!.split(";")[0]!
}

describe("session transfer", () => {
  test("strong mode: refused without challenge or scope; a code works once and only with its verifier", async () => {
    const f = fixture()
    const c = testClient(f.served, { token: await f.signIn.dev.token({ person: "ada" }) })
    const without = await c.call("create_bound_browser_session", { target: `${ORIGIN}/jobs/1` })
    assert.equal(without.isError, true)
    const elsewhere = await c.call("create_bound_browser_session", { target: "https://evil.example/", challenge: "a".repeat(43) })
    assert.equal(elsewhere.isError, true)
    const noScope = testClient(f.served, { token: await f.signIn.dev.token({ person: "ada", scopes: ["web.read", "web.write"] }) })
    assert.equal((await noScope.call("create_bound_browser_session", { target: `${ORIGIN}/jobs/1`, challenge: "a".repeat(43) })).status, 403)
    const { challenge } = await pkce()
    const url = ((await c.call("create_bound_browser_session", { target: `${ORIGIN}/jobs/1`, challenge })).structuredContent as { url: string }).url
    assert.ok(!url.includes("challenge") && !/eyJ/.test(url), "no token in the URL")
    const wrong = await f.served.fetch(new Request(url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ verifier: "wrong" }) }))
    assert.equal(wrong.status, 400)
    assert.equal(wrong.headers.get("set-cookie"), null)
    // A POST with no form at all is refused like a missing verifier (never a 500); an unknown code is gone.
    const bare = ((await c.call("create_bound_browser_session", { target: `${ORIGIN}/jobs/1`, challenge })).structuredContent as { url: string }).url
    const empty = await f.served.fetch(new Request(bare, { method: "POST" }))
    assert.equal(empty.status, 400)
    assert.equal(empty.headers.get("set-cookie"), null)
    assert.equal((await f.served.fetch(new Request(bare, { method: "POST" }))).status, 410)
    assert.equal((await f.served.fetch(new Request(`${ORIGIN}/session-transfer/${"a".repeat(43)}`, { method: "POST" }))).status, 410)
    // On a loopback host outside production the cookie is a secure context's: partitioned in a frame.
    const { verifier: v2, challenge: c2 } = await pkce()
    const framedUrl = ((await c.call("create_bound_browser_session", { target: `${ORIGIN}/jobs/1`, challenge: c2 })).structuredContent as { url: string }).url
    const framed = await f.served.fetch(new Request(framedUrl, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "sec-fetch-dest": "iframe" }, body: new URLSearchParams({ verifier: v2 }) }))
    assert.equal(framed.status, 303)
    assert.match(framed.headers.get("set-cookie") ?? "", /^__Host-[^;]+; Path=\/; HttpOnly; Max-Age=\d+; Secure; SameSite=None; Partitioned$/)
    const cookie = await transferBound(f.served, c, `${ORIGIN}/jobs/1`)
    const session = await f.served.session(new Request(`${ORIGIN}/jobs/1`, { headers: { cookie } }))
    assert.equal(session?.person.id, "ada")
    assert.ok(session?.transferred)
    const page = await f.served.fetch(new Request(`${ORIGIN}/jobs/1`, { headers: { cookie } }))
    assert.equal(page.status, 200)
    assert.match(await page.text(), /Signed in as Ada through/)
  })

  test("strong mode: a copied URL without its verifier is useless (no interstitial, no continue)", async () => {
    const f = fixture()
    const c = testClient(f.served, { token: await f.signIn.dev.token({ person: "ada" }) })
    const form = { origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" }
    const issue = async () => {
      const { verifier, challenge } = await pkce()
      const url = ((await c.call("create_bound_browser_session", { target: `${ORIGIN}/jobs/1`, challenge })).structuredContent as { url: string }).url
      return { url, verifier }
    }
    // A GET offers no way in and does not consume the code: the client's own redeem still works.
    const first = await issue()
    const get = await f.served.fetch(new Request(first.url))
    assert.equal(get.headers.get("set-cookie"), null)
    const html = await get.text()
    assert.doesNotMatch(html, /<form/, "no form on a bound code's page")
    assert.doesNotMatch(html, /name="nonce"/, "no nonce on a bound code's page")
    assert.doesNotMatch(html, /You are entering as Ada/)
    const redeem = await f.served.fetch(new Request(first.url, { method: "POST", headers: form, body: new URLSearchParams({ verifier: first.verifier }) }))
    assert.equal(redeem.status, 303, "the GET left the code valid")
    // The interstitial's POST, without a verifier, is refused, even with the row's real nonce, and burns the code.
    const second = await issue()
    const nonce = /name="nonce" value="([^"]+)"/.exec(await (await f.served.fetch(new Request(second.url))).text())?.[1] ?? "x".repeat(22)
    for (const decision of ["continue", "not-me"]) {
      const bypass = await f.served.fetch(new Request(second.url, { method: "POST", headers: form, body: new URLSearchParams({ decision, nonce }) }))
      assert.notEqual(bypass.status, 303)
      assert.ok(bypass.status >= 400, `refused (${decision})`)
      assert.equal(bypass.headers.get("set-cookie"), null)
    }
    const late = await f.served.fetch(new Request(second.url, { method: "POST", headers: form, body: new URLSearchParams({ verifier: second.verifier }) }))
    assert.equal(late.status, 410, "a failed attempt invalidated the code")
    // A wrong verifier burns the code too: no second guess.
    const third = await issue()
    const wrong = await f.served.fetch(new Request(third.url, { method: "POST", headers: form, body: new URLSearchParams({ verifier: "wrong" }) }))
    assert.equal(wrong.status, 400)
    const after = await f.served.fetch(new Request(third.url, { method: "POST", headers: form, body: new URLSearchParams({ verifier: third.verifier }) }))
    assert.equal(after.status, 410)
    // An empty verifier field is no verifier.
    const fourth = await issue()
    const empty = await f.served.fetch(new Request(fourth.url, { method: "POST", headers: form, body: new URLSearchParams({ verifier: "", decision: "continue", nonce }) }))
    assert.ok(empty.status >= 400)
    assert.equal(empty.headers.get("set-cookie"), null)
  })

  test("link mode: a verifier is no way around the interstitial", async () => {
    const f = fixture({ link: true })
    const c = testClient(f.served, { token: await f.signIn.dev.token({ person: "ada" }) })
    const url = ((await c.call("create_browser_session", { target: `${ORIGIN}/jobs/1` })).structuredContent as { url: string }).url
    const post = await f.served.fetch(new Request(url, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ verifier: "anything" }) }))
    assert.equal(post.status, 400)
    assert.equal(post.headers.get("set-cookie"), null)
  })

  test("a bare GET shows the interstitial and creates no session; never over another person's session", async () => {
    const f = fixture({ link: true })
    const c = testClient(f.served, { token: await f.signIn.dev.token({ person: "ada" }) })
    assert.ok((await c.listTools()).some((t) => t.name === "create_browser_session" && !t._meta?.ui))
    const url = ((await c.call("create_browser_session", { target: `${ORIGIN}/jobs/1` })).structuredContent as { url: string }).url
    const get = await f.served.fetch(new Request(url))
    assert.equal(get.status, 200)
    assert.equal(get.headers.get("set-cookie"), null)
    const html = await get.text()
    assert.match(html, /You are entering as Ada through/)
    const nonce = /name="nonce" value="([^"]+)"/.exec(html)![1]!
    const bob = await login(f.served, "bob")
    const over = await f.served.fetch(new Request(url, { method: "POST", headers: { cookie: bob, origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ decision: "continue", nonce }) }))
    assert.equal(over.status, 409)
    assert.equal(over.headers.get("set-cookie"), null)
    const ok = await f.served.fetch(new Request(url, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ decision: "continue", nonce }) }))
    assert.equal(ok.status, 303, "the code stayed valid after the refusal")
    const twice = await f.served.fetch(new Request(url, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ decision: "continue", nonce }) }))
    assert.equal(twice.status, 410)
    const cross = await f.served.fetch(new Request(url, { method: "POST", headers: { origin: "https://evil.example", "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ verifier: "x" }) }))
    assert.equal(cross.status, 403)
  })

  test("revoking the grant ends its transferred sessions", async () => {
    const f = fixture()
    const c = testClient(f.served, { token: await f.signIn.dev.token({ person: "ada" }) })
    const cookie = await transferBound(f.served, c, `${ORIGIN}/jobs/1`)
    await f.served.revoke("dev:ada:https://dev.clegra.invalid/client.json")
    assert.equal(await f.served.session(new Request(`${ORIGIN}/`, { headers: { cookie } })), null)
  })
})

describe("app-share, agents, events", () => {
  test("accepts and plugins are declared on the tool; the source of a share reaches the handler", async () => {
    const f = fixture()
    const c = testClient(f.served, { token: await f.signIn.dev.token({ person: "ada" }), language: "it" })
    const create = (await c.listTools()).find((t) => t.name === "job.create")!
    const share = create._meta?.["com.clegra/app-share"] as { accepts: { title: string }[]; plugins: unknown[] }
    assert.equal(share.accepts[0]!.title, "Nuovo lavoro")
    assert.equal(share.plugins.length, 1)
    assert.equal(create.inputSchema.additionalProperties, false)
    const r = await c.call("job.create", { title: "From a mail" }, { _meta: { "com.clegra/app-share": { source: { builtin: "mail" } } } })
    assert.deepEqual((r.structuredContent as { source: unknown }).source, { builtin: "mail" })
  })

  test("agents are skills with agent.json; the approval digest changes when a tool changes", async () => {
    const f = fixture()
    const c = testClient(f.served, { token: await f.signIn.dev.token({ person: "ada" }) })
    const skills = await c.listSkills()
    assert.equal(skills.length, 1)
    assert.equal(skills[0]!.frontmatter["allowed-tools"], "job.list job.get job.complete")
    assert.deepEqual(skills[0]!.resources.map((r) => r.uri), ["skill://triage/SKILL.md", "skill://triage/agent.json"])
    const json = await c.readJson<{ tier: string; schedules: unknown[] }>("skill://triage/agent.json")
    assert.equal(json.tier, "fast")
    const tools = (await c.listTools()).filter((t) => ["job.list", "job.get", "job.complete"].includes(t.name))
    const d1 = await agentDigest(skills[0]!.resources, tools)
    const d2 = await agentDigest(skills[0]!.resources, tools.map((t) => (t.name === "job.complete" ? { ...t, annotations: { ...t.annotations, readOnlyHint: true } } : t)))
    assert.notEqual(d1, d2)
  })

  test("notifications go by webhook to subscribers, signed, with generic titles", async () => {
    const f = fixture()
    const c = testClient(f.served, { token: await f.signIn.dev.token({ person: "ada" }), language: "it" })
    const list = await c.rpc("events/list")
    assert.ok((list.result?.events as { name: string }[]).some((e) => e.name === "com.clegra.app.notification"))
    const sub = await c.rpc("events/subscribe", { name: "com.clegra.app.notification", delivery: { mode: "webhook", url: "http://127.0.0.1:9/hook" } })
    assert.ok((sub.result as { subscriptionId: string }).subscriptionId)
    await c.call("job.ping")
    assert.equal(f.pings.length, 1)
    const event = f.pings[0] as { name: string; data: { title: string; url: string; type: string } }
    assert.equal(event.name, "com.clegra.app.notification")
    assert.deepEqual(event.data.title, "Nuovo lavoro")
    assert.equal(event.data.url, `${ORIGIN}/jobs/1`)
  })
})

describe("defineApp", () => {
  const e = defineEntity({ name: "x", title: "X", path: "/x/{id}", schema: z.object({ id: z.string(), t: z.string() }), card: { title: "t" }, get: () => null })
  test("a page variable the tool cannot fill is refused (MAP-2)", () => {
    const p = definePage({ name: "p", title: "P", path: "/x/{id}/{other}", role: "record", entity: e })
    const t = defineTool({ name: "x.get", title: "X", description: "X", input: z.object({ id: z.string() }), annotations: { readOnly: true }, entity: e, on: "record", page: p, run: () => ({}) })
    assert.throws(() => defineApp({ name: "xx", title: "X", description: "X", version: "1", entities: [e], tools: [t], pages: [p] }), /MAP-2/)
  })
  test("a share receiver needs a closed input (SHR-3)", () => {
    const t = defineTool({ name: "x.new", title: "X", description: "X", input: z.object({ t: z.string() }), annotations: { readOnly: false, destructive: false }, accepts: [{ type: "text", title: "X", map: { t: "text" } }], run: () => ({}) })
    assert.throws(() => defineApp({ name: "xx", title: "X", description: "X", version: "1", tools: [t] }), /SHR-3/)
  })
  test("a schedule more often than hourly is refused (AGT-8)", () => {
    const t = defineTool({ name: "x.list", title: "X", description: "X", input: z.object({}), annotations: { readOnly: true }, run: () => ({}) })
    const a = defineAgent({ name: "a", description: "A", instructions: "A", tools: [t], starters: ["go"], schedules: [{ name: "s", cron: "*/5 * * * *", starter: 0 }] })
    assert.throws(() => defineApp({ name: "xx", title: "X", description: "X", version: "1", tools: [t], agents: [a] }), /AGT-8/)
  })
  test("a read-only tool is never confirmed", () => {
    const t = defineTool({ name: "x.list", title: "X", description: "X", input: z.object({}), annotations: { readOnly: true }, confirm: { message: () => "?" }, run: () => ({}) })
    assert.throws(() => defineApp({ name: "xx", title: "X", description: "X", version: "1", tools: [t] }), /read-only/)
  })
})
