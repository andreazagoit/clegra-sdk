import { hkdfSync, randomUUID } from "node:crypto"

import { jwtVerify, SignJWT, type JWTPayload } from "jose"

import { EMBED_COOKIE_PREFIX, EMBED_EXCHANGE_SEGMENT, EMBED_SESSION_TYPE, EMBED_SKEW_SECONDS, EMBED_TICKET_FIELD, EMBED_TICKET_SECONDS, EMBED_TICKET_TYPE, PROTOCOL_ID } from "../spec/src/protocol"
import type { Caller, Person } from "./auth"
import type { IdempotencyStore } from "./store"

/**
 * EMBEDDED PAGES (spec §5.1). A `url` page on the app's own site (`/embed/pipeline`) is framed by a host on another
 * site, where the app's own session cookie is a third-party cookie and never arrives. So the host, which holds the
 * viewer's token for the app, asks the app for a TICKET (the `clegra_embed` tool): one minute, signed, for one
 * page and one framing origin, used once. The host's frame POSTs it to `<embed path>/_ticket` (a form whose target
 * is the frame: the ticket is never in a URL, the history or a Referer, and the browser itself states the poster's
 * `Origin`, which must be the ticket's). The app answers with a partitioned session cookie for that page's path
 * (`Secure; HttpOnly; SameSite=None; Partitioned`: CHIPS, kept under the host's top-level site only) and a 303 to the
 * page. The page reads the caller from that cookie (`session`). Every embed response says who may frame it:
 * `Content-Security-Policy: frame-ancestors` with the hosts the app declares, never `X-Frame-Options`.
 *
 * Framework-neutral: `exchange(request)` returns a standard Response; `@clegra/sdk/next` wires it into proxy.ts.
 */

export type EmbedOptions = {
  /**
   * The hosts that may frame the embed pages (CSP `frame-ancestors` sources). Every frame up to the top-level page
   * must match one, and a ticket is issued only for a framing origin that matches one. Entries: `https://host`
   * (`:port` optional), `https://*.host` (any subdomain), `'self'` (the app's own origin), and outside production
   * `http://localhost[:port|:*]` / `http://127.0.0.1[:port|:*]`.
   */
  frameAncestors: string[]
  /**
   * The secret tickets and sessions are signed with (HMAC keys derived from it with HKDF, one per use, so a secret
   * the app also uses elsewhere stays separated). 32 characters at least. Default: `CLEGRA_EMBED_SECRET`.
   * Required: without it the ticket tool and the exchange fail with a clear `misconfigured`.
   */
  secret?: string
  /** Where the embed pages live (default `/embed`): every same-site `url` page is under it, the exchange at `<path>/_ticket`. */
  path?: string
  /** How long the session a ticket opens lives, in seconds (default 600, at most 3600). The caller's permissions are the ticket's until then. */
  sessionSeconds?: number
}

/** Who looks at an embedded page: the caller the ticket was issued to, as the app's `resolve` (or a host's token) named it. */
export type EmbedCaller = {
  readonly page: string
  /** The tenant, exactly as handlers get it (`ctx.installation`). */
  readonly installation: string
  readonly person: Person | null
  readonly permissions: ReadonlySet<string>
  can(permission: string): boolean
  readonly locale?: string
  readonly host: Caller["host"]
  /** The origin of the frame the ticket was posted from. */
  readonly origin: string
  readonly expiresAt: Date
}

/** The ticket a host posts into its frame: `<form method="post" action={action} target={frame}><input name={field} value={ticket}>`. */
export type EmbedTicket = { page: string; action: string; field: string; ticket: string; expiresAt: string }

/** Why a ticket or a request is refused: a status and a message for the person (the frame shows it). */
export class EmbedError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 405 | 500,
    readonly code: "misconfigured" | "invalid_request" | "invalid_ticket" | "wrong_origin" | "not_framed" | "not_found",
    message: string,
  ) {
    super(message)
    this.name = "EmbedError"
  }
}

type EmbedPage = { name: string; path: string }
type CallerClaim = { installation: string; person: Person | null; permissions: string[]; locale?: string; host: Caller["host"] }

const SOURCE = /^(?:'self'|https:\/\/(?:\*\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*(?::\d{1,5})?|http:\/\/(?:localhost|127\.0\.0\.1)(?::(?:\d{1,5}|\*))?)$/
const DEV_SOURCE = /^http:\/\//
const EMBED_PATH = /^(\/[a-z0-9][a-z0-9._~-]*)+$/
const CLAIM = PROTOCOL_ID

export class EmbedAuthority {
  readonly path: string
  readonly exchangePath: string
  readonly frameAncestors: readonly string[]
  readonly sessionSeconds: number
  readonly #secret: string | undefined
  readonly #store: IdempotencyStore
  readonly #pages: () => EmbedPage[]
  #keys: { ticket: Uint8Array; session: Uint8Array } | null = null

  constructor(options: EmbedOptions, store: IdempotencyStore, pages: () => EmbedPage[]) {
    const path = (options.path ?? "/embed").replace(/\/+$/, "")
    if (!EMBED_PATH.test(path)) throw new Error(`embed.path "${options.path}": a URL path like /embed (lowercase, no trailing slash)`)
    if (!Array.isArray(options.frameAncestors) || options.frameAncestors.length === 0) throw new Error("embed.frameAncestors: name the hosts that may frame the embed pages (https origins, https://*.domain, 'self')")
    for (const s of options.frameAncestors) {
      if (!SOURCE.test(s)) throw new Error(`embed.frameAncestors: "${s}" is not an origin source (https://host[:port], https://*.host, 'self', or http://localhost / http://127.0.0.1 in development)`)
      if (DEV_SOURCE.test(s) && process.env.NODE_ENV === "production") throw new Error(`embed.frameAncestors: "${s}" is a development origin; it is refused in production`)
    }
    const seconds = options.sessionSeconds ?? 600
    if (!Number.isInteger(seconds) || seconds < 60 || seconds > 3600) throw new Error("embed.sessionSeconds: whole seconds from 60 to 3600")
    this.path = path
    this.exchangePath = `${path}/${EMBED_EXCHANGE_SEGMENT}`
    this.frameAncestors = [...new Set(options.frameAncestors)]
    this.sessionSeconds = seconds
    this.#secret = options.secret ?? process.env.CLEGRA_EMBED_SECRET
    // A missing secret is said when a ticket is asked for (a build may define the app without its environment); a weak one at once.
    if (this.#secret !== undefined && this.#secret.length < 32) throw new Error("embed: the signing secret must have 32 characters at least (openssl rand -base64 32)")
    this.#store = store
    this.#pages = pages
  }

  /** The keys, derived once from the secret: a clear error without one (in development too: tickets cross processes). */
  #key(use: "ticket" | "session"): Uint8Array {
    if (!this.#keys) {
      const secret = this.#secret
      if (!secret) throw new EmbedError(500, "misconfigured", "embed: no signing secret. Set CLEGRA_EMBED_SECRET (32+ random characters: openssl rand -base64 32) or pass embed.secret to defineApp")
      const derive = (info: string) => new Uint8Array(hkdfSync("sha256", secret, `${PROTOCOL_ID}-embed`, info, 32))
      this.#keys = { ticket: derive("ticket v1"), session: derive("session v1") }
    }
    return this.#keys[use]
  }

  /** `frame-ancestors` for every embed response: the declared hosts (CSP sources), nothing else. */
  contentSecurityPolicy(): string {
    return `frame-ancestors ${this.frameAncestors.join(" ")}`
  }

  /** The headers of every embed response (pages, the exchange, its refusals). */
  headers(): Record<string, string> {
    return { "content-security-policy": this.contentSecurityPolicy(), "referrer-policy": "no-referrer" }
  }

  /** The session cookie of a page. */
  cookieName(page: string): string {
    return `${EMBED_COOKIE_PREFIX}${page}`
  }

  /** Whether `origin` (a serialized origin) may frame the pages: it matches a declared source. */
  allows(origin: string, appOrigin: string): boolean {
    const o = parseOrigin(origin)
    if (!o) return false
    return this.frameAncestors.some((s) => {
      if (s === "'self'") return origin === appOrigin
      const m = /^(https?):\/\/(\*\.)?([^:]+)(?::(\d+|\*))?$/.exec(s)
      if (!m) return false
      const [, scheme, wild, host, port] = m
      if (o.protocol !== `${scheme}:`) return false
      if (wild ? !o.hostname.endsWith(`.${host}`) : o.hostname !== host) return false
      return port === "*" || (port ?? "") === o.port
    })
  }

  #page(name: string): EmbedPage | null {
    return this.#pages().find((p) => p.name === name) ?? null
  }

  /** A ticket for `caller` to open `page` in a frame whose document has `origin` (spec §5.1). */
  async issue(caller: Caller, pageName: string, origin: string, appOrigin: string): Promise<EmbedTicket> {
    const page = this.#page(pageName)
    if (!page) throw new EmbedError(404, "not_found", `"${pageName}" is not an embed page of this app`)
    if (origin === "null") throw new EmbedError(400, "wrong_origin", "The frame has no origin (an opaque sandbox): this host can't sign the viewer in to an embedded page. Open the page in a new tab.")
    if (!parseOrigin(origin)) throw new EmbedError(400, "wrong_origin", `"${origin}" is not an origin (scheme://host[:port])`)
    if (!this.allows(origin, appOrigin)) throw new EmbedError(403, "wrong_origin", `${origin} may not frame this app's pages (embed.frameAncestors)`)
    const now = Math.floor(Date.now() / 1000)
    const claim: CallerClaim = { installation: caller.installation, person: caller.person, permissions: [...caller.permissions], ...(caller.locale ? { locale: caller.locale } : {}), host: caller.host }
    const ticket = await new SignJWT({ page: page.name, origin, [CLAIM]: claim })
      .setProtectedHeader({ alg: "HS256", typ: EMBED_TICKET_TYPE })
      .setIssuer(appOrigin)
      .setAudience(`${appOrigin}${page.path}`)
      .setSubject(caller.person?.id ?? caller.subject)
      .setJti(randomUUID())
      .setIssuedAt(now)
      .setExpirationTime(now + EMBED_TICKET_SECONDS)
      .sign(this.#key("ticket"))
    return { page: page.name, action: `${appOrigin}${this.exchangePath}`, field: EMBED_TICKET_FIELD, ticket, expiresAt: new Date((now + EMBED_TICKET_SECONDS) * 1000).toISOString() }
  }

  /**
   * `POST <embed path>/_ticket`: the ticket for a session cookie and a 303 to the page. Refused (with a page the frame
   * shows): not a POST, a request that is not a frame's (`Sec-Fetch-Dest` other than `iframe`), an `Origin` that is not
   * the ticket's, a ticket that is expired, from the future, tampered, for another app, page or origin, or used before.
   */
  async exchange(request: Request, appOrigin: string): Promise<Response> {
    try {
      return await this.#exchange(request, appOrigin)
    } catch (error) {
      if (error instanceof EmbedError) return this.refusal(error)
      throw error
    }
  }

  async #exchange(request: Request, appOrigin: string): Promise<Response> {
    if (request.method !== "POST") throw new EmbedError(405, "invalid_request", "An embed ticket is posted by the host's frame.")
    const dest = request.headers.get("sec-fetch-dest")
    if (dest !== "iframe") throw new EmbedError(403, "not_framed", "An embed ticket opens a page inside a frame only.")
    const origin = request.headers.get("origin")
    if (!origin) throw new EmbedError(403, "wrong_origin", "The request has no Origin.")
    const type = request.headers.get("content-type") ?? ""
    if (!/^(application\/x-www-form-urlencoded|multipart\/form-data)\b/i.test(type)) throw new EmbedError(400, "invalid_request", "The ticket comes in a form.")
    const value = (await request.formData()).get(EMBED_TICKET_FIELD)
    if (typeof value !== "string" || !value) throw new EmbedError(400, "invalid_request", "The form has no ticket.")

    let payload: JWTPayload & { page?: unknown; origin?: unknown; [CLAIM]?: unknown }
    try {
      ;({ payload } = await jwtVerify(value, this.#key("ticket"), { algorithms: ["HS256"], typ: EMBED_TICKET_TYPE, issuer: appOrigin, clockTolerance: EMBED_SKEW_SECONDS, requiredClaims: ["exp", "iat", "jti", "aud"] }))
    } catch (error) {
      if (error instanceof EmbedError) throw error
      const expired = (error as { code?: string }).code === "ERR_JWT_EXPIRED"
      throw new EmbedError(401, "invalid_ticket", expired ? "The embed ticket has expired: open the page again from the host." : "The embed ticket is not valid.")
    }
    const now = Math.floor(Date.now() / 1000)
    if (payload.iat! > now + EMBED_SKEW_SECONDS || payload.exp! - payload.iat! > EMBED_TICKET_SECONDS) throw new EmbedError(401, "invalid_ticket", "The embed ticket is not valid (its times).")
    const page = typeof payload.page === "string" ? this.#page(payload.page) : null
    if (!page || payload.aud !== `${appOrigin}${page.path}`) throw new EmbedError(401, "invalid_ticket", "The embed ticket is for another page.")
    if (typeof payload.origin !== "string" || payload.origin !== origin) throw new EmbedError(403, "wrong_origin", "The embed ticket was issued for another frame.")
    if (!this.allows(origin, appOrigin)) throw new EmbedError(403, "wrong_origin", `${origin} may not frame this app's pages.`)
    const claim = callerClaim(payload[CLAIM])
    if (!claim) throw new EmbedError(401, "invalid_ticket", "The embed ticket is not valid.")
    if (!(await this.#store.once(`embed:${payload.jti}`, (payload.exp! - now + EMBED_SKEW_SECONDS + 1) * 1000))) throw new EmbedError(401, "invalid_ticket", "The embed ticket was already used: open the page again from the host.")

    const session = await new SignJWT({ page: page.name, origin, [CLAIM]: claim })
      .setProtectedHeader({ alg: "HS256", typ: EMBED_SESSION_TYPE })
      .setIssuer(appOrigin)
      .setAudience(`${appOrigin}${page.path}`)
      .setSubject(String(payload.sub ?? ""))
      .setIssuedAt(now)
      .setExpirationTime(now + this.sessionSeconds)
      .sign(this.#key("session"))
    const headers = new Headers({ ...this.headers(), "cache-control": "no-store", location: `${appOrigin}${page.path}` })
    headers.append("set-cookie", `${this.cookieName(page.name)}=${session}; Path=${page.path}; Max-Age=${this.sessionSeconds}; Secure; HttpOnly; SameSite=None; Partitioned`)
    return new Response(null, { status: 303, headers })
  }

  /** What a refused embed request answers: a short page the frame shows, framable by the declared hosts. */
  refusal(error: EmbedError): Response {
    const text = error.message.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!)
    return new Response(`<!doctype html><meta charset="utf-8"><title>Embedded page</title><p style="font:14px system-ui;margin:16px" data-embed-error="${error.code}">${text}</p>`, {
      status: error.status,
      headers: { ...this.headers(), "cache-control": "no-store", "content-type": "text/html; charset=utf-8" },
    })
  }

  /**
   * The caller of an embedded page, from its session cookie: null when there is none, it expired, it is for another
   * page or app, or the request is a top-level navigation (`Sec-Fetch-Dest: document`: the session is for frames).
   */
  async session(pageName: string, cookie: string | undefined, fetchDest: string | null, appOrigin: string): Promise<EmbedCaller | null> {
    if (!cookie || fetchDest === "document") return null
    const page = this.#page(pageName)
    if (!page) throw new Error(`embed: "${pageName}" is not an embed page of this app (a same-site url page under ${this.path})`)
    let payload: JWTPayload & { page?: unknown; origin?: unknown; [CLAIM]?: unknown }
    try {
      ;({ payload } = await jwtVerify(cookie, this.#key("session"), { algorithms: ["HS256"], typ: EMBED_SESSION_TYPE, issuer: appOrigin, audience: `${appOrigin}${page.path}`, clockTolerance: EMBED_SKEW_SECONDS, requiredClaims: ["exp", "iat"] }))
    } catch (error) {
      if (error instanceof EmbedError) throw error
      return null
    }
    const claim = callerClaim(payload[CLAIM])
    if (payload.page !== page.name || typeof payload.origin !== "string" || !this.allows(payload.origin, appOrigin) || !claim) return null
    const permissions: ReadonlySet<string> = new Set(claim.permissions)
    return {
      page: page.name,
      installation: claim.installation,
      person: claim.person,
      permissions,
      can: (p) => permissions.has(p),
      ...(claim.locale ? { locale: claim.locale } : {}),
      host: claim.host,
      origin: payload.origin,
      expiresAt: new Date(payload.exp! * 1000),
    }
  }
}

/** `scheme://host[:port]` exactly as a browser serializes an origin (lowercase, no default port, no path), else null. */
function parseOrigin(value: string): URL | null {
  if (!URL.canParse(value)) return null
  const url = new URL(value)
  if (!/^https?:$/.test(url.protocol) || url.origin !== value) return null
  return url
}

function callerClaim(value: unknown): CallerClaim | null {
  if (!value || typeof value !== "object") return null
  const c = value as Record<string, unknown>
  if (typeof c.installation !== "string" || !Array.isArray(c.permissions) || !c.permissions.every((p) => typeof p === "string")) return null
  if (c.host !== "plain" && c.host !== "workspace") return null
  const person = c.person && typeof c.person === "object" && typeof (c.person as Person).id === "string" && typeof (c.person as Person).name === "string" ? { id: (c.person as Person).id, name: (c.person as Person).name } : null
  return { installation: c.installation, person, permissions: c.permissions as string[], ...(typeof c.locale === "string" ? { locale: c.locale } : {}), host: c.host }
}
