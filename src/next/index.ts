import type { ServedApp } from "../server"
import { useHostLookup } from "../platform"
import type { NextConfig } from "next"

/**
 * `@clegra/sdk/next`: a served Clegra app (`serve(app, …)`) inside a Next.js app.
 *
 * - `toNextHandlers(served)` → the route handlers of `app/api/clegra/[...path]/route.ts`.
 * - `withClegra(nextConfig)` → the rewrites that put MCP, its Server Card and the OAuth metadata where clients look
 *   for them (`/mcp`, `/.well-known/…`, at the root of the site), served by that one route.
 *
 * - `recordProxy()` → proxy.ts: a record URL read with a bearer token goes to the route (web-map REC-1).
 *
 * Only types (and the tiny platform hook) are imported from the core: next.config loads this module and stays light. `next` is an optional
 * peer dependency: types here, and `next/server` / `next/headers` loaded only when the proxy or a page runs.
 */

/** Where the catch-all route lives by default (`app/api/clegra/[...path]/route.ts`). */
export const DEFAULT_MOUNT = "/api/clegra"

/** The paths rewritten to the route: MCP and its Server Card, the AI Catalog, the OAuth metadata (RFC 9728, RFC 8414, OpenID discovery), the sign-in module, the confirmation and session-transfer pages, the access log. */
const PUBLIC_PATHS = [
  "/mcp",
  "/mcp/server-card",
  "/.well-known/ai-catalog.json",
  "/.well-known/oauth-protected-resource/:path*",
  "/.well-known/oauth-authorization-server/:path*",
  "/.well-known/openid-configuration/:path*",
  "/oauth/:path*",
  "/session-transfer/:path*",
  "/confirm/:path*",
  "/access/log",
] as const

export type NextHandlerOptions = {
  /** Where the catch-all route is mounted (default `/api/clegra`): the same value as in `withClegra`. */
  mount?: string
  /** The password login's page (`passwordLogin({ path })`), as given to `withClegra`. */
  signInPath?: string
  /**
   * The site's public origin (`https://crm.example.com`), when the request alone can't say it (a proxy that
   * rewrites the host). Default: the `CLEGRA_PUBLIC_URL` environment variable; without either, the origin is
   * what the request says (`x-forwarded-host` / `x-forwarded-proto`, else `host`).
   */
  publicUrl?: string
}

export type NextRouteHandler = (request: Request) => Promise<Response>
export type NextHandlers = { GET: NextRouteHandler; POST: NextRouteHandler; DELETE: NextRouteHandler; OPTIONS: NextRouteHandler }

function mountOf(mount: string | undefined): string {
  const m = (mount ?? DEFAULT_MOUNT).replace(/\/+$/, "")
  if (!/^(\/[A-Za-z0-9._~-]+)+$/.test(m)) throw new Error(`@clegra/sdk/next: mount "${mount}" must be a URL path like /api/clegra`)
  return m
}

function publicOrigin(value: string | undefined, where: string): URL | null {
  if (value === undefined || value === "") return null
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`@clegra/sdk/next: ${where} "${value}" is not a URL`)
  }
  if (!/^https?:$/.test(url.protocol) || (url.pathname !== "/" && url.pathname !== "") || url.search || url.hash || url.username || url.password) {
    throw new Error(`@clegra/sdk/next: ${where} "${value}" must be an origin only, like https://crm.example.com (no path, query or credentials)`)
  }
  return url
}

/**
 * The route handlers for `app/api/clegra/[...path]/route.ts`:
 *
 * ```ts
 * export const { GET, POST, DELETE, OPTIONS } = toNextHandlers(served)   // the served app, or a function making it on first use
 * ```
 *
 * Each request reaches `app.fetch` at its PUBLIC address: the mount taken off (`/api/clegra/mcp` → `/mcp`),
 * the origin `publicUrl` when given. Responses (JSON or an SSE stream) are returned as they are, never buffered.
 * Nothing is kept between requests (MCP is stateless): it runs on serverless as on one server.
 *
 * With the development sign-in (`devSignIn`) its login works here, but its development tokens never count: they answer
 * loopback callers only, and a Next route handler can't know the peer's address (`x-forwarded-for` is whatever the
 * client sent). Tests that use them run the app with `listen` (`@clegra/sdk/node`) or `testClient`.
 */
export function toNextHandlers(source: ServedApp | (() => ServedApp | Promise<ServedApp>), options: NextHandlerOptions = {}): NextHandlers {
  const mount = mountOf(options.mount)
  const signInPath = options.signInPath ? mountOf(options.signInPath) : null
  const fixedOrigin = options.publicUrl !== undefined ? publicOrigin(options.publicUrl, "publicUrl") : publicOrigin(process.env.CLEGRA_PUBLIC_URL, "CLEGRA_PUBLIC_URL")
  // The core checks a client's host before it fetches the client's metadata: Node's resolver, loaded with the route.
  useHostLookup(async (host) => (await (await import("node:dns/promises")).lookup(host, { all: true })).map((a) => a.address))
  const handle: NextRouteHandler = async (request) => {
    const url = new URL(request.url)
    let path = url.pathname
    // Under the mount (`/api/clegra/mcp` → `/mcp`); a rewritten request (a record URL read with a bearer token) arrives with its own path.
    if (path === mount || path.startsWith(`${mount}/`)) path = path.slice(mount.length) || "/"
    const headers = publicHeaders(request.headers, fixedOrigin)
    const origin = fixedOrigin ? fixedOrigin.origin : url.origin
    const hasBody = request.method !== "GET" && request.method !== "HEAD" && request.body !== null
    const init: RequestInit & { duplex?: "half" } = { method: request.method, headers, signal: request.signal, ...(hasBody ? { body: request.body, duplex: "half" } : {}) }
    const app = typeof source === "function" ? await source() : source
    const response = await app.fetch(new Request(new URL(path + url.search, origin), init))
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

/** The request's headers, with the configured public origin in place of whatever came in (the core reads x-forwarded-* first). */
function publicHeaders(given: Headers, fixedOrigin: URL | null): Headers {
  const headers = new Headers(given)
  if (fixedOrigin) {
    headers.set("x-forwarded-host", fixedOrigin.host)
    headers.set("x-forwarded-proto", fixedOrigin.protocol.slice(0, -1))
    headers.set("host", fixedOrigin.host)
  }
  return headers
}

// ------------------------------------------------------------ record URLs read with a bearer token (web-map REC-1)

/**
 * proxy.ts: a record's URL is also its page, and a page and a route handler cannot share a path, so a `GET` that
 * carries `Authorization: Bearer` (or `DPoP`) on a record path is rewritten to the clegra route, which answers the
 * record's JSON (or 401). Requests without a token go on to the page as they did.
 *
 * ```ts
 * export const proxy = recordProxy()
 * export const config = { matcher: ["/jobs/:id"] }   // your entities' paths
 * ```
 */
export function recordProxy(options: { mount?: string } = {}): (request: Request) => Promise<Response> {
  const mount = mountOf(options.mount)
  return async (request) => {
    const { NextResponse } = await import("next/server")
    if ((request.method === "GET" || request.method === "HEAD") && /^(Bearer|DPoP)\s/i.test(request.headers.get("authorization") ?? "")) {
      const url = new URL(request.url)
      return NextResponse.rewrite(new URL(`${mount}${url.pathname}${url.search}`, request.url))
    }
    return NextResponse.next()
  }
}

// ------------------------------------------------------------ next.config

type Rewrite = { source: string; destination: string; basePath?: false; locale?: false; has?: unknown[]; missing?: unknown[] }
type Rewrites = Rewrite[] | { beforeFiles?: Rewrite[]; afterFiles?: Rewrite[]; fallback?: Rewrite[] }
type ConfigFunction = (phase: string, context: { defaultConfig: NextConfig }) => NextConfig | Promise<NextConfig>

export type WithClegraOptions = {
  /** Where the catch-all route is mounted (default `/api/clegra`): the same value as in `toNextHandlers`. */
  mount?: string
  /** The sign-in module's password login page (`passwordLogin({ path })`, e.g. `/signin`): it and `<path>/out` go to the route too. */
  signInPath?: string
}

/** The rewrites `withClegra` adds (in `beforeFiles`, so no page or public file can shadow them). */
export function clegraRewrites(options: WithClegraOptions = {}): Rewrite[] {
  const mount = mountOf(options.mount)
  const signIn = options.signInPath ? mountOf(options.signInPath) : null
  return [...PUBLIC_PATHS, ...(signIn ? [signIn, `${signIn}/out`] : [])].map((source) => ({ source, destination: `${mount}${source}` }))
}

function withConfig(config: NextConfig, options: WithClegraOptions): NextConfig {
  if (config.basePath) throw new Error(`withClegra: basePath "${config.basePath}" is not supported — /mcp and /.well-known/… must be at the root of the host (RFC 8615, RFC 9728)`)
  if (config.trailingSlash) throw new Error("withClegra: trailingSlash: true redirects /mcp to /mcp/, and MCP clients use the exact address of the protected resource; turn it off")
  const ours = clegraRewrites(options)
  const theirs = config.rewrites as (() => Rewrites | Promise<Rewrites>) | undefined
  if (theirs !== undefined && typeof theirs !== "function") throw new Error("withClegra: next.config `rewrites` must be a function (sync or async)")
  const rewrites = async () => {
    const given = theirs ? await theirs() : []
    if (Array.isArray(given)) return { beforeFiles: ours, afterFiles: given, fallback: [] }
    return { beforeFiles: [...ours, ...(given.beforeFiles ?? [])], afterFiles: given.afterFiles ?? [], fallback: given.fallback ?? [] }
  }
  return { ...config, rewrites: rewrites as NextConfig["rewrites"] }
}

/**
 * next.config: adds the rewrites for `/mcp`, the Server Card, the AI Catalog and the OAuth metadata paths to the
 * clegra route (before the app's own, merged with them in any shape: array, object, sync or async function). The rest
 * of the config is kept as it is. Takes the config object or a config function.
 */
export function withClegra(config: NextConfig, options?: WithClegraOptions): NextConfig
export function withClegra(config: ConfigFunction, options?: WithClegraOptions): ConfigFunction
export function withClegra(config: NextConfig | ConfigFunction, options: WithClegraOptions = {}): NextConfig | ConfigFunction {
  mountOf(options.mount)
  if (typeof config === "function") return async (phase, context) => withConfig(await config(phase, context), options)
  return withConfig(config, options)
}
