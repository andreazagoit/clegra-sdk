import assert from "node:assert/strict"
import { afterEach, describe, test } from "node:test"
import { z } from "zod"

import { defineApp, defineEntity, serve, type ServedApp } from "../index"
import type { NextConfig } from "next"

import { clegraRewrites, recordProxy, toNextHandlers, withClegra } from "./index"

// A stand-in app that records what reaches app.fetch.
function recorder(respond?: (request: Request) => Response | Promise<Response>) {
  const seen: { url: string; headers: Headers; method: string; body: string | null }[] = []
  const app = {
    fetch: async (request: Request) => {
      seen.push({ url: request.url, headers: request.headers, method: request.method, body: request.body ? await request.clone().text() : null })
      return respond ? respond(request) : Response.json({ ok: true })
    },
  } as unknown as ServedApp
  return { app, seen }
}

const savedEnv = process.env.CLEGRA_PUBLIC_URL
afterEach(() => {
  if (savedEnv === undefined) delete process.env.CLEGRA_PUBLIC_URL
  else process.env.CLEGRA_PUBLIC_URL = savedEnv
})

describe("toNextHandlers: the public address", () => {
  test("the mount is taken off; a rewritten request (Next shows the source path) is kept as it is", async () => {
    delete process.env.CLEGRA_PUBLIC_URL
    const { app, seen } = recorder()
    const { GET, POST } = toNextHandlers(app)
    await POST(new Request("http://localhost:3000/api/clegra/mcp", { method: "POST", body: "{}" }))
    await GET(new Request("http://localhost:3000/api/clegra/.well-known/oauth-protected-resource/mcp?x=1"))
    await GET(new Request("http://localhost:3000/api/clegra"))
    await POST(new Request("http://localhost:3000/mcp", { method: "POST", body: "{}" }))
    await GET(new Request("http://localhost:3000/notes/7", { headers: { authorization: "Bearer t" } }))
    assert.deepEqual(
      seen.map((s) => s.url),
      ["http://localhost:3000/mcp", "http://localhost:3000/.well-known/oauth-protected-resource/mcp?x=1", "http://localhost:3000/", "http://localhost:3000/mcp", "http://localhost:3000/notes/7"],
    )
  })

  test("a custom mount", async () => {
    delete process.env.CLEGRA_PUBLIC_URL
    const { app, seen } = recorder()
    await toNextHandlers(app, { mount: "/api/map/" }).GET(new Request("http://localhost/api/map/health"))
    assert.equal(seen[0]?.url, "http://localhost/health")
  })

  test("publicUrl replaces the origin and the forwarded headers", async () => {
    const { app, seen } = recorder()
    const { POST } = toNextHandlers(app, { publicUrl: "https://crm.example.test" })
    await POST(new Request("http://10.0.0.5:3000/api/clegra/mcp", { method: "POST", body: "{}", headers: { "x-forwarded-host": "evil.example", "x-forwarded-proto": "http" } }))
    assert.equal(seen[0]?.url, "https://crm.example.test/mcp")
    assert.equal(seen[0]?.headers.get("x-forwarded-host"), "crm.example.test")
    assert.equal(seen[0]?.headers.get("x-forwarded-proto"), "https")
    assert.equal(seen[0]?.headers.get("host"), "crm.example.test")
  })

  test("CLEGRA_PUBLIC_URL is the default publicUrl; the option wins over it", async () => {
    process.env.CLEGRA_PUBLIC_URL = "https://from-env.example.test"
    const a = recorder()
    await toNextHandlers(a.app).GET(new Request("http://localhost/api/clegra/health"))
    assert.equal(a.seen[0]?.url, "https://from-env.example.test/health")
    const b = recorder()
    await toNextHandlers(b.app, { publicUrl: "https://option.example.test" }).GET(new Request("http://localhost/api/clegra/health"))
    assert.equal(b.seen[0]?.url, "https://option.example.test/health")
  })

  test("a publicUrl that is not an origin is refused at start", () => {
    const { app } = recorder()
    for (const bad of ["crm.example.test", "https://crm.example.test/app", "https://crm.example.test/?a=1", "ftp://crm.example.test", "https://user:pw@crm.example.test"]) {
      assert.throws(() => toNextHandlers(app, { publicUrl: bad }), /publicUrl/, bad)
    }
    process.env.CLEGRA_PUBLIC_URL = "https://crm.example.test/sub"
    assert.throws(() => toNextHandlers(app), /CLEGRA_PUBLIC_URL/)
    assert.throws(() => toNextHandlers(app, { mount: "api" }), /mount/)
  })

  test("the body, method and query pass through", async () => {
    delete process.env.CLEGRA_PUBLIC_URL
    const { app, seen } = recorder()
    const handlers = toNextHandlers(app)
    await handlers.POST(new Request("http://localhost/api/clegra/mcp?a=b", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1 }) }))
    await handlers.DELETE(new Request("http://localhost/api/clegra/mcp", { method: "DELETE" }))
    await handlers.OPTIONS(new Request("http://localhost/api/clegra/mcp", { method: "OPTIONS" }))
    assert.deepEqual(seen.map((s) => [s.method, s.body]), [["POST", '{"jsonrpc":"2.0","id":1}'], ["DELETE", null], ["OPTIONS", null]])
    assert.equal(seen[0]?.url, "http://localhost/mcp?a=b")
  })

  test("an SSE stream passes through chunk by chunk, never buffered", async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const encoder = new TextEncoder()
    const { app } = recorder(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            async start(controller) {
              controller.enqueue(encoder.encode("data: first\n\n"))
              await gate
              controller.enqueue(encoder.encode("data: second\n\n"))
              controller.close()
            },
          }),
          { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } },
        ),
    )
    const response = await toNextHandlers(app).POST(new Request("http://localhost/api/clegra/mcp", { method: "POST", body: "{}" }))
    assert.equal(response.headers.get("cache-control"), "no-cache, no-transform")
    assert.equal(response.headers.get("x-accel-buffering"), "no")
    const reader = response.body!.getReader()
    assert.equal(new TextDecoder().decode((await reader.read()).value), "data: first\n\n")
    release()
    assert.equal(new TextDecoder().decode((await reader.read()).value), "data: second\n\n")
    assert.equal((await reader.read()).done, true)
  })
})

describe("toNextHandlers with a real app", () => {
  const note = defineEntity({ name: "note", title: "Note", path: "/notes/{id}", schema: z.object({ id: z.string(), title: z.string() }), card: { title: "title" }, get: ({ id }) => ({ id: id!, title: "Hello" }) })
  const app = defineApp({ name: "real", title: "Real", description: "Real", version: "1.0.0", entities: [note] })
  const served = serve(app, {
    origin: "https://crm.example.test",
    auth: { authorizationServers: ["https://crm.example.test/api/auth"], verify: (token) => (token === "good" ? { id: "g1", clientId: "https://client.example/c.json", person: { id: "p1", name: "Ada" }, scopes: ["web.read"] } : null) },
  })
  const handlers = toNextHandlers(served, { publicUrl: "https://crm.example.test" })

  test("server card, AI Catalog, protected-resource metadata and the 401 challenge at the public address", async () => {
    const card = await handlers.GET(new Request("http://localhost/api/clegra/mcp/server-card"))
    assert.equal(card.headers.get("content-type"), "application/mcp-server-card+json")
    assert.deepEqual(((await card.json()) as { remotes: unknown }).remotes, [{ type: "streamable-http", url: "https://crm.example.test/mcp" }])
    const catalog = (await (await handlers.GET(new Request("http://localhost/.well-known/ai-catalog.json"))).json()) as { entries: { type: string; url: string }[] }
    assert.deepEqual(catalog.entries.map((e) => [e.type, e.url]), [["application/mcp-server-card+json", "https://crm.example.test/mcp/server-card"]])
    const prm = (await (await handlers.GET(new Request("http://localhost/api/clegra/.well-known/oauth-protected-resource/mcp"))).json()) as { resource: string; authorization_servers: string[] }
    assert.equal(prm.resource, "https://crm.example.test/mcp")
    assert.deepEqual(prm.authorization_servers, ["https://crm.example.test/api/auth"])
    const denied = await handlers.POST(new Request("http://localhost/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }))
    assert.equal(denied.status, 401)
    assert.match(denied.headers.get("www-authenticate") ?? "", /resource_metadata="https:\/\/crm\.example\.test\/\.well-known\/oauth-protected-resource\/mcp"/)
  })

  test("a record URL read with a bearer token (as recordProxy rewrites it) answers its JSON", async () => {
    const ok = await handlers.GET(new Request("http://localhost/notes/3", { headers: { authorization: "Bearer good" } }))
    assert.equal(ok.status, 200)
    assert.deepEqual(await ok.json(), { id: "3", title: "Hello" })
    assert.equal((await handlers.GET(new Request("http://localhost/notes/3", { headers: { authorization: "Bearer bad" } }))).status, 401)
  })
})

describe("recordProxy", () => {
  test("a GET with a bearer (or DPoP) token goes to the mount; without one it goes on to the page", async () => {
    const proxy = recordProxy()
    const bearer = await proxy(new Request("http://localhost/notes/3?x=1", { headers: { authorization: "Bearer t" } }))
    assert.equal(bearer.headers.get("x-middleware-rewrite"), "http://localhost/api/clegra/notes/3?x=1")
    const dpop = await recordProxy({ mount: "/api/map" })(new Request("http://localhost/notes/3", { headers: { authorization: "DPoP t" } }))
    assert.equal(dpop.headers.get("x-middleware-rewrite"), "http://localhost/api/map/notes/3")
    const page = await proxy(new Request("http://localhost/notes/3", { headers: { cookie: "s=1" } }))
    assert.equal(page.headers.get("x-middleware-rewrite"), null)
    assert.equal(page.headers.get("x-middleware-next"), "1")
    const post = await proxy(new Request("http://localhost/notes/3", { method: "POST", headers: { authorization: "Bearer t" } }))
    assert.equal(post.headers.get("x-middleware-rewrite"), null)
  })
})

describe("withClegra: rewrites and config", () => {
  type Shape = { beforeFiles: { source: string; destination: string }[]; afterFiles: unknown[]; fallback: unknown[] }
  const rewritesOf = async (config: NextConfig) => (await (config.rewrites as () => Promise<Shape>)()) as Shape
  const ours = clegraRewrites()
  const theirs = { source: "/old", destination: "/new" }

  test("the rewrites: MCP and its card, the AI Catalog, the OAuth metadata, the sign-in, the confirmation and session-transfer pages, the access log, to the mount", () => {
    assert.deepEqual(
      ours.map((r) => r.source),
      ["/mcp", "/mcp/server-card", "/.well-known/ai-catalog.json", "/.well-known/oauth-protected-resource/:path*", "/.well-known/oauth-authorization-server/:path*", "/.well-known/openid-configuration/:path*", "/oauth/:path*", "/session-transfer/:path*", "/confirm/:path*", "/access/log"],
    )
    for (const r of ours) assert.equal(r.destination, `/api/clegra${r.source}`)
    assert.deepEqual(clegraRewrites({ signInPath: "/signin" }).slice(-2).map((r) => r.source), ["/signin", "/signin/out"])
    assert.equal(clegraRewrites({ mount: "/api/map" })[0]?.destination, "/api/map/mcp")
  })

  test("no rewrites of the app's own", async () => {
    assert.deepEqual(await rewritesOf(withClegra({})), { beforeFiles: ours, afterFiles: [], fallback: [] })
  })

  test("an array (Next applies it after files): kept as afterFiles", async () => {
    assert.deepEqual(await rewritesOf(withClegra({ rewrites: async () => [theirs] })), { beforeFiles: ours, afterFiles: [theirs], fallback: [] })
  })

  test("an object: ours first in beforeFiles, the rest kept", async () => {
    const config = withClegra({ rewrites: async () => ({ beforeFiles: [theirs], afterFiles: [{ source: "/a", destination: "/b" }], fallback: [{ source: "/:p*", destination: "https://old.example.test/:p*" }] }) })
    assert.deepEqual(await rewritesOf(config), { beforeFiles: [...ours, theirs], afterFiles: [{ source: "/a", destination: "/b" }], fallback: [{ source: "/:p*", destination: "https://old.example.test/:p*" }] })
    assert.deepEqual(await rewritesOf(withClegra({ rewrites: async () => ({ fallback: [theirs] }) })), { beforeFiles: ours, afterFiles: [], fallback: [theirs] })
  })

  test("a sync function (allowed by Next, though typed async)", async () => {
    const config = withClegra({ rewrites: (() => [theirs]) as unknown as NextConfig["rewrites"] })
    assert.deepEqual(await rewritesOf(config), { beforeFiles: ours, afterFiles: [theirs], fallback: [] })
  })

  test("a config function: wrapped, called with phase and defaults", async () => {
    const wrapped = withClegra(async (phase: string) => ({ env: { PHASE: phase }, rewrites: async () => [theirs] }))
    const config = await wrapped("phase-production-build", { defaultConfig: {} })
    assert.deepEqual(config.env, { PHASE: "phase-production-build" })
    assert.deepEqual(await rewritesOf(config), { beforeFiles: ours, afterFiles: [theirs], fallback: [] })
  })

  test("the rest of the config is kept as it is (the package ships JavaScript: no transpilePackages)", () => {
    const config = withClegra({ transpilePackages: ["some-ui"], reactStrictMode: true })
    assert.deepEqual(config.transpilePackages, ["some-ui"])
    assert.equal(withClegra({}).transpilePackages, undefined)
    assert.equal(config.reactStrictMode, true)
  })

  test("what would break the public paths is a clear error: basePath, trailingSlash, non-function rewrites", () => {
    assert.throws(() => withClegra({ basePath: "/app" }), /basePath/)
    assert.throws(() => withClegra({ trailingSlash: true }), /trailingSlash/)
    assert.throws(() => withClegra({ rewrites: [theirs] as unknown as NextConfig["rewrites"] }), /must be a function/)
    assert.throws(() => withClegra({}, { mount: "relative" }), /mount/)
  })
})
