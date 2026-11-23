import { createHash, hkdfSync, randomUUID } from "node:crypto"

import { jwtVerify, SignJWT, type JWTPayload } from "jose"

import {
  PROTOCOL_ID,
  SITE_CONTEXT_PATH,
  SITE_COOKIE,
  SITE_MARKER_COOKIE,
  SITE_MARKER_SECONDS,
  SITE_MESSAGES,
  SITE_PATH,
  SITE_RENEWED_PATH,
  SITE_SESSION_PATH,
  SITE_SESSION_TYPE,
  SITE_SKEW_SECONDS,
  SITE_TICKET_FIELD,
  SITE_TICKET_SECONDS,
  SITE_TICKET_TYPE,
} from "../spec/src/protocol"
import type { Person } from "./auth"
import { isClientOrigin } from "./clegra"
import type { IdempotencyStore } from "./store"

/**
 * THE APP'S OWN SITE (spec §5.1). A Clegra client shows an app that has a website as that website: it frames the
 * app's real pages at the app's own origin, the person signed in without a word. The client, holding the person's
 * app token, asks for a TICKET (`clegra_site`): one minute, signed, for one path and one client origin, used once.
 * The client's frame POSTs it to `/clegra/site` (a form whose target is the frame: the ticket is never in a URL, the
 * history or a Referer, and the browser itself states the poster's `Origin`). The app answers with a partitioned
 * session cookie for the whole site (`Path=/; Secure; HttpOnly; SameSite=None; Partitioned`: CHIPS, kept under the
 * client's top-level site only), a marker cookie saying the partition is a Clegra client's, and a 303 to the path.
 * Every page then reads the caller from that cookie (`getClegraCaller`), and is framable by the session's origin only.
 *
 * Framework-neutral: everything takes a standard Request and answers a standard Response; `@clegra/sdk/next` wires
 * the framing into proxy.ts (`siteProxy`) and reads the caller in pages (`getClegraCaller`).
 */

export type SiteOptions = {
  /** Where the site opens (default `/`). */
  start?: string
  /**
   * The secret tickets and sessions are signed with (HMAC keys derived from it with HKDF, one per use, so a secret
   * the app also uses elsewhere stays separated). 32 characters at least. Default: `CLEGRA_SITE_SECRET`.
   * Required: without it the ticket tool and the exchange fail with a clear `misconfigured`.
   */
  secret?: string
  /** How long the session a ticket opens lives, in seconds (default 600, 120 to 3600). The client renews it before. */
  sessionSeconds?: number
}

export type SiteTheme = "light" | "dark"

/** Who looks at the site in a Clegra client: the person the ticket was issued to, as the app's roles name them. */
export type SiteCaller = {
  /** The tenant, exactly as handlers get it (`ctx.installation`). */
  readonly installation: string
  readonly person: Person | null
  readonly email: string | null
  readonly permissions: ReadonlySet<string>
  can(permission: string): boolean
  /** An administrator inside the app (spec §7, «Roles»). */
  readonly admin: boolean
  readonly locale?: string
  readonly theme?: SiteTheme
  /** The client origin that frames the site. */
  readonly origin: string
  readonly issuedAt: Date
  readonly expiresAt: Date
}

/** The ticket a client posts into its frame: `<form method="post" action={action} target={frame}><input name={field} value={ticket}>`. */
export type SiteTicket = { path: string; action: string; field: string; ticket: string; expiresAt: string; sessionSeconds: number }

/** What a ticket carries of the caller (the `clegra` claim). */
export type SiteClaim = { installation: string; person: Person | null; email: string | null; permissions: string[]; admin: boolean; locale?: string; theme?: SiteTheme }

/** Why a ticket or a request is refused: a status and a message for the person (the frame shows it). */
export class SiteError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 405 | 500,
    readonly code: "misconfigured" | "invalid_request" | "invalid_ticket" | "wrong_origin" | "not_framed",
    message: string,
  ) {
    super(message)
    this.name = "SiteError"
  }
}

const CLAIM = PROTOCOL_ID
const LOCALE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/
/** A path on the app's own origin: `/`, then no `//`, `\`, spaces or controls; a query and a fragment allowed. */
const PATH = /^\/(?!\/)[^\s\\\u0000-\u001f\u007f]*$/

/** Whether `path` may be a site path (spec §5.1 step 2). */
export function isSitePath(path: unknown): path is string {
  if (typeof path !== "string" || path.length > 2048 || !PATH.test(path)) return false
  const pathname = path.split(/[?#]/)[0]!
  return pathname !== SITE_PATH && !pathname.startsWith(`${SITE_PATH}/`) && !pathname.startsWith(`/${PROTOCOL_ID}/`)
}

const themeOf = (value: unknown): SiteTheme | undefined => (value === "light" || value === "dark" ? value : undefined)
const localeOf = (value: unknown): string | undefined => (typeof value === "string" && value.length <= 35 && LOCALE.test(value) ? value : undefined)

const escapeHtml = (text: string) => text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!)

/** A cookie of the request by name. */
export function cookieOf(request: Request, name: string): string | undefined {
  const header = request.headers.get("cookie") ?? ""
  return header
    .split(/;\s*/)
    .find((c) => c.startsWith(`${name}=`))
    ?.slice(name.length + 1)
}

export class SiteAuthority {
  readonly start: string
  readonly sessionSeconds: number
  readonly #clientOrigins: () => readonly string[]
  readonly #secret: string | undefined
  readonly #store: IdempotencyStore
  #keys: { ticket: Uint8Array; session: Uint8Array } | null = null

  constructor(options: SiteOptions, store: IdempotencyStore, clientOrigins: () => readonly string[]) {
    const start = options.start ?? "/"
    if (!isSitePath(start)) throw new Error(`site.start "${options.start}": a path on the app's own site, like / or /dashboard`)
    const seconds = options.sessionSeconds ?? 600
    if (!Number.isInteger(seconds) || seconds < 120 || seconds > 3600) throw new Error("site.sessionSeconds: whole seconds from 120 to 3600")
    this.start = start
    this.sessionSeconds = seconds
    this.#clientOrigins = clientOrigins
    this.#secret = options.secret ?? process.env.CLEGRA_SITE_SECRET
    // A missing secret is said when a ticket is asked for (a build may define the app without its environment); a weak one at once.
    if (this.#secret !== undefined && this.#secret.length < 32) throw new Error("site: the signing secret must have 32 characters at least (openssl rand -base64 32)")
    this.#store = store
  }

  /** The keys, derived once from the secret: a clear error without one (in development too: tickets cross processes). */
  #key(use: "ticket" | "session"): Uint8Array {
    if (!this.#keys) {
      const secret = this.#secret
      if (!secret) throw new SiteError(500, "misconfigured", "site: no signing secret. Set CLEGRA_SITE_SECRET (32+ random characters: openssl rand -base64 32) or pass site.secret to defineApp")
      const derive = (info: string) => new Uint8Array(hkdfSync("sha256", secret, `${PROTOCOL_ID}-site`, info, 32))
      this.#keys = { ticket: derive("ticket v1"), session: derive("session v1") }
    }
    return this.#keys[use]
  }

  /** Whether `origin` is exactly one of the app's Clegra client origins. */
  allows(origin: string): boolean {
    return this.#clientOrigins().includes(origin)
  }

  /** A ticket for `claim` to open `path` (or only renew the session) in a frame whose document has `origin` (spec §5.1 step 2). */
  async issue(claim: SiteClaim, input: { path?: unknown; origin: unknown; renew?: boolean; subject: string }, appOrigin: string, action: string): Promise<SiteTicket> {
    const origin = String(input.origin ?? "")
    if (!isClientOrigin(origin) || !this.allows(origin)) throw new SiteError(403, "wrong_origin", `${origin || "(none)"} is not one of this app's Clegra client origins (CLEGRA_CLIENT_ORIGINS)`)
    const path = input.renew ? SITE_RENEWED_PATH : input.path === undefined || input.path === "" ? this.start : input.path
    if (!input.renew && !isSitePath(path)) throw new SiteError(400, "invalid_request", `"${String(path)}" is not a path of this site (/…, no //, \\ or spaces, not under /clegra/)`)
    const now = Math.floor(Date.now() / 1000)
    const ticket = await new SignJWT({ path, origin, [CLAIM]: claim })
      .setProtectedHeader({ alg: "HS256", typ: SITE_TICKET_TYPE })
      .setIssuer(appOrigin)
      .setAudience(appOrigin)
      .setSubject(input.subject)
      .setJti(randomUUID())
      .setIssuedAt(now)
      .setExpirationTime(now + SITE_TICKET_SECONDS)
      .sign(this.#key("ticket"))
    return { path: String(path), action, field: SITE_TICKET_FIELD, ticket, expiresAt: new Date((now + SITE_TICKET_SECONDS) * 1000).toISOString(), sessionSeconds: this.sessionSeconds }
  }

  /**
   * `POST /clegra/site`: the ticket for the session cookies and a 303 to the path. Refused (with a page the frame
   * shows): not a POST, a request that is not a frame's (`Sec-Fetch-Dest` other than `iframe`), an `Origin` that is not
   * the ticket's, a ticket that is expired, from the future, tampered, for another app, or used before.
   */
  async exchange(request: Request, appOrigin: string): Promise<Response> {
    try {
      return await this.#exchange(request, appOrigin)
    } catch (error) {
      if (error instanceof SiteError) return this.refusal(error)
      throw error
    }
  }

  async #exchange(request: Request, appOrigin: string): Promise<Response> {
    if (request.method !== "POST") throw new SiteError(405, "invalid_request", "A site ticket is posted by the Clegra client's frame.")
    if (request.headers.get("sec-fetch-dest") !== "iframe") throw new SiteError(403, "not_framed", "A site ticket opens the site inside a frame only.")
    const origin = request.headers.get("origin")
    if (!origin) throw new SiteError(403, "wrong_origin", "The request has no Origin.")
    const type = request.headers.get("content-type") ?? ""
    if (!/^(application\/x-www-form-urlencoded|multipart\/form-data)\b/i.test(type)) throw new SiteError(400, "invalid_request", "The ticket comes in a form.")
    const value = (await request.formData()).get(SITE_TICKET_FIELD)
    if (typeof value !== "string" || !value) throw new SiteError(400, "invalid_request", "The form has no ticket.")

    let payload: JWTPayload & { path?: unknown; origin?: unknown; [CLAIM]?: unknown }
    try {
      ;({ payload } = await jwtVerify(value, this.#key("ticket"), { algorithms: ["HS256"], typ: SITE_TICKET_TYPE, issuer: appOrigin, audience: appOrigin, clockTolerance: SITE_SKEW_SECONDS, requiredClaims: ["exp", "iat", "jti", "aud"] }))
    } catch (error) {
      if (error instanceof SiteError) throw error
      const expired = (error as { code?: string }).code === "ERR_JWT_EXPIRED"
      throw new SiteError(401, "invalid_ticket", expired ? "The site ticket has expired: open the app again in Clegra." : "The site ticket is not valid.")
    }
    const now = Math.floor(Date.now() / 1000)
    if (payload.iat! > now + SITE_SKEW_SECONDS || payload.exp! - payload.iat! > SITE_TICKET_SECONDS) throw new SiteError(401, "invalid_ticket", "The site ticket is not valid (its times).")
    const path = payload.path
    if (typeof path !== "string" || (path !== SITE_RENEWED_PATH && !isSitePath(path))) throw new SiteError(401, "invalid_ticket", "The site ticket is not valid (its path).")
    if (typeof payload.origin !== "string" || payload.origin !== origin) throw new SiteError(403, "wrong_origin", "The site ticket was issued for another frame.")
    if (!this.allows(origin)) throw new SiteError(403, "wrong_origin", `${origin} is no longer one of this app's Clegra clients.`)
    const claim = siteClaim(payload[CLAIM])
    if (!claim) throw new SiteError(401, "invalid_ticket", "The site ticket is not valid.")
    if (!(await this.#store.once(`site:${payload.jti}`, (payload.exp! - now + SITE_SKEW_SECONDS + 1) * 1000))) throw new SiteError(401, "invalid_ticket", "The site ticket was already used: open the app again in Clegra.")

    const session = await this.#session(claim, origin, String(payload.sub ?? ""), now, now + this.sessionSeconds, appOrigin)
    const target = new URL(path, appOrigin)
    if (target.origin !== appOrigin) throw new SiteError(401, "invalid_ticket", "The site ticket is not valid (its path).")
    const headers = new Headers({ ...this.headers(origin), location: target.href })
    headers.append("set-cookie", this.#cookie(SITE_COOKIE, session, this.sessionSeconds))
    headers.append("set-cookie", this.#cookie(SITE_MARKER_COOKIE, encodeURIComponent(origin), SITE_MARKER_SECONDS))
    return new Response(null, { status: 303, headers })
  }

  #cookie(name: string, value: string, maxAge: number): string {
    return `${name}=${value}; Path=/; Max-Age=${maxAge}; Secure; HttpOnly; SameSite=None; Partitioned`
  }

  async #session(claim: SiteClaim, origin: string, sub: string, iat: number, exp: number, appOrigin: string): Promise<string> {
    return new SignJWT({ origin, [CLAIM]: claim })
      .setProtectedHeader({ alg: "HS256", typ: SITE_SESSION_TYPE })
      .setIssuer(appOrigin)
      .setAudience(appOrigin)
      .setSubject(sub)
      .setIssuedAt(iat)
      .setExpirationTime(exp)
      .sign(this.#key("session"))
  }

  /** The headers of the SDK's own site responses: framable by the session's origin (or none), no referrer, never cached. */
  headers(origin: string | null): Record<string, string> {
    return { "content-security-policy": this.framing(origin), "referrer-policy": "no-referrer", "cache-control": "no-store", "x-content-type-options": "nosniff" }
  }

  /** `frame-ancestors` for a site response: `'self'` and the session's client origin; `'none'` without one. */
  framing(origin: string | null): string {
    return origin && this.allows(origin) ? `frame-ancestors 'self' ${origin}` : "frame-ancestors 'none'"
  }

  /** What a refused site request answers: a short page the frame shows. */
  refusal(error: SiteError, origin: string | null = null): Response {
    return new Response(`<!doctype html><meta charset="utf-8"><title>Clegra</title><p style="font:14px system-ui;margin:16px" data-site-error="${error.code}">${escapeHtml(error.message)}</p>`, {
      status: error.status,
      headers: { ...this.headers(origin), "content-type": "text/html; charset=utf-8" },
    })
  }

  /** The session of a request, verified (signature, times, a client origin); null without one. Revocation is the caller's (the server's). */
  async session(request: Request, appOrigin: string): Promise<{ claim: SiteClaim; origin: string; sub: string; iat: number; exp: number } | null> {
    const cookie = cookieOf(request, SITE_COOKIE)
    if (!cookie) return null
    let payload: JWTPayload & { origin?: unknown; [CLAIM]?: unknown }
    try {
      ;({ payload } = await jwtVerify(cookie, this.#key("session"), { algorithms: ["HS256"], typ: SITE_SESSION_TYPE, issuer: appOrigin, audience: appOrigin, clockTolerance: SITE_SKEW_SECONDS, requiredClaims: ["exp", "iat"] }))
    } catch (error) {
      if (error instanceof SiteError) throw error
      return null
    }
    const claim = siteClaim(payload[CLAIM])
    if (typeof payload.origin !== "string" || !this.allows(payload.origin) || !claim) return null
    return { claim, origin: payload.origin, sub: String(payload.sub ?? ""), iat: payload.iat!, exp: payload.exp! }
  }

  /** The marker's origin (the partition is a Clegra client's), when it is still one of the client origins. */
  marker(request: Request): string | null {
    const raw = cookieOf(request, SITE_MARKER_COOKIE)
    if (!raw) return null
    let origin: string
    try {
      origin = decodeURIComponent(raw)
    } catch {
      return null
    }
    return this.allows(origin) ? origin : null
  }

  /** The caller of a verified session. */
  callerOf(s: { claim: SiteClaim; origin: string; iat: number; exp: number }): SiteCaller {
    const permissions: ReadonlySet<string> = new Set(s.claim.permissions)
    return {
      installation: s.claim.installation,
      person: s.claim.person,
      email: s.claim.email,
      permissions,
      can: (p) => permissions.has(p),
      admin: s.claim.admin,
      ...(s.claim.locale ? { locale: s.claim.locale } : {}),
      ...(s.claim.theme ? { theme: s.claim.theme } : {}),
      origin: s.origin,
      issuedAt: new Date(s.iat * 1000),
      expiresAt: new Date(s.exp * 1000),
    }
  }

  /** `GET /clegra/site/session`: what the bridge needs (origin, end, theme, locale), `204` without a session. */
  async sessionInfo(request: Request, appOrigin: string, live: (s: { claim: SiteClaim; iat: number }) => Promise<boolean>): Promise<Response> {
    const s = request.method === "GET" ? await this.session(request, appOrigin) : null
    if (!s || !(await live(s))) return new Response(null, { status: request.method === "GET" ? 204 : 405, headers: this.headers(null) })
    const body = { origin: s.origin, expiresAt: new Date(s.exp * 1000).toISOString(), ...(s.claim.theme ? { theme: s.claim.theme } : {}), ...(s.claim.locale ? { locale: s.claim.locale } : {}) }
    return new Response(JSON.stringify(body), { status: 200, headers: { ...this.headers(null), "content-type": "application/json" } })
  }

  /** `POST /clegra/site/context` `{ theme?, locale? }` from the site itself: the session signed again with them (same end). */
  async context(request: Request, appOrigin: string): Promise<Response> {
    const plain = (status: number, text: string) => new Response(text, { status, headers: { ...this.headers(null), "content-type": "text/plain; charset=utf-8" } })
    if (request.method !== "POST") return plain(405, "POST only")
    if (request.headers.get("origin") !== appOrigin) return plain(403, "Only the site itself keeps its context.")
    if (!/^application\/json\b/i.test(request.headers.get("content-type") ?? "")) return plain(400, "A JSON body.")
    const s = await this.session(request, appOrigin)
    if (!s) return plain(401, "No Clegra session.")
    let body: Record<string, unknown>
    try {
      body = (await request.json()) as Record<string, unknown>
    } catch {
      return plain(400, "A JSON body.")
    }
    if (!body || typeof body !== "object") return plain(400, "A JSON body.")
    const theme = body.theme === undefined ? s.claim.theme : themeOf(body.theme)
    const locale = body.locale === undefined ? s.claim.locale : localeOf(body.locale)
    if ((body.theme !== undefined && !theme) || (body.locale !== undefined && !locale)) return plain(400, "theme is light or dark; locale a language tag.")
    const claim: SiteClaim = { ...s.claim, ...(theme ? { theme } : {}), ...(locale ? { locale } : {}) }
    const now = Math.floor(Date.now() / 1000)
    const session = await this.#session(claim, s.origin, s.sub, s.iat, s.exp, appOrigin)
    const headers = new Headers({ ...this.headers(null) })
    headers.append("set-cookie", this.#cookie(SITE_COOKIE, session, Math.max(1, s.exp - now)))
    return new Response(null, { status: 204, headers })
  }

  /** `GET /clegra/site/renewed`: where a renewal's hidden frame lands; it tells the client the session's new end. */
  async renewed(request: Request, appOrigin: string): Promise<Response> {
    const s = await this.session(request, appOrigin)
    if (!s) return this.refusal(new SiteError(401, "invalid_ticket", "No Clegra session."))
    const script = `parent.postMessage({type:${JSON.stringify(SITE_MESSAGES.renewed)},expiresAt:${JSON.stringify(new Date(s.exp * 1000).toISOString())}},${JSON.stringify(s.origin)})`
    return this.#scriptPage("", script, s.origin)
  }

  /** The page a frame of a Clegra client gets when its session is gone (spec §5.1 step 7): it tells the client. */
  signedOut(origin: string): Response {
    const script = `parent.postMessage({type:${JSON.stringify(SITE_MESSAGES.signedOut)}},${JSON.stringify(origin)})`
    return this.#scriptPage(`<p style="font:14px system-ui;margin:16px" data-site-signed-out>Your Clegra session ended. Open the app again.</p>`, script, origin, 401)
  }

  #scriptPage(body: string, script: string, origin: string, status = 200): Response {
    const hash = createHash("sha256").update(script).digest("base64")
    return new Response(`<!doctype html><meta charset="utf-8"><title>Clegra</title>${body}<script>${script}</script>`, {
      status,
      headers: {
        ...this.headers(origin),
        "content-security-policy": `default-src 'none'; script-src 'sha256-${hash}'; ${this.framing(origin)}`,
        "content-type": "text/html; charset=utf-8",
      },
    })
  }
}

function siteClaim(value: unknown): SiteClaim | null {
  if (!value || typeof value !== "object") return null
  const c = value as Record<string, unknown>
  if (typeof c.installation !== "string" || !Array.isArray(c.permissions) || !c.permissions.every((p) => typeof p === "string")) return null
  const person = c.person && typeof c.person === "object" && typeof (c.person as Person).id === "string" && typeof (c.person as Person).name === "string" ? { id: (c.person as Person).id, name: (c.person as Person).name } : null
  const theme = themeOf(c.theme)
  const locale = localeOf(c.locale)
  return {
    installation: c.installation,
    person,
    email: typeof c.email === "string" ? c.email : null,
    permissions: c.permissions as string[],
    admin: c.admin === true,
    ...(locale ? { locale } : {}),
    ...(theme ? { theme } : {}),
  }
}

export { themeOf as siteThemeOf, localeOf as siteLocaleOf }

/**
 * The bridge (spec §5.1 step 8), served at `/clegra/site/bridge.js`: in a Clegra client's frame with a session, it
 * tells the client where the site is (`clegra/location`), applies the client's theme and locale (`clegra/context`),
 * and asks for a renewal before the session ends (`clegra/renew`). Outside a frame or without a session: nothing.
 */
export const SITE_BRIDGE_SCRIPT = `(() => {
  "use strict";
  if (window.parent === window || window.__clegraSite) return;
  window.__clegraSite = true;
  const M = ${JSON.stringify(SITE_MESSAGES)};
  fetch(${JSON.stringify(SITE_SESSION_PATH)}, { credentials: "same-origin", cache: "no-store" })
    .then((r) => (r.status === 200 ? r.json() : null))
    .then((s) => s && typeof s.origin === "string" && start(s))
    .catch(() => {});
  function start(s) {
    const origin = s.origin;
    let ends = Date.parse(s.expiresAt);
    let theme = s.theme;
    let locale = s.locale;
    const post = (m) => window.parent.postMessage(m, origin);
    const root = document.documentElement;
    // Only what differs: a page drawn in the session's theme (the caller's) is left exactly as the server sent it.
    const apply = (t) => {
      if (t !== "light" && t !== "dark") return;
      if (root.dataset.theme !== t) root.dataset.theme = t;
      if (root.classList.contains("dark") !== (t === "dark")) root.classList.toggle("dark", t === "dark");
      if (root.style.colorScheme !== t) root.style.colorScheme = t;
    };
    let last = "";
    const report = () => {
      const path = location.pathname + location.search + location.hash;
      const title = document.title;
      const key = path + "\\n" + title;
      if (key === last) return;
      last = key;
      post({ type: M.location, path, title });
    };
    for (const k of ["pushState", "replaceState"]) {
      const f = history[k];
      history[k] = function (...a) {
        const r = f.apply(this, a);
        setTimeout(report, 0);
        return r;
      };
    }
    addEventListener("popstate", report);
    addEventListener("hashchange", report);
    new MutationObserver(report).observe(document.head, { subtree: true, childList: true, characterData: true });
    let timer = 0;
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(() => post({ type: M.renew }), Math.max(5000, ends - Date.now() - 90000));
    };
    addEventListener("message", (e) => {
      if (e.source !== window.parent || e.origin !== origin) return;
      const d = e.data;
      if (!d || typeof d !== "object") return;
      if (d.type === M.renewed && typeof d.expiresAt === "string") {
        const at = Date.parse(d.expiresAt);
        if (at) ends = at;
        schedule();
        return;
      }
      if (d.type !== M.context) return;
      const next = {};
      if ((d.theme === "light" || d.theme === "dark") && d.theme !== theme) {
        apply(d.theme);
        next.theme = theme = d.theme;
      }
      const newLocale = typeof d.locale === "string" && d.locale !== locale;
      if (newLocale) next.locale = locale = d.locale;
      if (!next.theme && !next.locale) return;
      dispatchEvent(new CustomEvent("clegra:context", { detail: { theme, locale } }));
      fetch(${JSON.stringify(SITE_CONTEXT_PATH)}, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(next) })
        .then((r) => { if (r.ok && newLocale) location.reload(); })
        .catch(() => {});
    });
    apply(theme);
    report();
    schedule();
  }
})();
`
