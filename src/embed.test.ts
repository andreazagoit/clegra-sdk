import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, describe, test } from "node:test"

import { decodeJwt, decodeProtectedHeader, SignJWT } from "jose"
import { z } from "zod"

import { checkApp } from "../spec/src/conformance"
import { defineApp, type App, type AuthOptions, type EmbedTicket } from "./index"
import { testClient } from "./testing"

/**
 * Embedded pages (spec §5.1): a host asks for a one-minute, single-use ticket for one page and one framing origin;
 * the frame posts it to /embed/_ticket and gets a partitioned session cookie for that page's path and a 303 to it.
 * Every threat the design names is a test here.
 */

const keyFile = join(tmpdir(), `modelapp-embed-key-${randomUUID()}.json`)
after(() => rmSync(keyFile, { force: true }))

const SECRET = "an-embed-secret-for-the-tests-only-0123456789"
const HOST = "https://host.example"
const APP = "http://127.0.0.1"

function makeApp(options: { secret?: string | null; frameAncestors?: string[] } = {}): App {
  return defineApp({
    name: "crm",
    title: "CRM",
    version: "1.0.0",
    auth: { dev: { keyFile, code: "EMBED1", people: [{ id: "ada", name: "Ada" }] } } as AuthOptions,
    permissions: { "deals.view": { label: "See deals", default: true }, "deals.values": { label: "See values" } },
    embed: { frameAncestors: options.frameAncestors ?? [HOST, "https://*.sandbox.example"], ...(options.secret === null ? {} : { secret: options.secret ?? SECRET }) },
    entities: { deal: { label: "Deal", schema: z.object({ id: z.string(), name: z.string().meta({ role: "title" }) }), get: () => null, list: () => ({ rows: [] }) } },
    pages: {
      board: { title: "Board", url: "/embed/board", permission: "deals.view" },
      values: { title: "Values", url: "/embed/values", permission: "deals.values" },
      site: { title: "Site", url: "https://example.com/app" },
    },
  })
}

async function ticketFor(app: App, page = "board", origin = HOST, who: Parameters<typeof testClient>[1] = { permissions: ["deals.view"], installation: "org-1", person: "ada" }): Promise<EmbedTicket> {
  const c = await testClient(app, who)
  const r = await c.call("modelapp_embed", { page, origin })
  assert.ok(!r.isError, JSON.stringify(r.structuredContent))
  return r.structuredContent as unknown as EmbedTicket
}

/** What a browser sends when the host's document posts the form into its frame. */
function post(app: App, ticket: string, init: { origin?: string | null; dest?: string | null; path?: string; extra?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" }
  if (init.origin !== null) headers.origin = init.origin ?? HOST
  if (init.dest !== null) headers["sec-fetch-dest"] = init.dest ?? "iframe"
  return app.embed!.exchange(new Request(`${APP}${init.path ?? "/embed/_ticket"}`, { method: "POST", headers, body: new URLSearchParams({ ticket, ...init.extra }) }))
}

const cookieOf = (r: Response) => r.headers.get("set-cookie") ?? ""
const valueOf = (setCookie: string) => /^[^=]+=([^;]+)/.exec(setCookie)?.[1] ?? ""
const pageRequest = (cookie: string, page = "board", dest = "iframe") => new Request(`${APP}/embed/${page}`, { headers: { cookie: `__Secure-modelapp-embed-${page}=${cookie}`, "sec-fetch-dest": dest } })

describe("embedded pages: the ticket", () => {
  test("the tool: app-only, hidden from models, in the manifest with the declared hosts", async () => {
    const app = makeApp()
    const tools = await (await testClient(app, { permissions: "all" })).listTools()
    const tool = tools.find((t) => t.name === "modelapp_embed")
    assert.ok(tool)
    assert.deepEqual((tool._meta as { ui: unknown }).ui, { visibility: ["app"] })
    assert.equal((tool._meta as Record<string, unknown>)["openai/visibility"], "private")
    assert.deepEqual(app.manifest().embed, { tool: { name: "modelapp_embed", plain: true }, path: "/embed", frameAncestors: [HOST, "https://*.sandbox.example"] })
  })

  test("a ticket: one minute, HS256, for one page, one origin, the caller as resolve named it", async () => {
    const app = makeApp()
    const t = await ticketFor(app)
    assert.equal(t.action, `${APP}/embed/_ticket`)
    assert.equal(t.field, "ticket")
    assert.deepEqual(decodeProtectedHeader(t.ticket), { alg: "HS256", typ: "modelapp-embed+jwt" })
    const claims = decodeJwt(t.ticket) as Record<string, unknown> & { exp: number; iat: number }
    assert.equal(claims.exp - claims.iat, 60)
    assert.equal(claims.aud, `${APP}/embed/board`)
    assert.equal(claims.iss, APP)
    assert.equal(claims.origin, HOST)
    assert.equal(typeof claims.jti, "string")
    const caller = claims.modelapp as { installation: string; person: { id: string }; permissions: string[] }
    assert.equal(caller.person.id, "ada")
    assert.match(caller.installation, /^org-1@/)
    assert.deepEqual(caller.permissions, ["deals.view"])
  })

  test("refused: a page the caller may not open, an unknown page, a page on another site", async () => {
    const app = makeApp()
    const c = await testClient(app, { permissions: ["deals.view"] })
    assert.equal(((await c.call("modelapp_embed", { page: "values", origin: HOST })).structuredContent as { error: { code: string } }).error.code, "permission_denied")
    assert.equal(((await c.call("modelapp_embed", { page: "nope", origin: HOST })).structuredContent as { error: { code: string } }).error.code, "not_found")
    assert.equal(((await c.call("modelapp_embed", { page: "site", origin: HOST })).structuredContent as { error: { code: string } }).error.code, "not_found")
  })

  test("refused: an origin the app does not declare, an opaque one, one that is not an origin", async () => {
    const app = makeApp()
    const c = await testClient(app, { permissions: ["deals.view"] })
    for (const origin of ["https://evil.example", "null", "https://host.example/path", "HTTPS://HOST.EXAMPLE", "https://sandbox.example"]) {
      const r = await c.call("modelapp_embed", { page: "board", origin })
      assert.equal(r.isError, true, origin)
      assert.match((r.structuredContent as { error: { code: string } }).error.code, /^(invalid_input|permission_denied)$/, origin)
    }
    // A declared wildcard: any subdomain of it.
    assert.ok(await ticketFor(app, "board", "https://a1.sandbox.example"))
  })

  test("without a secret: a clear misconfiguration, never an unsigned or guessed key", async () => {
    const before = process.env.MODELAPP_EMBED_SECRET
    delete process.env.MODELAPP_EMBED_SECRET
    try {
      const app = makeApp({ secret: null })
      const r = await (await testClient(app, { permissions: ["deals.view"] })).call("modelapp_embed", { page: "board", origin: HOST })
      assert.equal((r.structuredContent as { error: { code: string } }).error.code, "internal")
      const refused = await post(app, "x")
      assert.equal(refused.status, 500)
      assert.match(await refused.text(), /MODELAPP_EMBED_SECRET/)
      assert.throws(() => makeApp({ secret: "short" }) && undefined)
    } finally {
      if (before !== undefined) process.env.MODELAPP_EMBED_SECRET = before
    }
  })

  test("defineApp: a same-site url page needs embed, under its path; frame ancestors are origins", () => {
    const base = { name: "x1", title: "X", version: "1.0.0", auth: { dev: { keyFile } } as AuthOptions, entities: {} }
    assert.throws(() => defineApp({ ...base, pages: { b: { title: "B", url: "/embed/b" } } }), /needs `embed`/)
    assert.throws(() => defineApp({ ...base, embed: { frameAncestors: [HOST], secret: SECRET }, pages: { b: { title: "B", url: "/elsewhere/b" } } }), /under \/embed\//)
    assert.throws(() => defineApp({ ...base, embed: { frameAncestors: [HOST], secret: SECRET }, pages: { b: { title: "B", url: "/embed/_ticket" } } }), /under \/embed\//)
    assert.throws(() => defineApp({ ...base, embed: { frameAncestors: [HOST], secret: SECRET }, pages: { b: { title: "B", url: "/embed/b?x=1" } } }), /without query/)
    for (const bad of ["*", "https:", "https://host.example/", "http://host.example", "https://host.example 'unsafe-inline'", "data:"]) assert.throws(() => defineApp({ ...base, embed: { frameAncestors: [bad], secret: SECRET } }), /not an origin source/, bad)
    assert.throws(() => defineApp({ ...base, embed: { frameAncestors: [], secret: SECRET } }), /name the hosts/)
  })
})

describe("embedded pages: the exchange", () => {
  test("a valid ticket: 303 to the page, a partitioned, HttpOnly, path-scoped cookie; frame-ancestors; no-referrer", async () => {
    const app = makeApp()
    const r = await post(app, (await ticketFor(app)).ticket)
    assert.equal(r.status, 303)
    assert.equal(r.headers.get("location"), `${APP}/embed/board`)
    assert.equal(r.headers.get("referrer-policy"), "no-referrer")
    assert.equal(r.headers.get("cache-control"), "no-store")
    assert.equal(r.headers.get("content-security-policy"), `frame-ancestors ${HOST} https://*.sandbox.example`)
    assert.equal(r.headers.get("x-frame-options"), null)
    const cookie = cookieOf(r)
    assert.match(cookie, /^__Secure-modelapp-embed-board=/)
    for (const attribute of ["Path=/embed/board", "Max-Age=600", "Secure", "HttpOnly", "SameSite=None", "Partitioned"]) assert.ok(cookie.split("; ").includes(attribute), `${attribute} in ${cookie}`)
    const caller = await app.embed!.caller("board", pageRequest(valueOf(cookie)))
    assert.ok(caller)
    assert.equal(caller.person?.id, "ada")
    assert.match(caller.installation, /^org-1@/)
    assert.equal(caller.can("deals.view"), true)
    assert.equal(caller.can("deals.values"), false)
    assert.equal(caller.origin, HOST)
  })

  test("a replayed ticket is refused (single use)", async () => {
    const app = makeApp()
    const t = (await ticketFor(app)).ticket
    assert.equal((await post(app, t)).status, 303)
    const again = await post(app, t)
    assert.equal(again.status, 401)
    assert.match(await again.text(), /already used/)
    assert.equal(cookieOf(again), "")
  })

  test("an expired ticket is refused; one issued in the future beyond the skew too; a small skew is allowed", async (t) => {
    const app = makeApp()
    const ticket = (await ticketFor(app)).ticket
    const now = Date.now()
    t.mock.timers.enable({ apis: ["Date"], now: now + 66_000 })
    const late = await post(app, ticket)
    assert.equal(late.status, 401)
    assert.match(await late.text(), /expired/)
    t.mock.timers.reset()
    // A ticket the issuing instance stamped 4 s ahead of this one's clock: accepted; 20 s ahead: refused.
    for (const [ahead, status] of [[4, 303], [20, 401]] as const) {
      t.mock.timers.enable({ apis: ["Date"], now: now + ahead * 1000 })
      const future = (await ticketFor(app)).ticket
      t.mock.timers.reset()
      assert.equal((await post(app, future)).status, status, `${ahead} s ahead`)
    }
  })

  test("a ticket minted for origin A is refused in a frame of origin B (the browser's Origin), and without Origin", async () => {
    const app = makeApp({ frameAncestors: [HOST, "https://other.example"] })
    const t = (await ticketFor(app)).ticket
    const wrong = await post(app, t, { origin: "https://other.example" })
    assert.equal(wrong.status, 403)
    assert.match(await wrong.text(), /another frame/)
    assert.equal((await post(app, (await ticketFor(app)).ticket, { origin: null })).status, 403)
  })

  test("a top-level request (not a frame) is refused: the ticket opens a page inside a frame only", async () => {
    const app = makeApp()
    for (const dest of ["document", null]) assert.equal((await post(app, (await ticketFor(app)).ticket, { dest })).status, 403, String(dest))
  })

  test("a tampered ticket is refused: a changed claim, another signature, alg none, a ticket of another app", async () => {
    const app = makeApp()
    const t = (await ticketFor(app)).ticket
    const [h, p, sig] = t.split(".")
    const claims = JSON.parse(Buffer.from(p!, "base64url").toString())
    claims.modelapp.installation = "org-2@app"
    const changed = `${h}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.${sig}`
    assert.equal((await post(app, changed)).status, 401)
    const none = `${Buffer.from(JSON.stringify({ alg: "none", typ: "modelapp-embed+jwt" })).toString("base64url")}.${p}.`
    assert.equal((await post(app, none)).status, 401)
    const other = await new SignJWT(claims).setProtectedHeader({ alg: "HS256", typ: "modelapp-embed+jwt" }).sign(new TextEncoder().encode("another-secret-another-secret-0123456789"))
    assert.equal((await post(app, other)).status, 401)
    // Another app with another secret: its ticket is not ours.
    const theirs = (await ticketFor(makeApp({ secret: "a-different-secret-for-another-app-0123456789" }))).ticket
    assert.equal((await post(app, theirs)).status, 401)
  })

  test("a ticket for another page, another tenant's page cookie, a session cookie posted as a ticket: refused", async () => {
    const app = makeApp()
    // The board's session does not open the values page, and a ticket is not a session (nor the other way).
    const r = await post(app, (await ticketFor(app)).ticket)
    const session = valueOf(cookieOf(r))
    assert.equal(await app.embed!.caller("values", pageRequest(session, "values")), null)
    assert.equal((await post(app, session)).status, 401)
    const ticket = (await ticketFor(app)).ticket
    assert.equal(await app.embed!.caller("board", pageRequest(ticket)), null)
    // A tenant can't be swapped inside a session either.
    const [h, p, s] = session.split(".")
    const claims = JSON.parse(Buffer.from(p!, "base64url").toString())
    claims.modelapp.installation = "org-2@app"
    assert.equal(await app.embed!.caller("board", pageRequest(`${h}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.${s}`)), null)
  })

  test("no open redirect: the 303 goes to the ticket's page, whatever the request adds", async () => {
    const app = makeApp()
    const r = await post(app, (await ticketFor(app)).ticket, { path: "/embed/_ticket?next=https://evil.example&redirect=//evil.example", extra: { next: "https://evil.example", location: "//evil.example" } })
    assert.equal(r.status, 303)
    assert.equal(r.headers.get("location"), `${APP}/embed/board`)
  })

  test("the session: not for top-level visits, gone after it expires, absent without a cookie", async (t) => {
    const app = makeApp()
    const session = valueOf(cookieOf(await post(app, (await ticketFor(app)).ticket)))
    assert.ok(await app.embed!.caller("board", pageRequest(session, "board", "empty")))
    assert.equal(await app.embed!.caller("board", pageRequest(session, "board", "document")), null)
    assert.equal(await app.embed!.caller("board", new Request(`${APP}/embed/board`)), null)
    t.mock.timers.enable({ apis: ["Date"], now: Date.now() + 606_000 })
    assert.equal(await app.embed!.caller("board", pageRequest(session)), null)
  })

  test("only POST: a GET of the exchange is refused with the declared frame-ancestors", async () => {
    const app = makeApp()
    const r = await app.embed!.exchange(new Request(`${APP}/embed/_ticket?ticket=x`, { headers: { "sec-fetch-dest": "iframe" } }))
    assert.equal(r.status, 405)
    assert.equal(r.headers.get("content-security-policy"), `frame-ancestors ${HOST} https://*.sandbox.example`)
  })
})

describe("embedded pages: the url-page view", () => {
  test("a same-site page's view asks for a ticket over the bridge and posts it; a page on another site is framed as it is", async () => {
    const app = makeApp()
    const c = await testClient(app, { permissions: "all" })
    const [own] = await c.readResource("ui://crm/pages/board")
    assert.match(own!.text!, /"embed":\{"tool":"modelapp_embed","page":"board"\}/)
    assert.match(own!.text!, /form\.method = "post"/)
    assert.deepEqual((own!._meta as { ui: { csp: unknown } }).ui.csp, { frameDomains: [APP] })
    const [site] = await c.readResource("ui://crm/pages/site")
    assert.match(site!.text!, /"embed":null/)
  })
})

describe("embedded pages: conformance", () => {
  test("embed.ticket and embed.frame-ancestors pass for a conformant app", async () => {
    const app = makeApp()
    const local = { remoteAddress: "127.0.0.1" }
    // The page itself, as a framework in front of it serves it: the declared frame-ancestors, the caller from its cookie.
    const fetch = async (request: Request) => {
      const { pathname } = new URL(request.url)
      if (pathname === app.embed!.exchangePath) return app.embed!.exchange(request)
      if (pathname.startsWith("/embed/")) {
        const caller = await app.embed!.caller(pathname.slice("/embed/".length), request)
        return new Response(caller ? "signed in" : "signed out", { headers: app.embed!.headers() })
      }
      return app.fetch(request, local)
    }
    const report = await checkApp({ url: APP, token: await app.devToken({ permissions: "all" }), fetch })
    const embed = report.checks.filter((c) => c.id.startsWith("embed."))
    assert.deepEqual(embed.map((c) => [c.id, c.ok, c.detail ?? ""]), [
      ["embed.frame-ancestors", true, ""],
      ["embed.ticket", true, ""],
    ])
  })
})
