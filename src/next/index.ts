import type { ServedApp } from "../define"
import { useHostLookup } from "../platform"
import type { NextConfig } from "next"
import type { ReactElement } from "react"

/**
 * `@clegra/sdk/next`: a served Clegra app (`serve(app, …)`) inside a Next.js app.
 *
 * - `toNextHandlers(served)` → the route handlers of `app/api/clegra/[...path]/route.ts`.
 * - `withClegra(nextConfig)` → the rewrites that put MCP and the manifest where hosts and clients look for
 *   them: `/mcp` and `/.well-known/…` at the root of the site, served by that one route.
 *
 * - The app's own site in Clegra (spec §5.1): `siteProxy(served)` → proxy.ts (who may frame each page);
 *   `<ClegraSite />` → the bridge.
 *
 * Only types (and the tiny platform hook) are imported from the core: next.config loads this module and stays light. `next` is an optional
 * peer dependency: types here, and `next/server` / `next/headers` loaded only when the proxy or a page runs.
 */

/** Where the catch-all route lives by default (`app/api/clegra/[...path]/route.ts`). */
export const DEFAULT_MOUNT = "/api/clegra"

/** The paths rewritten to the route: MCP, the manifest, views, the site's bridge, the sign-in module, the OAuth metadata (RFC 9728, RFC 8414, OpenID discovery). */
const PUBLIC_PATHS = [
  "/mcp",
  // MANIFEST_PATH, VIEWS_PATH and SITE_BRIDGE_PATH (a test keeps them equal; not imported so that next.config does not load the SDK).
  "/.well-known/clegra.json",
  // The index as OpenAPI and its operations (OPENAPI_PATH, OPERATIONS_PATH).
  "/openapi.json",
  "/operations/:path*",
  "/clegra/views/:path*",
  "/clegra/site/bridge.js",
  // The sign-in module (`@clegra/sdk/signin`): authorize, token, revoke, its keys.
  "/oauth/:path*",
  "/.well-known/oauth-protected-resource/:path*",
  "/.well-known/oauth-authorization-server/:path*",
  "/.well-known/openid-configuration/:path*",
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
 * export const { GET, POST, DELETE, OPTIONS } = toNextHandlers(app)
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
export function toNextHandlers(app: ServedApp, options: NextHandlerOptions = {}): NextHandlers {
  const mount = mountOf(options.mount)
  const signInPath = options.signInPath ? mountOf(options.signInPath) : null
  const fixedOrigin = options.publicUrl !== undefined ? publicOrigin(options.publicUrl, "publicUrl") : publicOrigin(process.env.CLEGRA_PUBLIC_URL, "CLEGRA_PUBLIC_URL")
  // The core checks a client's host before it fetches the client's metadata: Node's resolver, loaded with the route.
  useHostLookup(async (host) => (await (await import("node:dns/promises")).lookup(host, { all: true })).map((a) => a.address))
  const mcpPath = app.manifest().mcp.url
  if (mcpPath !== "/mcp") {
    throw new Error(`@clegra/sdk/next: the app serves MCP at ${mcpPath}; with Next.js leave serve's \`path\` unset — the route's mount (${mount}) is taken off and withClegra puts MCP at /mcp`)
  }

  const handle: NextRouteHandler = async (request) => {
    const url = new URL(request.url)
    let path = url.pathname
    if (path === mount || path.startsWith(`${mount}/`)) path = path.slice(mount.length) || "/"
    else if (path !== "/mcp" && path !== "/openapi.json" && !path.startsWith("/operations/") && !path.startsWith("/clegra/views/") && path !== "/clegra/site/bridge.js" && !path.startsWith("/oauth/") && !path.startsWith("/.well-known/") && !(signInPath && (path === signInPath || path === `${signInPath}/out`))) {
      // The route file is somewhere else than `mount` says: a configuration error, said instead of guessed around.
      return new Response(JSON.stringify({ error: "misconfigured", error_description: `@clegra/sdk/next: request for ${path} reached the clegra route, but its mount is ${mount} (set the same mount in toNextHandlers and withClegra)` }), {
        status: 500,
        headers: { "content-type": "application/json" },
      })
    }
    const headers = publicHeaders(request.headers, fixedOrigin)
    const origin = fixedOrigin ? fixedOrigin.origin : url.origin
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

// ------------------------------------------------------------ the app's own site (spec §5.1)

/** The served app, or how to get it (one made on first use, as the examples do). */
export type AppSource = ServedApp | (() => ServedApp | Promise<ServedApp>)

/** The app's site; null for an app that declares none (one without Clegra configured: nothing of it is shown in Clegra). */
const siteOf = async (source: AppSource) => {
  const app = typeof source === "function" ? await source() : source
  return app.site
}

/** The SDK's own paths: the clegra route answers them with their own headers. */
const OWN = /^\/(?:mcp$|openapi\.json$|operations\/|clegra\/|\.well-known\/|api\/clegra(?:\/|$))/

/**
 * proxy.ts for the app's own site (spec §5.1), in front of every page:
 *
 * ```ts
 * export const proxy = siteProxy(app)
 * export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] }
 * ```
 *
 * Every page of the site gets `Content-Security-Policy: frame-ancestors 'self' <the app's client origins>`: a
 * workspace client (Clegra's web and desktop clients) may frame it, no other site. Who is signed in is the app's own
 * session (its sign-in works inside the frame: `frameCookie` of `@clegra/sdk/signin`). The SDK's own paths are left
 * to the clegra route. An app that declares no site gets `otherwise` (default `frame-ancestors 'none'`; null: none set).
 */
export function siteProxy(source: AppSource, options: { otherwise?: string | null } = {}): (request: Request) => Promise<Response> {
  const otherwise = options.otherwise === undefined ? "frame-ancestors 'none'" : options.otherwise
  return async (request) => {
    const { NextResponse } = await import("next/server")
    const { pathname } = new URL(request.url)
    if (OWN.test(pathname)) return NextResponse.next()
    const site = await siteOf(source)
    const next = NextResponse.next()
    const policy = site ? site.headers()["content-security-policy"] : otherwise
    if (policy) next.headers.set("content-security-policy", policy)
    return next
  }
}

/**
 * The bridge between a page of the site and the Clegra client that frames it (spec §5.1 step 8): put it once in the
 * root layout. It does nothing outside a frame of one of the app's client origins. Without React: `<script src="/clegra/site/bridge.js" async>`.
 */
export async function ClegraSite(): Promise<ReactElement> {
  const { createElement } = await import("react")
  return createElement("script", { src: "/clegra/site/bridge.js", async: true })
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
 * next.config: adds the rewrites for `/mcp`, `/.well-known/clegra.json` and the OAuth metadata paths to the
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
