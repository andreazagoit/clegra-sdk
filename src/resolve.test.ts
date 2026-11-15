import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, describe, test } from "node:test"
import { z } from "zod"

import { checkApp, formatReport } from "@modelapp/spec"

import { AuthError, defineApp, generateSigningKey, signAccessToken, type AuthOptions, type ResolvedCaller } from "./index"
import { testClient } from "./testing"

// auth.resolve (spec §7, «The app's own tokens»): the app verifies its own access tokens and says who is calling.

const keyFile = join(tmpdir(), `modelapp-resolve-key-${randomUUID()}.json`)
after(() => rmSync(keyFile, { force: true }))

const RES = "https://notes.test/mcp"
type Row = { id: string; title: string; secret: string; org: string }
const rows: Row[] = [
  { id: "a1", title: "Alpha", secret: "s-a", org: "org-a" },
  { id: "b1", title: "Beta", secret: "s-b", org: "org-b" },
]

// The app's own token store: opaque strings → who they are, and the audience each was issued for.
const tokens: Record<string, { caller: ResolvedCaller; aud: string }> = {
  "tok-admin-a": { caller: { installation: "org-a", person: { id: "u1", name: "Ada" }, permissions: "all" }, aud: RES },
  "tok-member-b": { caller: { installation: "org-b", person: { id: "u2", name: "Bea" }, permissions: ["notes.view"] }, aud: RES },
  "tok-other-app": { caller: { installation: "org-a", person: { id: "u1", name: "Ada" }, permissions: "all" }, aud: "https://other.test/mcp" },
  "tok-bad-tenant": { caller: { installation: "org-a@https://evil", person: null, permissions: "all" }, aud: RES },
  "tok-made-up-permission": { caller: { installation: "org-a", person: { id: "u3", name: "Cy" }, permissions: ["notes.view", "admin.everything"] }, aud: RES },
}
const seen: { resource: string; url: string }[] = []

function makeApp(auth: Partial<AuthOptions> = {}, path?: string) {
  return defineApp({
    name: "notes",
    title: "Notes",
    version: "1.0.0",
    ...(path ? { path } : {}),
    auth: {
      resource: RES,
      authorizationServers: ["https://notes.test/api/auth"],
      resolve: (token, request, { resource }) => {
        seen.push({ resource, url: request.url })
        if (token === "tok-throws") throw new AuthError("expired")
        const t = tokens[token]
        if (!t) return null
        if (t.aud !== resource) throw new AuthError("the token is for another server")
        return t.caller
      },
      ...auth,
    },
    permissions: { "notes.view": { label: "See notes", default: true }, "notes.secret": { label: "See secrets" } },
    entities: {
      note: {
        label: "Note",
        permission: "notes.view",
        schema: z.object({ id: z.string(), title: z.string().meta({ role: "title", search: true }), secret: z.string().meta({ permission: "notes.secret", search: true }) }),
        // The tenant comes from ctx (the verified caller), never from a parameter.
        get: (id, ctx) => rows.find((r) => r.id === id && r.org === ctx.installation) ?? null,
        list: (q, ctx) => ({ rows: rows.filter((r) => r.org === ctx.installation && (!q.text || (q.textFields ?? []).some((f) => String(r[f as keyof Row]).toLowerCase().includes(q.text!.toLowerCase())))) }),
      },
    },
    pages: { board: { title: "Board", url: "/embed/board" } },
  })
}

const listOf = async (c: Awaited<ReturnType<typeof testClient>>, args: Record<string, unknown> = {}) => ((await c.call("note_list", args)).structuredContent as { rows: Record<string, unknown>[] }).rows

describe("auth.resolve: the app's own tokens", () => {
  test("a resolved caller sees its own tenant only, with the fields its permissions allow", async () => {
    const app = makeApp()
    const a = await testClient(app, { token: "tok-admin-a" })
    assert.equal(a.status, 200)
    assert.deepEqual(await listOf(a), [{ id: "a1", title: "Alpha", secret: "s-a" }])
    const b = await testClient(app, { token: "tok-member-b" })
    assert.deepEqual(await listOf(b), [{ id: "b1", title: "Beta" }], "secret stripped server-side")
    // Text search never answers from a field the caller may not see.
    assert.deepEqual(await listOf(b, { query: "s-b" }), [])
    // A record of another tenant is simply not there.
    assert.equal((await b.call("note_get", { id: "a1" })).isError, true)
    assert.ok(seen.every((s) => s.resource === RES))
  })

  test("unknown, thrown, other-audience and bad-tenant tokens get a 401 with the resource metadata", async () => {
    const app = makeApp()
    for (const token of ["nope", "tok-throws", "tok-other-app", "tok-bad-tenant"]) {
      const r = await app.fetch(new Request("https://notes.test/mcp", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) }))
      assert.equal(r.status, 401, token)
      assert.match(r.headers.get("www-authenticate") ?? "", /resource_metadata="https:\/\/notes\.test\/\.well-known\/oauth-protected-resource\/mcp"/)
    }
  })

  test("permissions the app doesn't declare are dropped; the caller is a plain host", async () => {
    const app = makeApp()
    const c = await testClient(app, { token: "tok-made-up-permission" })
    assert.deepEqual(await listOf(c), [{ id: "a1", title: "Alpha" }])
  })

  test("a workspace host's token still goes to the issuer check, never to resolve", async () => {
    const key = await generateSigningKey()
    const iss = "https://node.test"
    const app = makeApp({ issuers: [{ issuer: iss, jwks: { keys: [key.publicJwk] } }] })
    const before = seen.length
    const token = await signAccessToken(key, { iss, aud: RES, sub: "p1", modelapp: { installation: "org-a", permissions: ["notes.view"] } })
    const c = await testClient(app, { token })
    // The host's tenant is bound to its issuer: org-a@https://node.test is not the app's org-a.
    assert.deepEqual(await listOf(c), [])
    assert.equal(seen.length, before, "resolve was not asked")
  })

  test("protected-resource metadata names the app's own authorization server", async () => {
    const r = await makeApp().fetch(new Request("https://notes.test/.well-known/oauth-protected-resource/mcp"))
    assert.deepEqual(((await r.json()) as { authorization_servers: string[] }).authorization_servers, ["https://notes.test/api/auth"])
  })

  test("auth.serve answers the authorization server's own well-known paths", async () => {
    const app = makeApp({ serve: (req) => (new URL(req.url).pathname === "/.well-known/oauth-authorization-server/api/auth" ? Response.json({ issuer: "https://notes.test/api/auth" }) : null) })
    const r = await app.fetch(new Request("https://notes.test/.well-known/oauth-authorization-server/api/auth"))
    assert.equal(r.status, 200)
    assert.equal(((await r.json()) as { issuer: string }).issuer, "https://notes.test/api/auth")
    assert.equal((await app.fetch(new Request("https://notes.test/somewhere"))).status, 404)
  })

  test("in production a resolver without auth.resource is a clear error, not a guess", async () => {
    const app = makeApp({ resource: undefined } as Partial<AuthOptions>)
    const prev = process.env.NODE_ENV
    process.env.NODE_ENV = "production"
    try {
      const r = await app.fetch(new Request("https://notes.test/mcp", { method: "POST" }))
      assert.equal(r.status, 500)
      assert.match(((await r.json()) as { error_description: string }).error_description, /auth\.resource is required/)
    } finally {
      process.env.NODE_ENV = prev
    }
  })
})

describe("path prefix and same-site pages", () => {
  test("with path, MCP lives under it; the manifest and metadata stay at the root", async () => {
    const app = makeApp({ resource: "https://notes.test/api/map/mcp" }, "/api/map")
    assert.equal(app.manifest().mcp.url, "/api/map/mcp")
    assert.equal((await app.fetch(new Request("https://notes.test/.well-known/modelapp.json"))).status, 200)
    // Mounted under the prefix without rewrites: the well-known paths answer there too.
    assert.equal((await app.fetch(new Request("https://notes.test/api/map/.well-known/modelapp.json"))).status, 200)
    const meta = await app.fetch(new Request("https://notes.test/.well-known/oauth-protected-resource/api/map/mcp"))
    assert.equal(((await meta.json()) as { resource: string }).resource, "https://notes.test/api/map/mcp")
    assert.equal((await app.fetch(new Request("https://notes.test/api/map/health"))).status, 200)
    assert.equal((await app.fetch(new Request("https://notes.test/mcp", { method: "POST" }))).status, 404)
    const r = await app.fetch(new Request("https://notes.test/api/map/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }))
    assert.equal(r.status, 401)
    assert.match(r.headers.get("www-authenticate") ?? "", /oauth-protected-resource\/api\/map\/mcp/)
  })

  test("a bad path is refused at definition", () => {
    assert.throws(() => makeApp({}, "api/map"), /a URL path/)
  })

  test("a relative url page stays relative in the manifest and is framed at the app's own origin", async () => {
    const app = makeApp()
    const page = app.manifest().pages.find((p) => p.name === "board") as { url?: string }
    assert.equal(page.url, "/embed/board")
    const c = await testClient(app, { token: "tok-admin-a" })
    const [view] = await c.readResource("ui://notes/pages/board")
    assert.ok(view?.text?.includes('src="http://127.0.0.1/embed/board"'), view?.text)
    assert.deepEqual((view?._meta?.ui as { csp: { frameDomains: string[] } }).csp.frameDomains, ["http://127.0.0.1"])
  })

  test("a protocol-relative or javascript: url is refused", () => {
    for (const url of ["//evil.test/x", "javascript:alert(1)"]) assert.throws(() => defineApp({ name: "x1", title: "X", version: "1", entities: {}, pages: { p: { title: "P", url } } }), /url must be/)
  })
})

describe("conformance with a resolver", () => {
  test("the app passes the checks with one of its own tokens", async () => {
    const app = makeApp()
    const report = await checkApp({ url: "https://notes.test", token: "tok-admin-a", fetch: (r) => app.fetch(r) })
    assert.ok(report.ok && report.complete, formatReport(report))
  })
})

void keyFile
