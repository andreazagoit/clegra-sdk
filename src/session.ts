import { z } from "zod"

import { AccessLog, Revocations, SCOPES } from "./access"
import { base64url, randomToken, sameText, sha256 } from "./crypto"
import type { Context, Grant, Person } from "./define"
import type { SessionReader } from "./confirm"
import { readCookie, secureContext } from "./signin/cookies"
import { escapeHtml, hidden, page, pageLocale, type PageLocale } from "./signin/pages"
import type { Store } from "./store"

/**
 * SESSION TRANSFER (profile). The person signed in once, in the system browser, when they connected the app to a
 * client; a client that opens a page of the app in a browser context of its own first gets a session there from the
 * grant, with a one-time code. Two modes: the strong one (`create_bound_browser_session`, hidden from models, with a
 * required `challenge` whose verifier is posted on redeem) and, when the app offers it, the Clerk-compatible one
 * (`create_browser_session`: a one-time link through the model, always through the interstitial).
 *
 * The browser gets a **transferred session**: the SDK's own cookie, distinct from the app's session, short (1 hour idle,
 * 8 hours at most), with the grant's scopes, ended when the grant is revoked (SES-6). `served.session(request)` gives
 * the app's pages either session.
 */

export const SESSION_PATH = "/session-transfer/"
export const SIGN_OUT_PATH = "/session-transfer/sign-out"
export const REVISION = "0.3"
export const MARKER = "com.clegra/session-transfer"
const BOUND_SECONDS = 60
const LINK_SECONDS = 300
const IDLE_SECONDS = 3600
const MAX_SECONDS = 8 * 3600
const COOKIE = "clegra-transferred"

type Code = { grant: string; clientId: string; clientName: string | null; person: Person; scopes: string[]; target: string; challenge: string | null; mode: "bound" | "link"; issuedAt: string; expires: number; nonce: string }
type Transferred = { person: Person; grant: string; clientId: string; clientName: string | null; scopes: string[]; created: number; seen: number }

/** A page's session: the app's own (from the person's credentials) or a transferred one. */
export type PageSession = { person: Person; transferred: null } | { person: Person; transferred: { grant: string; clientId: string; clientName: string | null; scopes: string[] } }

const TEXT = {
  en: {
    title: "Open the app signed in",
    entering: (who: string, client: string, at: string) => `You are entering as ${who} through ${client}, started at ${at}.`,
    continue: "Continue",
    notMe: "This is not me",
    other: (name: string) => `This browser is signed in as ${name}. Sign out first if you want to enter as someone else.`,
    signOut: "Sign out",
    gone: "This link has expired or was already used.",
    boundOnly: "This link opens only in the app that asked for it. Open the page again from there.",
    notMeDone: "The link was cancelled. If you did not ask for it, revoke the client's access on the app's access page.",
    banner: (who: string, client: string) => `Signed in as ${who} through ${client}.`,
  },
  it: {
    title: "Apri l'app con l'accesso",
    entering: (who: string, client: string, at: string) => `Stai entrando come ${who} tramite ${client}, alle ${at}.`,
    continue: "Continua",
    notMe: "Non sono io",
    other: (name: string) => `In questo browser è entrato ${name}. Esci prima, se vuoi entrare come un'altra persona.`,
    signOut: "Esci",
    gone: "Questo link è scaduto o è già stato usato.",
    boundOnly: "Questo link si apre solo nell'app che l'ha chiesto. Riapri la pagina da lì.",
    notMeDone: "Il link è stato annullato. Se non l'hai chiesto tu, revoca l'accesso del client nella pagina degli accessi dell'app.",
    banner: (who: string, client: string) => `Accesso come ${who} tramite ${client}.`,
  },
} satisfies Record<PageLocale, Record<string, unknown>>

export const boundTool = {
  name: "create_bound_browser_session",
  title: "Open the app signed in",
  description: "Returns a one-time code URL that the client redeems with its verifier in its own browser context. For clients that follow the session-transfer profile; never for models.",
  input: z.strictObject({ target: z.string().url().regex(/^https?:\/\//), challenge: z.string().length(43) }),
}

export const linkTool = {
  name: "create_browser_session",
  title: "Open the app signed in",
  description: "Returns a one-time link that opens this app in the browser, signed in as the current user. Give the link only to the user.",
  input: z.strictObject({ target: z.string().url().regex(/^https?:\/\//) }),
}

export const sessionOutput = z.object({ url: z.string(), expiresAt: z.string() })

export class SessionTransfer {
  readonly #store: Store
  readonly #log: AccessLog
  readonly #revocations: Revocations
  readonly #origin: () => string
  readonly #clientOrigins: () => string[]
  readonly #sessions: SessionReader | undefined
  readonly #locale: string

  constructor(input: { store: Store; log: AccessLog; revocations: Revocations; origin: () => string; clientOrigins: () => string[]; sessions: SessionReader | undefined; locale: string }) {
    this.#store = input.store
    this.#log = input.log
    this.#revocations = input.revocations
    this.#origin = input.origin
    this.#clientOrigins = input.clientOrigins
    this.#sessions = input.sessions
    this.#locale = input.locale
  }

  /** https, or a loopback host outside production (`secureContext`): the cookie can be `Secure`, partitioned in a frame. */
  #secure(): boolean {
    return secureContext(this.#origin())
  }

  #cookieName(): string {
    return this.#secure() ? `__Host-${COOKIE}` : COOKIE
  }

  /** Issues a code (SES-2, SES-14). Throws a message for the tool error when the call is refused. */
  async issue(mode: "bound" | "link", args: { target: string; challenge?: string }, ctx: Context): Promise<{ url: string; expiresAt: string }> {
    let target: URL
    try {
      target = new URL(args.target)
    } catch {
      throw new Error("target is not a URL")
    }
    if (target.origin !== this.#origin()) throw new Error(`target must be a page of the app (${this.#origin()})`)
    if (mode === "bound" && !/^[A-Za-z0-9_-]{43}$/.test(args.challenge ?? "")) throw new Error("challenge is required: the base64url SHA-256 of a verifier (43 characters)")
    const code = randomToken(32)
    const seconds = mode === "bound" ? BOUND_SECONDS : LINK_SECONDS
    const expires = Date.now() + seconds * 1000
    const row: Code = { grant: ctx.grant.id, clientId: ctx.grant.clientId, clientName: ctx.grant.clientName ?? null, person: ctx.person, scopes: [...ctx.grant.scopes], target: target.toString(), challenge: mode === "bound" ? args.challenge! : null, mode, issuedAt: new Date().toISOString(), expires, nonce: randomToken(16) }
    await this.#store.set(`stc:${await sha256(code)}`, row, seconds)
    await this.#log.write({ person: ctx.person.id, grant: ctx.grant.id, client: ctx.grant.clientId, kind: "session-transfer", outcome: `issued (${mode})`, target: row.target })
    return { url: `${this.#origin()}${SESSION_PATH}${code}`, expiresAt: new Date(expires).toISOString() }
  }

  /** The page's session: the app's own first, else a live transferred one (SES-6.4, SES-6.5). */
  async session(request: Request): Promise<PageSession | null> {
    const own = this.#sessions ? await this.#sessions.read(request) : null
    if (own) return { person: own, transferred: null }
    const t = await this.#transferred(request)
    return t ? { person: t.person, transferred: { grant: t.grant, clientId: t.clientId, clientName: t.clientName, scopes: t.scopes } } : null
  }

  async hasTransferred(request: Request): Promise<boolean> {
    return (await this.#transferred(request)) !== null
  }

  async #transferred(request: Request): Promise<Transferred | null> {
    const token = readCookie(request, this.#cookieName())
    if (!token || !/^[A-Za-z0-9_-]{20,128}$/.test(token)) return null
    const key = `sts:${await sha256(token)}`
    const t = await this.#store.get<Transferred>(key)
    if (!t) return null
    const now = Date.now()
    if (now - t.seen > IDLE_SECONDS * 1000 || now - t.created > MAX_SECONDS * 1000 || (await this.#revocations.revoked(t.grant))) {
      await this.#store.delete(key)
      return null
    }
    if (now - t.seen > 60_000) {
      const left = Math.ceil(Math.min(IDLE_SECONDS * 1000, t.created + MAX_SECONDS * 1000 - now) / 1000)
      await this.#store.set(key, { ...t, seen: now }, Math.max(1, left))
    }
    return t
  }

  /** A transferred session's banner (SES-5: who is signed in and through which client, sign-out one touch away). */
  banner(session: PageSession, request: Request): string {
    if (!session.transferred) return ""
    const t = TEXT[pageLocale(request, null, this.#locale)]
    const client = session.transferred.clientName ?? hostOf(session.transferred.clientId)
    return `<div role="status" style="padding:8px 12px;border-bottom:1px solid #d2d2d7;font:13px system-ui;display:flex;gap:12px;align-items:center"><span>${escapeHtml(t.banner(session.person.name, client))}</span><form method="post" action="${SIGN_OUT_PATH}" style="margin:0"><button style="font:inherit">${t.signOut}</button></form></div>`
  }

  #initiatorAllowed(request: Request): boolean {
    const origin = request.headers.get("origin")
    const site = request.headers.get("sec-fetch-site")
    if (origin && origin !== "null") return origin === this.#origin() || this.#clientOrigins().includes(origin)
    return !site || site === "same-origin" || site === "none"
  }

  /** `GET`/`POST /session-transfer/<code>` and the sign-out. */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const lang = pageLocale(request, null, this.#locale)
    const t = TEXT[lang]
    const show = (body: string, status = 200, frame = false) => page({ title: t.title, body, locale: lang, status, frameAncestors: frame ? this.#clientOrigins() : [] })
    if (url.pathname === SIGN_OUT_PATH) {
      if (request.method !== "POST" || !this.#initiatorAllowed(request)) return new Response(null, { status: 405 })
      const token = readCookie(request, this.#cookieName())
      if (token) await this.#store.delete(`sts:${await sha256(token)}`)
      return new Response(null, { status: 303, headers: { location: "/", "set-cookie": this.#cookie("", 0, request), "cache-control": "no-store" } })
    }
    const code = url.pathname.slice(SESSION_PATH.length)
    if (!/^[A-Za-z0-9_-]{43}$/.test(code)) return show(`<p>${t.gone}</p>`, 404)
    const key = `stc:${await sha256(code)}`
    const headers = { "cache-control": "no-store", "referrer-policy": "no-referrer" }
    if (request.method === "GET") {
      const row = await this.#store.get<Code>(key)
      if (!row) return show(`<h1>${t.title}</h1><p>${t.gone}</p>`, 410)
      // SES-2/SES-3: a strong-mode code redeems only by a POST with its verifier. A GET offers no way in (no form,
      // no nonce) and leaves the code to the client that holds the verifier.
      if (row.mode === "bound") return show(`<h1>${t.title}</h1><p>${t.boundOnly}</p>`, 400)
      // SES-4: a bare GET never creates a session: the interstitial first.
      const at = new Date(row.issuedAt).toLocaleTimeString(lang === "it" ? "it-IT" : "en-GB", { hour: "2-digit", minute: "2-digit" })
      const client = row.clientName ?? hostOf(row.clientId)
      return show(
        `<h1>${t.title}</h1><p>${escapeHtml(t.entering(row.person.name, client, at))}</p>` +
          `<div class="b"><form method="post">${hidden({ decision: "continue", nonce: row.nonce })}<button class="p">${t.continue}</button></form>` +
          `<form method="post">${hidden({ decision: "not-me", nonce: row.nonce })}<button>${t.notMe}</button></form></div>`,
        200,
        true,
      )
    }
    if (request.method !== "POST") return new Response(null, { status: 405 })
    if (!this.#initiatorAllowed(request)) return show(`<p>${t.gone}</p>`, 403)
    // A POST with no form (or not a form) is a redeem without a verifier: refused like one, never a 500.
    const form = await request.formData().catch(() => new FormData())
    const verifier = form.get("verifier")
    const decision = form.get("decision")
    const row = await this.#store.take<Code>(key)
    if (!row || row.expires <= Date.now()) return show(`<h1>${t.title}</h1><p>${t.gone}</p>`, 410)
    const restore = async () => this.#store.set(key, row, Math.max(1, Math.ceil((row.expires - Date.now()) / 1000)))
    if (row.mode === "bound") {
      // SES-2/SES-3: the strong mode redeems only with the verifier of its challenge, never through an interstitial.
      // The code is already taken: a missing or wrong verifier burns it, so there is no second guess.
      if (typeof verifier !== "string" || verifier === "" || !row.challenge) return show(`<p>${t.gone}</p>`, 400)
      const digest = base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))))
      if (!sameText(digest, row.challenge)) return show(`<p>${t.gone}</p>`, 400)
    } else {
      // SES-4/SES-15: the link mode only through the interstitial, the page's own form with its nonce.
      if (typeof verifier === "string" || typeof decision !== "string" || form.get("nonce") !== row.nonce) {
        await restore()
        return show(`<p>${t.gone}</p>`, 400)
      }
      if (decision === "not-me") {
        await this.#log.write({ person: row.person.id, grant: row.grant, client: row.clientId, kind: "session-transfer", outcome: "refused by the person (not me)", target: row.target })
        return show(`<h1>${t.title}</h1><p>${t.notMeDone}</p>`)
      }
      if (decision !== "continue") {
        await restore()
        return show(`<p>${t.gone}</p>`, 400)
      }
    }
    if (await this.#revocations.revoked(row.grant)) return show(`<p>${t.gone}</p>`, 410)
    // SES-5: never over someone else; the same person's session is kept.
    const current = await this.session(request)
    if (current && current.person.id !== row.person.id) {
      await restore()
      return show(`<h1>${t.title}</h1><p>${escapeHtml(t.other(current.person.name))}</p>${current.transferred ? `<form method="post" action="${SIGN_OUT_PATH}"><button>${t.signOut}</button></form>` : ""}`, 409)
    }
    await this.#log.write({ person: row.person.id, grant: row.grant, client: row.clientId, kind: "session-transfer", outcome: `redeemed (${row.mode})${current ? ", session kept" : ""}`, target: row.target })
    if (current) return new Response(null, { status: 303, headers: { ...headers, location: row.target } })
    const token = randomToken(32)
    const now = Date.now()
    await this.#store.set(`sts:${await sha256(token)}`, { person: row.person, grant: row.grant, clientId: row.clientId, clientName: row.clientName, scopes: row.scopes, created: now, seen: now } satisfies Transferred, IDLE_SECONDS)
    return new Response(null, { status: 303, headers: { ...headers, location: row.target, "set-cookie": this.#cookie(token, MAX_SECONDS, request) } })
  }

  #cookie(value: string, maxAge: number, request: Request): string {
    const framed = request.headers.get("sec-fetch-dest") === "iframe"
    const attrs = this.#secure() ? `; Secure; ${framed ? "SameSite=None; Partitioned" : "SameSite=Lax"}` : "; SameSite=Lax"
    return `${this.#cookieName()}=${value}; Path=/; HttpOnly; Max-Age=${maxAge}${attrs}`
  }
}

/** Whether the grant may use a mode's tool (SES-1, SES-13): each mode needs its own scope, implied by no other. */
export const modeScope = (mode: "bound" | "link") => (mode === "bound" ? SCOPES.boundBrowserSession : SCOPES.browserSession)

export const hasModeScope = (grant: Grant, mode: "bound" | "link") => grant.scopes.includes(modeScope(mode))

function hostOf(clientId: string): string {
  try {
    return new URL(clientId).host
  } catch {
    return clientId
  }
}
