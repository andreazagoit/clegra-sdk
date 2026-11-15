import assert from "node:assert/strict"
import { afterEach, describe, test } from "node:test"
import { z } from "zod"

import { defineApp, MANIFEST_PATH, type App } from "../index"
import type { NextConfig } from "next"

import { modelAppRewrites, toNextHandlers, withModelApp } from "./index"

// A stand-in app that records what reaches app.fetch.
function recorder(respond?: (request: Request) => Response | Promise<Response>) {
  const seen: { url: string; headers: Headers; method: string; body: string | null; remoteAddress: unknown }[] = []
  const app = {
    devMode: false,
    manifest: () => ({ mcp: { url: "/mcp" } }),
    fetch: async (request: Request, info: { remoteAddress?: string | null } = {}) => {
      seen.push({ url: request.url, headers: request.headers, method: request.method, body: request.body ? await request.clone().text() : null, remoteAddress: info.remoteAddress })
      return respond ? respond(request) : Response.json({ ok: true })
    },
  } as unknown as App
  return { app, seen }
}

const savedEnv = process.env.MODELAPP_PUBLIC_URL
afterEach(() => {
  if (savedEnv === undefined) delete process.env.MODELAPP_PUBLIC_URL
  else process.env.MODELAPP_PUBLIC_URL = savedEnv
})

describe("toNextHandlers: the public address", () => {
  test("the mount is taken off; a rewritten request (Next shows the source path) is kept as it is", async () => {
    delete process.env.MODELAPP_PUBLIC_URL
    const { app, seen } = recorder()
    const { GET, POST } = toNextHandlers(app)
    await POST(new Request("http://localhost:3000/api/modelapp/mcp", { method: "POST", body: "{}" }))
    await GET(new Request("http://localhost:3000/api/modelapp/.well-known/oauth-protected-resource/mcp?x=1"))
    await GET(new Request("http://localhost:3000/api/modelapp"))
    await POST(new Request("http://localhost:3000/mcp", { method: "POST", body: "{}" }))
    await GET(new Request("http://localhost:3000/.well-known/modelapp.json"))
    assert.deepEqual(
      seen.map((s) => s.url),
      ["http://localhost:3000/mcp", "http://localhost:3000/.well-known/oauth-protected-resource/mcp?x=1", "http://localhost:3000/", "http://localhost:3000/mcp", "http://localhost:3000/.well-known/modelapp.json"],
    )
  })

  test("a custom mount; a path outside it and outside the rewrites is a clear 500, not a guess", async () => {
    delete process.env.MODELAPP_PUBLIC_URL
    const { app, seen } = recorder()
    const { GET } = toNextHandlers(app, { mount: "/api/map/" })
    await GET(new Request("http://localhost/api/map/health"))
    assert.equal(seen[0]?.url, "http://localhost/health")
    const wrong = await GET(new Request("http://localhost/api/modelapp/mcp"))
    assert.equal(wrong.status, 500)
    assert.match(((await wrong.json()) as { error_description: string }).error_description, /mount is \/api\/map/)
    assert.equal(seen.length, 1)
  })

  test("publicUrl replaces the origin and the forwarded headers the core reads", async () => {
    const { app, seen } = recorder()
    const { POST } = toNextHandlers(app, { publicUrl: "https://crm.example.test" })
    await POST(new Request("http://10.0.0.5:3000/api/modelapp/mcp", { method: "POST", body: "{}", headers: { "x-forwarded-host": "evil.example", "x-forwarded-proto": "http" } }))
    assert.equal(seen[0]?.url, "https://crm.example.test/mcp")
    assert.equal(seen[0]?.headers.get("x-forwarded-host"), "crm.example.test")
    assert.equal(seen[0]?.headers.get("x-forwarded-proto"), "https")
    assert.equal(seen[0]?.headers.get("host"), "crm.example.test")
  })

  test("MODELAPP_PUBLIC_URL is the default publicUrl; the option wins over it", async () => {
    process.env.MODELAPP_PUBLIC_URL = "https://from-env.example.test"
    const a = recorder()
    await toNextHandlers(a.app).GET(new Request("http://localhost/api/modelapp/health"))
    assert.equal(a.seen[0]?.url, "https://from-env.example.test/health")
    const b = recorder()
    await toNextHandlers(b.app, { publicUrl: "https://option.example.test" }).GET(new Request("http://localhost/api/modelapp/health"))
    assert.equal(b.seen[0]?.url, "https://option.example.test/health")
  })

  test("without publicUrl the forwarded headers reach the core untouched (it derives the origin from them)", async () => {
    delete process.env.MODELAPP_PUBLIC_URL
    const { app, seen } = recorder()
    await toNextHandlers(app).GET(new Request("http://localhost:3000/api/modelapp/health", { headers: { "x-forwarded-host": "crm.example.test", "x-forwarded-proto": "https" } }))
    assert.equal(seen[0]?.headers.get("x-forwarded-host"), "crm.example.test")
    assert.equal(seen[0]?.headers.get("x-forwarded-proto"), "https")
  })

  test("a publicUrl that is not an origin is refused at start", () => {
    const { app } = recorder()
    for (const bad of ["crm.example.test", "https://crm.example.test/app", "https://crm.example.test/?a=1", "ftp://crm.example.test", "https://user:pw@crm.example.test"]) {
      assert.throws(() => toNextHandlers(app, { publicUrl: bad }), /publicUrl/, bad)
    }
    process.env.MODELAPP_PUBLIC_URL = "https://crm.example.test/sub"
    assert.throws(() => toNextHandlers(app), /MODELAPP_PUBLIC_URL/)
    assert.throws(() => toNextHandlers(app, { mount: "api" }), /mount/)
  })

  test("the body, method and query pass through; the peer address is never claimed (null)", async () => {
    delete process.env.MODELAPP_PUBLIC_URL
    const { app, seen } = recorder()
    const handlers = toNextHandlers(app)
    await handlers.POST(new Request("http://localhost/api/modelapp/mcp?a=b", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1 }), headers: { "x-forwarded-for": "127.0.0.1" } }))
    await handlers.DELETE(new Request("http://localhost/api/modelapp/mcp", { method: "DELETE" }))
    await handlers.OPTIONS(new Request("http://localhost/api/modelapp/mcp", { method: "OPTIONS" }))
    assert.deepEqual(
      seen.map((s) => [s.method, s.body, s.remoteAddress]),
      [
        ["POST", '{"jsonrpc":"2.0","id":1}', null],
        ["DELETE", null, null],
        ["OPTIONS", null, null],
      ],
    )
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
    const response = await toNextHandlers(app).POST(new Request("http://localhost/api/modelapp/mcp", { method: "POST", body: "{}" }))
    assert.equal(response.headers.get("cache-control"), "no-cache, no-transform")
    assert.equal(response.headers.get("x-accel-buffering"), "no")
    const reader = response.body!.getReader()
    // The first event arrives while the producer is still waiting: nothing held it back.
    assert.equal(new TextDecoder().decode((await reader.read()).value), "data: first\n\n")
    release()
    assert.equal(new TextDecoder().decode((await reader.read()).value), "data: second\n\n")
    assert.equal((await reader.read()).done, true)
  })

  test("auth.dev is refused (a route handler can't know the peer address); an app with its own `path` too", () => {
    const dev = defineApp({ name: "dev-app", title: "Dev", version: "1.0.0", auth: { dev: { keyFile: false } }, entities: {} })
    assert.throws(() => toNextHandlers(dev), /auth\.dev can't run inside Next/)
    const pathed = defineApp({ name: "pathed", title: "Pathed", version: "1.0.0", path: "/api/modelapp", entities: {} })
    assert.throws(() => toNextHandlers(pathed), /leave defineApp's `path` unset/)
  })
})

describe("toNextHandlers with a real app", () => {
  const app = defineApp({
    name: "real",
    title: "Real",
    version: "1.0.0",
    auth: { resource: "https://crm.example.test/mcp", authorizationServers: ["https://crm.example.test/api/auth"], resolve: () => null },
    entities: {
      note: {
        label: "Note",
        schema: z.object({ id: z.string(), title: z.string().meta({ role: "title" }) }),
        get: () => null,
        list: () => ({ rows: [] }),
      },
    },
  })
  const handlers = toNextHandlers(app, { publicUrl: "https://crm.example.test" })

  test("manifest, protected-resource metadata and the 401 challenge at the public address", async () => {
    const manifest = await handlers.GET(new Request("http://localhost/.well-known/modelapp.json"))
    assert.equal(manifest.status, 200)
    assert.equal(((await manifest.json()) as { mcp: { url: string } }).mcp.url, "/mcp")
    const prm = (await (await handlers.GET(new Request("http://localhost/api/modelapp/.well-known/oauth-protected-resource/mcp"))).json()) as { resource: string; authorization_servers: string[] }
    assert.deepEqual(prm.resource, "https://crm.example.test/mcp")
    assert.deepEqual(prm.authorization_servers, ["https://crm.example.test/api/auth"])
    const denied = await handlers.POST(new Request("http://localhost/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }))
    assert.equal(denied.status, 401)
    assert.match(denied.headers.get("www-authenticate") ?? "", /resource_metadata="https:\/\/crm\.example\.test\/\.well-known\/oauth-protected-resource\/mcp"/)
  })
})

describe("withModelApp: rewrites and config", () => {
  type Shape = { beforeFiles: { source: string; destination: string }[]; afterFiles: unknown[]; fallback: unknown[] }
  const rewritesOf = async (config: NextConfig) => (await (config.rewrites as () => Promise<Shape>)()) as Shape
  const ours = modelAppRewrites()
  const theirs = { source: "/old", destination: "/new" }

  test("the rewrites: /mcp, the manifest and every OAuth metadata path to the mount", () => {
    assert.deepEqual(ours, [
      { source: "/mcp", destination: "/api/modelapp/mcp" },
      { source: MANIFEST_PATH, destination: `/api/modelapp${MANIFEST_PATH}` },
      { source: "/.well-known/oauth-protected-resource/:path*", destination: "/api/modelapp/.well-known/oauth-protected-resource/:path*" },
      { source: "/.well-known/oauth-authorization-server/:path*", destination: "/api/modelapp/.well-known/oauth-authorization-server/:path*" },
      { source: "/.well-known/openid-configuration/:path*", destination: "/api/modelapp/.well-known/openid-configuration/:path*" },
    ])
    assert.equal(modelAppRewrites({ mount: "/api/map" })[0]?.destination, "/api/map/mcp")
  })

  test("no rewrites of the app's own", async () => {
    assert.deepEqual(await rewritesOf(withModelApp({})), { beforeFiles: ours, afterFiles: [], fallback: [] })
  })

  test("an array (Next applies it after files): kept as afterFiles", async () => {
    assert.deepEqual(await rewritesOf(withModelApp({ rewrites: async () => [theirs] })), { beforeFiles: ours, afterFiles: [theirs], fallback: [] })
  })

  test("an object: ours first in beforeFiles, the rest kept", async () => {
    const config = withModelApp({ rewrites: async () => ({ beforeFiles: [theirs], afterFiles: [{ source: "/a", destination: "/b" }], fallback: [{ source: "/:p*", destination: "https://old.example.test/:p*" }] }) })
    assert.deepEqual(await rewritesOf(config), { beforeFiles: [...ours, theirs], afterFiles: [{ source: "/a", destination: "/b" }], fallback: [{ source: "/:p*", destination: "https://old.example.test/:p*" }] })
    assert.deepEqual(await rewritesOf(withModelApp({ rewrites: async () => ({ fallback: [theirs] }) })), { beforeFiles: ours, afterFiles: [], fallback: [theirs] })
  })

  test("a sync function (allowed by Next, though typed async)", async () => {
    const config = withModelApp({ rewrites: (() => [theirs]) as unknown as NextConfig["rewrites"] })
    assert.deepEqual(await rewritesOf(config), { beforeFiles: ours, afterFiles: [theirs], fallback: [] })
  })

  test("a config function: wrapped, called with phase and defaults", async () => {
    const wrapped = withModelApp(async (phase: string) => ({ env: { PHASE: phase }, rewrites: async () => [theirs] }))
    const config = await wrapped("phase-production-build", { defaultConfig: {} })
    assert.deepEqual(config.env, { PHASE: "phase-production-build" })
    assert.deepEqual(await rewritesOf(config), { beforeFiles: ours, afterFiles: [theirs], fallback: [] })
  })

  test("transpilePackages: the SDK added, the app's kept, no duplicates; other keys untouched", () => {
    const config = withModelApp({ transpilePackages: ["some-ui", "modelapp"], reactStrictMode: true })
    assert.deepEqual(config.transpilePackages, ["some-ui", "modelapp"])
    assert.deepEqual(withModelApp({}).transpilePackages, ["modelapp"])
    assert.equal(config.reactStrictMode, true)
  })

  test("what would break the public paths is a clear error: basePath, trailingSlash, non-function rewrites", () => {
    assert.throws(() => withModelApp({ basePath: "/app" }), /basePath/)
    assert.throws(() => withModelApp({ trailingSlash: true }), /trailingSlash/)
    assert.throws(() => withModelApp({ rewrites: [theirs] as unknown as NextConfig["rewrites"] }), /must be a function/)
    assert.throws(() => withModelApp({}, { mount: "relative" }), /mount/)
  })
})
