import type { App } from "../define"
import type { SiteCaller } from "../site"
import type { NextConfig } from "next"
import type { ReactElement } from "react"

/**
 * `@clegra/sdk/next`: a Clegra app (a `defineApp` object) inside a Next.js app.
 *
 * - `toNextHandlers(app)` → the route handlers of `app/api/clegra/[...path]/route.ts`.
 * - `withClegra(nextConfig)` → the rewrites that put MCP and the manifest where hosts and clients look for
 *   them: `/mcp` and `/.well-known/…` at the root of the site, served by that one route.
 *
 * - The app's own site in Clegra (spec §5.1): `siteProxy(app)` → proxy.ts (who may frame each page, the signed-out
 *   page); `getClegraCaller(app)` → who looks at a page from a Clegra client; `<ClegraSite />` → the bridge.
 *
 * Only types are imported from the core: next.config loads this module and stays light. `next` is an optional
 * peer dependency: types here, and `next/server` / `next/headers` loaded only when the proxy or a page runs.
 */

/** Where the catch-all route lives by default (`app/api/clegra/[...path]/route.ts`). */
export const DEFAULT_MOUNT = "/api/clegra"

/** The paths rewritten to the route: MCP, the manifest, Clegra's registration document, events and views, the OAuth metadata (RFC 9728, RFC 8414, OpenID discovery). */
const PUBLIC_PATHS = [
  "/mcp",
  // MANIFEST_PATH, REGISTRATION_PATH, EVENTS_PATH and VIEWS_PATH (a test keeps them equal; not imported so that next.config does not load the SDK).
  "/.well-known/clegra.json",
  "/.well-known/clegra-app.json",
  "/clegra/events",
  "/clegra/views/:path*",
  "/clegra/site",
  "/clegra/site/:path*",
  "/.well-known/oauth-protected-resource/:path*",
  "/.well-known/oauth-authorization-server/:path*",
  "/.well-known/openid-configuration/:path*",
] as const

export type NextHandlerOptions = {
  /** Where the catch-all route is mounted (default `/api/clegra`): the same value as in `withClegra`. */
  mount?: string
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
 * Dev sign-in (`auth.dev`) is refused: it answers loopback callers only, and a Next route handler can't know the
 * peer's address (`x-forwarded-for` is whatever the client sent). Sign people in with the app's own auth
 * (`auth.resolve`), or run the app with `listen` from `@clegra/sdk/node` while developing.
 */
export function toNextHandlers(app: App, options: NextHandlerOptions = {}): NextHandlers {
  const mount = mountOf(options.mount)
  const fixedOrigin = options.publicUrl !== undefined ? publicOrigin(options.publicUrl, "publicUrl") : publicOrigin(process.env.CLEGRA_PUBLIC_URL, "CLEGRA_PUBLIC_URL")
  if (app.devMode) {
    throw new Error(
      "@clegra/sdk/next: auth.dev can't run inside Next.js — dev sign-in answers loopback callers only and a route handler can't know the caller's address. Use the app's own sign-in (auth.resolve) or run the app with listen() from @clegra/sdk/node.",
    )
  }
  const mcpPath = app.manifest().mcp.url
  if (mcpPath !== "/mcp") {
    throw new Error(`@clegra/sdk/next: the app serves MCP at ${mcpPath}; with Next.js leave defineApp's \`path\` unset — the route's mount (${mount}) is taken off and withClegra puts MCP at /mcp`)
  }

  const handle: NextRouteHandler = async (request) => {
    const url = new URL(request.url)
    let path = url.pathname
    if (path === mount || path.startsWith(`${mount}/`)) path = path.slice(mount.length) || "/"
    else if (path !== "/mcp" && path !== "/clegra/events" && !path.startsWith("/clegra/views/") && path !== "/clegra/site" && !path.startsWith("/clegra/site/") && !path.startsWith("/.well-known/")) {
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

/** The app, or how to get it (an app made on first use, as the examples do). */
export type AppSource = App | (() => App | Promise<App>)

/** The app's site; null for an app that declares none (one without Clegra configured: nothing of it is shown in Clegra). */
const siteOf = async (source: AppSource) => {
  const app = typeof source === "function" ? await source() : source
  return app.site
}

/** The SDK's own paths: the clegra route answers them with their own headers. */
const OWN = /^\/(?:mcp$|clegra\/|\.well-known\/|api\/clegra(?:\/|$))/

/**
 * proxy.ts for the app's own site (spec §5.1 step 7), in front of every page:
 *
 * ```ts
 * export const proxy = siteProxy(app)
 * export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] }
 * ```
 *
 * A page opened in a Clegra client with a session gets `Content-Security-Policy: frame-ancestors 'self' <the
 * client's origin>`; a frame of a Clegra client's partition whose session is gone gets the signed-out page (the
 * client opens the site again); anything else gets `otherwise` (default `frame-ancestors 'none'`: the site's own
 * sign-in, consent and settings are never framed). The SDK's own paths are left to the clegra route. An app that
 * declares no site (Clegra not configured) gets `otherwise` everywhere. Options:
 * `publicUrl` as in `toNextHandlers`; `otherwise`: the CSP of a page outside a Clegra session (null: none set).
 */
export function siteProxy(source: AppSource, options: { publicUrl?: string; otherwise?: string | null } = {}): (request: Request) => Promise<Response> {
  const fixedOrigin = options.publicUrl !== undefined ? publicOrigin(options.publicUrl, "publicUrl") : publicOrigin(process.env.CLEGRA_PUBLIC_URL, "CLEGRA_PUBLIC_URL")
  const otherwise = options.otherwise === undefined ? "frame-ancestors 'none'" : options.otherwise
  return async (request) => {
    const { NextResponse } = await import("next/server")
    const { pathname } = new URL(request.url)
    if (OWN.test(pathname)) return NextResponse.next()
    const site = await siteOf(source)
    const { headers, response } = site ? await site.guard(new Request(request.url, { headers: publicHeaders(request.headers, fixedOrigin) })) : { headers: null, response: null }
    if (response) return response
    const next = NextResponse.next()
    const policy = headers?.["content-security-policy"] ?? otherwise
    if (policy) next.headers.set("content-security-policy", policy)
    return next
  }
}

/** The headers a page's guard returns for this request, for an app that writes its own proxy (`app.site.guard`). */
export async function siteGuard(source: AppSource, request: Request, options: { publicUrl?: string } = {}): Promise<{ headers: Record<string, string> | null; response: Response | null }> {
  const fixedOrigin = options.publicUrl !== undefined ? publicOrigin(options.publicUrl, "publicUrl") : publicOrigin(process.env.CLEGRA_PUBLIC_URL, "CLEGRA_PUBLIC_URL")
  const site = await siteOf(source)
  if (!site) return { headers: null, response: null }
  return site.guard(new Request(request.url, { headers: publicHeaders(request.headers, fixedOrigin) }))
}

/**
 * Who looks at this page from a Clegra client (spec §5.1 step 6), in a server component, route handler or server
 * function: the person the site ticket was issued to, with the tenant (`installation`, as handlers' `ctx`), their
 * permissions in the app, locale and theme; null outside a Clegra session (the app's own sign-in applies then).
 */
export async function getClegraCaller(source: AppSource, options: { publicUrl?: string } = {}): Promise<SiteCaller | null> {
  const fixedOrigin = options.publicUrl !== undefined ? publicOrigin(options.publicUrl, "publicUrl") : publicOrigin(process.env.CLEGRA_PUBLIC_URL, "CLEGRA_PUBLIC_URL")
  // The request first: it makes the page dynamic before the app (its database, its auth) is touched, never at build time.
  const { headers } = await import("next/headers")
  const given = publicHeaders(new Headers(await headers()), fixedOrigin)
  if (!given.get("cookie")?.includes("clegra-site=")) return null
  const site = await siteOf(source)
  if (!site) return null
  const proto = given.get("x-forwarded-proto") ?? "http"
  return site.caller(new Request(`${proto}://${given.get("x-forwarded-host") ?? given.get("host") ?? "localhost"}/`, { headers: given }))
}

/**
 * The bridge between a page of the site and the Clegra client that frames it (spec §5.1 step 8): put it once in the
 * root layout. It does nothing outside a Clegra session. Without React: `<script src="/clegra/site/bridge.js" async>`.
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
}

/** The rewrites `withClegra` adds (in `beforeFiles`, so no page or public file can shadow them). */
export function clegraRewrites(options: WithClegraOptions = {}): Rewrite[] {
  const mount = mountOf(options.mount)
  return PUBLIC_PATHS.map((source) => ({ source, destination: `${mount}${source}` }))
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
