import { randomBytes } from "node:crypto"

import { VIEW_HOST_META, VIEW_TICKET_FIELD, VIEW_TICKET_SECONDS, VIEWS_PATH } from "../spec/src/protocol"
import type { IdempotencyStore } from "./store"

/**
 * VIEWS AT THE APP'S OWN ORIGIN (spec §5.3). A Clegra client never draws an app's MCP Apps view on a page of its own:
 * it frames the view from the app itself, so the app's origin is the view's isolation boundary. The client, holding
 * the person's app token, asks the app for a VIEW TICKET (the `clegra_view` tool: one view, the framing document's
 * origin, 60 seconds, used once) and posts it into its frame with a form whose target is the frame (the ticket never
 * sits in a URL, the history or a Referer; the browser itself states the poster's `Origin`). The app answers that
 * POST with the view's document, under a policy built from what the view declares (`_meta.ui.csp`) and
 * `frame-ancestors` exactly the ticket's origin, with the framing origin in `<meta name="clegra-host">` so the view's
 * bridge posts to that origin only and listens to that origin only. The view's tool calls still go through the
 * client (MCP Apps `tools/call`): the frame never holds a token.
 */

/** What the SDK keeps of a view: its title, its document, its MCP Apps `_meta.ui` (policy, border). */
export type ViewDocument = {
  title: string
  html: () => string | Promise<string>
  ui: { csp: ViewCsp; prefersBorder?: boolean }
}

/** The domains a view declares (MCP Apps `_meta.ui.csp`). */
export type ViewCsp = { connectDomains?: string[]; resourceDomains?: string[]; frameDomains?: string[]; baseUriDomains?: string[] }

/** The ticket a client posts into its frame: `<form method="post" action={action} target={frame}><input name={field} value={ticket}>`. */
export type ViewTicket = { view: string; action: string; field: string; ticket: string; expiresAt: string }

/** What a ticket is for, as the store keeps it. */
type Held = { view: string; origin: string; tenant: string; sub: string; exp: number }

/** Why a ticket or a view request is refused: a status and a reason (plain text, for the person and the logs). */
export class ViewError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 405,
    message: string,
  ) {
    super(message)
    this.name = "ViewError"
  }
}

const SOURCE = /^https:\/\/(\*\.)?[A-Za-z0-9.-]+(:\d{1,5})?$/
/** Outside production a view may also name a loopback http origin (the app's own server while developing). */
const DEV_SOURCE = /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/

const sources = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((d): d is string => typeof d === "string" && (SOURCE.test(d) || (process.env.NODE_ENV !== "production" && DEV_SOURCE.test(d)))).slice(0, 20) : []

/**
 * The view's policy as a header: nothing but what it declares (the standard's construction for an MCP Apps view),
 * its inline scripts and styles (the SDK's views are one document), and `frame-ancestors` the one client origin the
 * ticket was for. No `X-Frame-Options`: `frame-ancestors` says who may frame it.
 */
export function viewPolicy(csp: ViewCsp, frameAncestor: string): string {
  const res = sources(csp.resourceDomains).join(" ")
  const list = (value: unknown, none = "'none'") => sources(value).join(" ") || none
  return [
    "default-src 'none'",
    `script-src 'unsafe-inline' ${res}`.trim(),
    `style-src 'unsafe-inline' ${res}`.trim(),
    `img-src data: blob: ${res}`.trim(),
    `font-src data: ${res}`.trim(),
    `media-src data: blob: ${res}`.trim(),
    `connect-src ${list(csp.connectDomains)}`,
    `frame-src ${list(csp.frameDomains)}`,
    `base-uri ${list(csp.baseUriDomains)}`,
    // A view writes through tool calls only: it posts no form anywhere.
    "form-action 'none'",
    "object-src 'none'",
    `frame-ancestors ${frameAncestor}`,
  ].join("; ")
}

const attr = (text: string) => text.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

/** The document with the framing client's origin first in its head, for the view's bridge (spec §5.3). */
export function withHost(html: string, origin: string): string {
  const meta = `<meta name="${VIEW_HOST_META}" content="${attr(origin)}">`
  return /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => m + meta) : meta + html
}

/** The view URI's path under the app's views path: `ui://<app>/pages/pipeline` → `/clegra/views/pages/pipeline`. */
export function viewPath(uri: string, app: string): string | null {
  const prefix = `ui://${app}/`
  if (!uri.startsWith(prefix)) return null
  const rest = uri.slice(prefix.length)
  return /^[A-Za-z0-9._~-]+(\/[A-Za-z0-9._~-]+)*$/.test(rest) ? `${VIEWS_PATH}/${rest}` : null
}

/** Issues and redeems view tickets: opaque, random, kept in the app's store (shared by every instance), used once. */
export class ViewTickets {
  constructor(
    private readonly store: IdempotencyStore,
    private readonly clientOrigins: () => readonly string[],
  ) {}

  /** A ticket for one view and one framing origin (a client origin, exactly), for this person of this tenant. */
  async issue(input: { view: string; origin: string; tenant: string; sub: string; action: string }): Promise<ViewTicket> {
    if (!this.clientOrigins().includes(input.origin)) throw new ViewError(403, `the origin ${input.origin} is not one of this app's Clegra client origins (CLEGRA_CLIENT_ORIGINS)`)
    const ticket = randomBytes(32).toString("base64url")
    const exp = Date.now() + VIEW_TICKET_SECONDS * 1000
    const held: Held = { view: input.view, origin: input.origin, tenant: input.tenant, sub: input.sub, exp }
    await this.store.put(`clegra:view-ticket:${ticket}`, JSON.stringify(held), VIEW_TICKET_SECONDS * 1000)
    return { view: input.view, action: input.action, field: VIEW_TICKET_FIELD, ticket, expiresAt: new Date(exp).toISOString() }
  }

  /**
   * Redeems a posted ticket for `view`: a POST from a frame (`Sec-Fetch-Dest: iframe`), its `Origin` the ticket's
   * (and still a client origin), the ticket unexpired, for this view, never used before. Returns the framing origin
   * and the person it was issued to, and when (epoch seconds). Throws ViewError.
   */
  async redeem(request: Request, view: string): Promise<{ origin: string; tenant: string; sub: string; issuedAt: number }> {
    if (request.method !== "POST") throw new ViewError(405, "a view opens with its ticket posted by the Clegra client (POST)")
    if (request.headers.get("sec-fetch-dest") !== "iframe") throw new ViewError(403, "a view opens only inside a frame")
    const origin = request.headers.get("origin") ?? ""
    if (!this.clientOrigins().includes(origin)) throw new ViewError(403, "posted from an origin that is not one of this app's Clegra clients")
    let ticket = ""
    try {
      ticket = String((await request.formData()).get(VIEW_TICKET_FIELD) ?? "")
    } catch {
      throw new ViewError(400, "the view's ticket is posted as a form")
    }
    if (!/^[A-Za-z0-9_-]{43}$/.test(ticket)) throw new ViewError(400, "no view ticket")
    const raw = await this.store.get(`clegra:view-ticket:${ticket}`)
    const held = raw ? (JSON.parse(raw) as Held) : null
    if (!held || held.exp < Date.now()) throw new ViewError(403, "the view ticket is unknown or expired")
    if (!(await this.store.once(`clegra:view-ticket-used:${ticket}`, VIEW_TICKET_SECONDS * 2000))) throw new ViewError(403, "the view ticket was already used")
    if (held.view !== view) throw new ViewError(403, "the view ticket is for another view")
    if (held.origin !== origin) throw new ViewError(403, "the view ticket is for another origin")
    return { origin, tenant: held.tenant, sub: held.sub, issuedAt: Math.floor(held.exp / 1000) - VIEW_TICKET_SECONDS }
  }
}
