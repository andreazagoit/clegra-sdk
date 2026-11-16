import type { App } from "../define"
import type { NextConfig } from "next"

/**
 * `modelapp/next`: a MAP app (a `defineApp` object) inside a Next.js app.
 *
 * - `toNextHandlers(app)` → the route handlers of `app/api/modelapp/[...path]/route.ts`.
 * - `withModelApp(nextConfig)` → the rewrites that put MCP and the manifest where hosts and clients look for
 *   them: `/mcp` and `/.well-known/…` at the root of the site, served by that one route.
 *
 * Only types are imported from the core: next.config loads this module and stays light. `next` is an optional
 * peer dependency, imported (as types) only here.
 */

/** Where the catch-all route lives by default (`app/api/modelapp/[...path]/route.ts`). */
export const DEFAULT_MOUNT = "/api/modelapp"

/** The paths rewritten to the route: MCP, the manifest and the OAuth metadata (RFC 9728, RFC 8414, OpenID discovery). */
const PUBLIC_PATHS = [
  "/mcp",
  // MANIFEST_PATH (a test keeps the two equal; not imported so that next.config does not load the SDK).
  "/.well-known/modelapp.json",
  "/.well-known/oauth-protected-resource/:path*",
  "/.well-known/oauth-authorization-server/:path*",
  "/.well-known/openid-configuration/:path*",
] as const

export type NextHandlerOptions = {
  /** Where the catch-all route is mounted (default `/api/modelapp`): the same value as in `withModelApp`. */
  mount?: string
  /**
   * The site's public origin (`https://crm.example.com`), when the request alone can't say it (a proxy that
   * rewrites the host). Default: the `MODELAPP_PUBLIC_URL` environment variable; without either, the origin is
   * what the request says (`x-forwarded-host` / `x-forwarded-proto`, else `host`).
   */
  publicUrl?: string
}

export type NextRouteHandler = (request: Request) => Promise<Response>
export type NextHandlers = { GET: NextRouteHandler; POST: NextRouteHandler; DELETE: NextRouteHandler; OPTIONS: NextRouteHandler }

function mountOf(mount: string | undefined): string {
  const m = (mount ?? DEFAULT_MOUNT).replace(/\/+$/, "")
  if (!/^(\/[A-Za-z0-9._~-]+)+$/.test(m)) throw new Error(`modelapp/next: mount "${mount}" must be a URL path like /api/modelapp`)
  return m
}

function publicOrigin(value: string | undefined, where: string): URL | null {
  if (value === undefined || value === "") return null
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`modelapp/next: ${where} "${value}" is not a URL`)
  }
  if (!/^https?:$/.test(url.protocol) || (url.pathname !== "/" && url.pathname !== "") || url.search || url.hash || url.username || url.password) {
    throw new Error(`modelapp/next: ${where} "${value}" must be an origin only, like https://crm.example.com (no path, query or credentials)`)
  }
  return url
}

/**
 * The route handlers for `app/api/modelapp/[...path]/route.ts`:
 *
 * ```ts
 * export const { GET, POST, DELETE, OPTIONS } = toNextHandlers(app)
 * ```
 *
 * Each request reaches `app.fetch` at its PUBLIC address: the mount taken off (`/api/modelapp/mcp` → `/mcp`),
 * the origin `publicUrl` when given. Responses (JSON or an SSE stream) are returned as they are, never buffered.
 * Nothing is kept between requests (MCP is stateless): it runs on serverless as on one server.
 *
 * Dev sign-in (`auth.dev`) is refused: it answers loopback callers only, and a Next route handler can't know the
 * peer's address (`x-forwarded-for` is whatever the client sent). Sign people in with the app's own auth
 * (`auth.resolve`), or run the app with `listen` from `modelapp/node` while developing.
 */
export function toNextHandlers(app: App, options: NextHandlerOptions = {}): NextHandlers {
  const mount = mountOf(options.mount)
  const fixedOrigin = options.publicUrl !== undefined ? publicOrigin(options.publicUrl, "publicUrl") : publicOrigin(process.env.MODELAPP_PUBLIC_URL, "MODELAPP_PUBLIC_URL")
  if (app.devMode) {
    throw new Error(
      "modelapp/next: auth.dev can't run inside Next.js — dev sign-in answers loopback callers only and a route handler can't know the caller's address. Use the app's own sign-in (auth.resolve) or run the app with listen() from modelapp/node.",
    )
  }
  const mcpPath = app.manifest().mcp.url
  if (mcpPath !== "/mcp") {
    throw new Error(`modelapp/next: the app serves MCP at ${mcpPath}; with Next.js leave defineApp's \`path\` unset — the route's mount (${mount}) is taken off and withModelApp puts MCP at /mcp`)
  }

  const handle: NextRouteHandler = async (request) => {
    const url = new URL(request.url)
    let path = url.pathname
    if (path === mount || path.startsWith(`${mount}/`)) path = path.slice(mount.length) || "/"
    else if (path !== "/mcp" && !path.startsWith("/.well-known/")) {
      // The route file is somewhere else than `mount` says: a configuration error, said instead of guessed around.
      return new Response(JSON.stringify({ error: "misconfigured", error_description: `modelapp/next: request for ${path} reached the MAP route, but its mount is ${mount} (set the same mount in toNextHandlers and withModelApp)` }), {
        status: 500,
        headers: { "content-type": "application/json" },
      })
    }
    const headers = new Headers(request.headers)
    let origin = url.origin
    if (fixedOrigin) {
      // The core reads the public origin from x-forwarded-* first: the configured one replaces whatever came in.
      origin = fixedOrigin.origin
      headers.set("x-forwarded-host", fixedOrigin.host)
      headers.set("x-forwarded-proto", fixedOrigin.protocol.slice(0, -1))
      headers.set("host", fixedOrigin.host)
    }
    const hasBody = request.method !== "GET" && request.method !== "HEAD" && request.body !== null
    const init: RequestInit & { duplex?: "half" } = { method: request.method, headers, signal: request.signal, ...(hasBody ? { body: request.body, duplex: "half" } : {}) }
    const response = await app.fetch(new Request(new URL(path + url.search, origin), init), { remoteAddress: null })
    if (!(response.headers.get("content-type") ?? "").startsWith("text/event-stream")) return response
    // An SSE stream: no compression or other transform may hold it back (`next start` compresses responses).
    const streamed = new Headers(response.headers)
    const cache = streamed.get("cache-control")
    if (!cache?.includes("no-transform")) streamed.set("cache-control", cache ? `${cache}, no-transform` : "no-cache, no-transform")
    streamed.set("x-accel-buffering", "no")
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers: streamed })
  }
  return { GET: handle, POST: handle, DELETE: handle, OPTIONS: handle }
}

// ------------------------------------------------------------ next.config

type Rewrite = { source: string; destination: string; basePath?: false; locale?: false; has?: unknown[]; missing?: unknown[] }
type Rewrites = Rewrite[] | { beforeFiles?: Rewrite[]; afterFiles?: Rewrite[]; fallback?: Rewrite[] }
type ConfigFunction = (phase: string, context: { defaultConfig: NextConfig }) => NextConfig | Promise<NextConfig>

export type WithModelAppOptions = {
  /** Where the catch-all route is mounted (default `/api/modelapp`): the same value as in `toNextHandlers`. */
  mount?: string
}

/** The rewrites `withModelApp` adds (in `beforeFiles`, so no page or public file can shadow them). */
export function modelAppRewrites(options: WithModelAppOptions = {}): Rewrite[] {
  const mount = mountOf(options.mount)
  return PUBLIC_PATHS.map((source) => ({ source, destination: `${mount}${source}` }))
}

function withConfig(config: NextConfig, options: WithModelAppOptions): NextConfig {
  if (config.basePath) throw new Error(`withModelApp: basePath "${config.basePath}" is not supported — /mcp and /.well-known/… must be at the root of the host (RFC 8615, RFC 9728)`)
  if (config.trailingSlash) throw new Error("withModelApp: trailingSlash: true redirects /mcp to /mcp/, and MCP clients use the exact address of the protected resource; turn it off")
  const ours = modelAppRewrites(options)
  const theirs = config.rewrites as (() => Rewrites | Promise<Rewrites>) | undefined
  if (theirs !== undefined && typeof theirs !== "function") throw new Error("withModelApp: next.config `rewrites` must be a function (sync or async)")
  const rewrites = async () => {
    const given = theirs ? await theirs() : []
    if (Array.isArray(given)) return { beforeFiles: ours, afterFiles: given, fallback: [] }
    return { beforeFiles: [...ours, ...(given.beforeFiles ?? [])], afterFiles: given.afterFiles ?? [], fallback: given.fallback ?? [] }
  }
  return { ...config, rewrites: rewrites as NextConfig["rewrites"] }
}

/**
 * next.config: adds the rewrites for `/mcp`, `/.well-known/modelapp.json` and the OAuth metadata paths to the
 * MAP route (before the app's own, merged with them in any shape: array, object, sync or async function). The rest
 * of the config is kept as it is. Takes the config object or a config function.
 */
export function withModelApp(config: NextConfig, options?: WithModelAppOptions): NextConfig
export function withModelApp(config: ConfigFunction, options?: WithModelAppOptions): ConfigFunction
export function withModelApp(config: NextConfig | ConfigFunction, options: WithModelAppOptions = {}): NextConfig | ConfigFunction {
  mountOf(options.mount)
  if (typeof config === "function") return async (phase, context) => withConfig(await config(phase, context), options)
  return withConfig(config, options)
}
