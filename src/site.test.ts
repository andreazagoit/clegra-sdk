import { createHash, randomBytes } from "node:crypto"
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { z } from "zod"

import { defineApp, MemoryStore } from "./index"
import { isSitePath, SITE_BRIDGE_SCRIPT, type SiteTicket } from "./site"
import { testCore } from "./testing"

// The app's own site (spec §5.1): a Clegra client asks the app for a one-minute, single-use site ticket with the
// person's app token and posts it into its frame; the app answers with partitioned cookies for the whole site and a
// 303 to the path; every page then reads the caller from the session and is framable by that client only.

const RES = "https://invoices.test/mcp"
const APP = "https://invoices.test"
const CLIENT = "https://app.clegra.test"
const OTHER = "https://other.test"
const SECRET = randomBytes(32).toString("base64url")
const core = await testCore({ resource: RES, issuer: "https://core.test" })
const who = { company: "co-1", sub: "ada" }

function makeApp(options: { start?: string; sessionSeconds?: number } = {}) {
  return defineApp({
    name: "invoices",
    title: "Invoices",
    version: "1.0.0",
    store: new MemoryStore(),
    auth: { resource: RES, clegra: core.options({ clientOrigins: [CLIENT, "app://client"] }) },
    permissions: { "invoices.view": { label: "See invoices", default: true }, "invoices.issue": { label: "Issue invoices" } },
    entities: { invoice: { label: "Invoice", permission: "invoices.view", schema: z.object({ id: z.string(), name: z.string().meta({ role: "title" }) }), get: () => null, list: () => ({ rows: [] }) } },
    site: { secret: SECRET, ...options },
  })
}
type App = ReturnType<typeof makeApp>

async function ticketFor(app: App, args: Record<string, unknown> = {}, person = who) {
  const c = await core.client(app, person)
  return c.call("clegra_site", { origin: CLIENT, ...args })
}

/** What a browser sends when the client's document posts the form into its frame. */
const post = (app: App, t: SiteTicket, init: { origin?: string | null; dest?: string | null; method?: string } = {}) => {
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" }
  if (init.origin !== null) headers.origin = init.origin ?? CLIENT
  if (init.dest !== null) headers["sec-fetch-dest"] = init.dest ?? "iframe"
  const method = init.method ?? "POST"
  return app.fetch(new Request(t.action, { method, headers, ...(method === "POST" ? { body: new URLSearchParams({ [t.field]: t.ticket }) } : {}) }))
}

const cookiesOf = (r: Response) => r.headers.getSetCookie()
/** The `Cookie` header a browser sends back in the same partition. */
const jar = (r: Response) => cookiesOf(r).map((c) => c.split(";")[0]).join("; ")

async function signedIn(app: App, args: Record<string, unknown> = {}) {
  const t = (await ticketFor(app, args)).structuredContent as unknown as SiteTicket
  const r = await post(app, t)
  assert.equal(r.status, 303, await r.clone().text())
  return { ticket: t, response: r, cookie: jar(r) }
}

const page = (cookie: string, dest = "iframe", path = "/invoices") => new Request(`${APP}${path}`, { headers: { cookie, "sec-fetch-dest": dest } })

describe("the app's own site", () => {
  test("declared in the manifest; the ticket tool is app-only, for a person's own app token", async () => {
    const app = makeApp()
    assert.deepEqual(app.manifest().site, { start: "/", tool: { name: "clegra_site", plain: false } })
    const c = await core.client(app, who)
    const tool = (await c.listTools()).find((t) => t.name === "clegra_site")
    assert.ok(tool)
    assert.deepEqual((tool._meta as { ui: unknown }).ui, { visibility: ["app"] })
    const agent = await core.client(app, { ...who, act: "device-agent:abc" })
    assert.ok(!(await agent.listTools()).some((t) => t.name === "clegra_site"), "an agent never opens a site")
  })

  test("a site needs auth.clegra, a site path to start at, and a strong secret", () => {
    assert.throws(() => defineApp({ name: "x1", title: "X", version: "1", entities: {}, site: { secret: SECRET } }), /needs auth\.clegra/)
    assert.throws(() => makeApp({ start: "//elsewhere.test" }), /site\.start/)
    assert.throws(() => makeApp({ sessionSeconds: 30 }), /sessionSeconds/)
  })

  test("site paths: on the app's own origin, never under /clegra/", () => {
    for (const p of ["/", "/invoices", "/invoices?status=open#top", "/a/b-c_d.e~f"]) assert.ok(isSitePath(p), p)
    for (const p of ["", "invoices", "//evil.test/", "/\\evil", "/a b", "/clegra/site", "/clegra/views/x", `/${"a".repeat(2048)}`, "/a\u0000"]) assert.ok(!isSitePath(p), p)
  })

  test("a ticket for one path and one client origin: a minute, never in the address", async () => {
    const app = makeApp({ start: "/home" })
    const r = await ticketFor(app, { path: "/invoices?status=open" })
    assert.ok(!r.isError, JSON.stringify(r.structuredContent))
    const t = r.structuredContent as unknown as SiteTicket
    assert.equal(t.action, `${APP}/clegra/site`)
    assert.equal(t.field, "ticket")
    assert.equal(t.path, "/invoices?status=open")
    assert.equal(t.sessionSeconds, 600)
    assert.ok(!t.action.includes(t.ticket))
    assert.ok(Date.parse(t.expiresAt) - Date.now() <= 60_000)
    const header = JSON.parse(Buffer.from(t.ticket.split(".")[0]!, "base64url").toString()) as { typ: string }
    assert.equal(header.typ, "clegra-site+jwt")
    assert.equal(((await ticketFor(app)).structuredContent as unknown as SiteTicket).path, "/home", "default: the start")
  })

  test("no ticket for another origin or a path off the site", async () => {
    const app = makeApp()
    for (const args of [{ origin: OTHER }, { origin: "null" }, { path: "//evil.test/" }, { path: "/clegra/site/renewed" }, { path: "https://evil.test/" }]) {
      const r = await ticketFor(app, args)
      assert.equal(r.isError, true, JSON.stringify(args))
    }
  })

  test("the desktop app's origin (app://client, a standard scheme of its own) gets a ticket and a session", async () => {
    const app = makeApp()
    const t = (await ticketFor(app, { origin: "app://client" })).structuredContent as unknown as SiteTicket
    assert.ok(t.ticket, JSON.stringify(t))
    const r = await post(app, t, { origin: "app://client" })
    assert.equal(r.status, 303, await r.clone().text())
    assert.equal(r.headers.get("content-security-policy"), "frame-ancestors 'self' app://client")
    const again = (await ticketFor(app, { origin: "app://client" })).structuredContent as unknown as SiteTicket
    assert.equal((await post(app, again, { origin: CLIENT })).status, 403, "the ticket is for the desktop's frame only")
  })

  test("the exchange: a 303 to the path with the session and the marker, partitioned, for the whole site", async () => {
    const app = makeApp()
    const { response } = await signedIn(app, { path: "/invoices?status=open" })
    assert.equal(response.headers.get("location"), `${APP}/invoices?status=open`)
    assert.equal(response.headers.get("referrer-policy"), "no-referrer")
    assert.equal(response.headers.get("cache-control"), "no-store")
    const cookies = cookiesOf(response)
    assert.equal(cookies.length, 2)
    const [session, marker] = cookies
    assert.match(session!, /^__Secure-clegra-site=[^;]+; Path=\/; Max-Age=600; Secure; HttpOnly; SameSite=None; Partitioned$/)
    assert.match(marker!, /^__Secure-clegra-site-origin=https%3A%2F%2Fapp\.clegra\.test; Path=\/; Max-Age=43200; Secure; HttpOnly; SameSite=None; Partitioned$/)
  })

  test("the exchange refuses a GET, a top-level page, another Origin, no Origin, and a ticket used twice", async () => {
    const app = makeApp()
    const t = (await ticketFor(app)).structuredContent as unknown as SiteTicket
    for (const init of [{ method: "GET" }, { dest: "document" }, { dest: null }, { origin: OTHER }, { origin: null }]) {
      const r = await post(app, t, init)
      assert.ok(r.status >= 400, `${JSON.stringify(init)}: ${r.status}`)
      assert.equal(cookiesOf(r).length, 0)
      assert.equal(r.headers.get("content-security-policy"), "frame-ancestors 'none'")
    }
    assert.equal((await post(app, t)).status, 303, "still unused after the refusals")
    const again = await post(app, t)
    assert.equal(again.status, 401)
    assert.match(await again.text(), /already used/)
  })

  test("a tampered ticket, or one of another app's secret, is refused", async () => {
    const app = makeApp()
    const t = (await ticketFor(app)).structuredContent as unknown as SiteTicket
    const [h, p, s] = t.ticket.split(".")
    const body = JSON.parse(Buffer.from(p!, "base64url").toString()) as { path: string }
    body.path = "/elsewhere"
    const forged = `${h}.${Buffer.from(JSON.stringify(body)).toString("base64url")}.${s}`
    assert.equal((await post(app, { ...t, ticket: forged })).status, 401)
    const other = defineApp({ name: "invoices", title: "I", version: "1", store: new MemoryStore(), auth: { resource: RES, clegra: core.options({ clientOrigins: [CLIENT] }) }, entities: {}, site: { secret: `${SECRET}-other` } })
    assert.equal((await other.fetch(new Request(t.action, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: CLIENT, "sec-fetch-dest": "iframe" }, body: new URLSearchParams({ ticket: t.ticket }) }))).status, 401)
  })

  test("the caller of a page: tenant, person, permissions, theme and locale; never for a top-level visit", async () => {
    const app = makeApp()
    const { cookie } = await signedIn(app, { theme: "dark", locale: "it" })
    const caller = await app.site!.caller(page(cookie))
    assert.ok(caller)
    assert.equal(caller.installation, "co-1@https://core.test")
    assert.equal(caller.person?.id, "ada")
    assert.equal(caller.origin, CLIENT)
    assert.equal(caller.theme, "dark")
    assert.equal(caller.locale, "it")
    assert.ok(caller.can("invoices.view"))
    assert.ok(!caller.can("invoices.issue"))
    assert.ok(caller.expiresAt.getTime() - Date.now() <= 600_000)
    assert.equal(await app.site!.caller(page(cookie, "document")), null)
    assert.equal(await app.site!.caller(page("")), null)
    assert.equal(await app.site!.caller(page(cookie.replace(/site=([^.]+)\.([^.]+)\./, "site=$1.x$2."))), null, "a tampered session")
  })

  test("a person removed from the company loses the site at once", async () => {
    const app = makeApp()
    const { cookie } = await signedIn(app)
    assert.ok(await app.site!.caller(page(cookie)))
    assert.equal((await core.deliver(app, await core.event("member.removed", { company: "co-1", sub: "ada" }))).status, 204)
    assert.equal(await app.site!.caller(page(cookie)), null)
    // Its frame gets the signed-out page, never the app's own sign-in.
    const { response } = await app.site!.guard(page(cookie))
    assert.equal(response?.status, 401)
  })

  test("framing: a session's pages are framable by its client only; a Clegra partition without one gets the signed-out page", async () => {
    const app = makeApp()
    const { cookie } = await signedIn(app)
    const inSession = await app.site!.guard(page(cookie))
    assert.deepEqual(inSession, { headers: { "content-security-policy": `frame-ancestors 'self' ${CLIENT}` }, response: null })
    // The session ended, the marker stayed: the client is told.
    const markerOnly = cookie.split("; ").filter((c) => c.startsWith("__Secure-clegra-site-origin=")).join("; ")
    const out = await app.site!.guard(page(markerOnly))
    assert.equal(out.headers, null)
    assert.ok(out.response)
    assert.equal(out.response.status, 401)
    const csp = out.response.headers.get("content-security-policy") ?? ""
    assert.match(csp, new RegExp(`frame-ancestors 'self' ${CLIENT}$`))
    const html = await out.response.text()
    const script = /<script>(.*)<\/script>/.exec(html)![1]!
    assert.equal(script, `parent.postMessage({type:"clegra/signed-out"},"${CLIENT}")`)
    assert.ok(csp.includes(`'sha256-${createHash("sha256").update(script).digest("base64")}'`))
    // Anything else is the app's own: a top-level visit, a frame outside any Clegra partition.
    assert.deepEqual(await app.site!.guard(page(cookie, "document")), { headers: null, response: null })
    assert.deepEqual(await app.site!.guard(page("")), { headers: null, response: null })
    // A marker for an origin that is no longer a client's counts for nothing.
    assert.deepEqual(await app.site!.guard(page(`__Secure-clegra-site-origin=${encodeURIComponent(OTHER)}`)), { headers: null, response: null })
  })

  test("the bridge's endpoints: the script, its session, its context, the renewal page", async () => {
    const app = makeApp()
    const { cookie } = await signedIn(app, { theme: "light", locale: "en" })
    const script = await app.fetch(new Request(`${APP}/clegra/site/bridge.js`))
    assert.equal(script.status, 200)
    assert.match(script.headers.get("content-type") ?? "", /text\/javascript/)
    assert.equal(await script.text(), SITE_BRIDGE_SCRIPT)

    const none = await app.fetch(new Request(`${APP}/clegra/site/session`))
    assert.equal(none.status, 204)
    const info = await app.fetch(new Request(`${APP}/clegra/site/session`, { headers: { cookie } }))
    assert.equal(info.status, 200)
    const body = (await info.json()) as { origin: string; expiresAt: string; theme: string; locale: string }
    assert.equal(body.origin, CLIENT)
    assert.equal(body.theme, "light")
    assert.equal(body.locale, "en")
    assert.ok(!("permissions" in body), "the bridge learns nothing it doesn't need")

    const context = (init: { origin?: string; body?: unknown }) =>
      app.fetch(new Request(`${APP}/clegra/site/context`, { method: "POST", headers: { cookie, origin: init.origin ?? APP, "content-type": "application/json" }, body: JSON.stringify(init.body ?? { theme: "dark", locale: "it" }) }))
    assert.equal((await context({ origin: CLIENT })).status, 403, "only the site itself")
    assert.equal((await context({ body: { theme: "purple" } })).status, 400)
    const kept = await context({})
    assert.equal(kept.status, 204)
    const renewed = jar(kept)
    const after = await app.site!.caller(page(renewed))
    assert.equal(after?.theme, "dark")
    assert.equal(after?.locale, "it")
    const before = await app.site!.caller(page(cookie))
    assert.equal(after?.expiresAt.getTime(), before?.expiresAt.getTime(), "the same end")

    const landing = await app.fetch(new Request(`${APP}/clegra/site/renewed`, { headers: { cookie, "sec-fetch-dest": "iframe" } }))
    assert.equal(landing.status, 200)
    assert.match(await landing.text(), new RegExp(`parent\\.postMessage\\(\\{type:"clegra/renewed",expiresAt:"[^"]+"\\},"${CLIENT}"\\)`))
  })

  test("a renewal ticket lands on the renewal page with a new session", async () => {
    const app = makeApp()
    const t = (await ticketFor(app, { renew: true, path: "/ignored" })).structuredContent as unknown as SiteTicket
    assert.equal(t.path, "/clegra/site/renewed")
    const r = await post(app, t)
    assert.equal(r.status, 303)
    assert.equal(r.headers.get("location"), `${APP}/clegra/site/renewed`)
    assert.ok(await app.site!.caller(page(jar(r))))
  })

  test("without a secret the tool says misconfigured, and nothing is issued", async () => {
    const before = process.env.CLEGRA_SITE_SECRET
    delete process.env.CLEGRA_SITE_SECRET
    try {
      const app = defineApp({ name: "invoices", title: "I", version: "1", store: new MemoryStore(), auth: { resource: RES, clegra: core.options({ clientOrigins: [CLIENT] }) }, entities: {}, site: {} })
      const c = await core.client(app, who)
      const r = await c.call("clegra_site", { origin: CLIENT })
      assert.equal(r.isError, true)
      assert.match(JSON.stringify(r.structuredContent), /misconfigured/)
    } finally {
      if (before !== undefined) process.env.CLEGRA_SITE_SECRET = before
    }
  })
})
