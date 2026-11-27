import { isIP, isLoopback, isPublicAddress } from "./auth"
import { base64, randomToken } from "./crypto"
import type { Grant } from "./define"
import { isProduction } from "./env"
import { localize, type Label } from "./labels"
import { hostLookup } from "./platform"
import type { Store } from "./store"

/**
 * EVENT TYPES (note): `com.clegra.app.notification` and `com.clegra.app.activity`, over the Events extension
 * (`io.modelcontextprotocol/events`). The SDK offers webhook delivery (EVT-1: an app on serverless hosting cannot hold a
 * stream open): `events/list`, `events/subscribe` with a callback URL, `events/unsubscribe`; each occurrence is posted
 * signed as Standard Webhooks define (`webhook-id`, `webhook-timestamp`, `webhook-signature`).
 */

export const EVENTS_EXTENSION = "io.modelcontextprotocol/events"
export const NOTIFICATION_EVENT = "com.clegra.app.notification"
export const ACTIVITY_EVENT = "com.clegra.app.activity"

const URL_SCHEMA = { type: "string", format: "uri", pattern: "^https://" }

export const EVENT_TYPES = [
  {
    name: NOTIFICATION_EVENT,
    description: "A notification of the app that opens `url`.",
    inputSchema: { type: "object", properties: { types: { type: "array", items: { type: "string" } } } },
    payloadSchema: {
      type: "object",
      required: ["id", "type", "title", "url"],
      additionalProperties: false,
      properties: { id: { type: "string" }, type: { type: "string" }, title: { type: "string", maxLength: 120 }, body: { type: "string", maxLength: 500 }, url: URL_SCHEMA, dedupe: { type: "string" } },
    },
    delivery: ["webhook"],
  },
  {
    name: ACTIVITY_EVENT,
    description: "Something happening now in the app, kept in sight.",
    inputSchema: { type: "object", properties: {} },
    payloadSchema: {
      type: "object",
      required: ["id", "type", "title", "state"],
      additionalProperties: false,
      properties: {
        id: { type: "string" },
        type: { type: "string" },
        title: { type: "string", maxLength: 120 },
        status: { type: "string", maxLength: 120 },
        progress: { type: "number", minimum: 0, maximum: 1 },
        state: { enum: ["running", "waiting", "done", "failed", "cancelled"] },
        url: URL_SCHEMA,
        tools: { type: "array", maxItems: 3, items: { type: "string" } },
      },
    },
    delivery: ["webhook"],
  },
] as const

type Subscription = { id: string; grant: string; person: string; name: string; types: string[] | null; url: string; secret: string; locale: string; created: string }

export class EventError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message)
  }
}

const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

export class Events {
  readonly #store: Store
  readonly #fetch: typeof fetch
  readonly #origin: () => string
  readonly #types: ReadonlySet<string>
  readonly #locale: string

  constructor(input: { store: Store; fetch?: typeof fetch; origin: () => string; types: string[]; locale: string }) {
    this.#store = input.store
    this.#fetch = input.fetch ?? ((...a) => fetch(...a))
    this.#origin = input.origin
    this.#types = new Set(input.types)
    this.#locale = input.locale
  }

  async #checkCallback(raw: string): Promise<URL> {
    let url: URL
    try {
      url = new URL(raw)
    } catch {
      throw new EventError(-32602, "delivery.url is not a URL")
    }
    const local = !isProduction() && url.protocol === "http:" && isLoopback(url.hostname)
    if (url.protocol !== "https:" && !local) throw new EventError(-32602, "delivery.url must be https")
    if (local) return url
    const host = url.hostname.replace(/^\[|\]$/g, "")
    const addresses = isIP(host) ? [host] : await (hostLookup() ?? (() => Promise.reject(new EventError(-32603, "no DNS resolver: run the app under an adapter (@clegra/sdk/node, /next, /express)"))))(host)
    if (!addresses.length || !addresses.every(isPublicAddress)) throw new EventError(-32602, "delivery.url must reach a public address")
    return url
  }

  /** The Events extension's methods, answered for one grant. */
  async handle(method: string, params: Record<string, unknown>, grant: Grant, locale: string): Promise<unknown> {
    if (method === "events/list") return { events: EVENT_TYPES }
    if (method === "events/subscribe") {
      const name = String(params.name ?? "")
      if (!EVENT_TYPES.some((e) => e.name === name)) throw new EventError(-32602, `unknown event type "${name}"`)
      const delivery = (params.delivery ?? {}) as { mode?: string; url?: string; secret?: string }
      if (delivery.mode !== "webhook") throw new EventError(-32602, "only webhook delivery is offered (delivery.mode: \"webhook\")")
      const url = await this.#checkCallback(String(delivery.url ?? ""))
      const args = (params.arguments ?? {}) as { types?: unknown }
      const types = Array.isArray(args.types) ? args.types.map(String) : null
      const secret = typeof delivery.secret === "string" && delivery.secret.length >= 24 ? delivery.secret : `whsec_${randomToken(24)}`
      const sub: Subscription = { id: crypto.randomUUID(), grant: grant.id, person: grant.person.id, name, types, url: url.toString(), secret, locale, created: new Date().toISOString() }
      await this.#store.set(`evs:${sub.id}`, sub)
      return { subscriptionId: sub.id, secret }
    }
    if (method === "events/unsubscribe") {
      const id = String(params.subscriptionId ?? "")
      const sub = await this.#store.get<Subscription>(`evs:${id}`)
      if (!sub || sub.grant !== grant.id) throw new EventError(-32602, "no such subscription")
      await this.#store.delete(`evs:${id}`)
      return {}
    }
    throw new EventError(-32601, `method not found: ${method}`)
  }

  /** Revoking a grant ends its subscriptions. */
  async cancelGrant(grant: string): Promise<void> {
    for (const { key, value } of await this.#store.list<Subscription>("evs:")) if (value.grant === grant) await this.#store.delete(key)
  }

  #checkUrl(url: string): string {
    const origin = this.#origin()
    let u: URL
    try {
      u = new URL(url)
    } catch {
      throw new Error(`event url "${url}" is not a URL`)
    }
    // EVT-4: a page or record of the app, never a confirmation or session URL.
    if (u.origin !== origin || u.pathname.startsWith("/confirm/") || u.pathname.startsWith("/session-transfer/")) throw new Error(`event url "${url}" must be a page or record of the app (${origin})`)
    return u.toString()
  }

  async emit(name: typeof NOTIFICATION_EVENT | typeof ACTIVITY_EVENT, to: string[], build: (locale: string) => Record<string, unknown>, type: string): Promise<number> {
    if (name === NOTIFICATION_EVENT && !this.#types.has(type)) throw new Error(`notify: "${type}" is not one of the app's notification types (defineApp notifications)`)
    let sent = 0
    for (const { value: sub } of await this.#store.list<Subscription>("evs:")) {
      if (sub.name !== name || !to.includes(sub.person)) continue
      if (sub.types && !sub.types.includes(type)) continue
      const data = build(sub.locale)
      const id = `${name}:${String(data.id)}:${Date.now()}`
      const body = JSON.stringify({ eventId: id, name, timestamp: new Date().toISOString(), data })
      const ts = Math.floor(Date.now() / 1000)
      const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(sub.secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
      const signature = base64(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${ts}.${body}`))))
      try {
        const r = await this.#fetch(sub.url, { method: "POST", redirect: "manual", headers: { "content-type": "application/json", "webhook-id": id, "webhook-timestamp": String(ts), "webhook-signature": `v1,${signature}` }, body })
        if (r.ok) sent++
        else if (r.status === 410) await this.#store.delete(`evs:${sub.id}`)
      } catch {
        // An unreachable callback is the subscriber's problem; the next event tries again.
      }
    }
    return sent
  }

  notification(to: string[], n: { type: string; title: Label; body?: Label; url: string; id?: string; dedupe?: string }): Promise<number> {
    const url = this.#checkUrl(n.url)
    const id = n.id ?? crypto.randomUUID()
    return this.emit(NOTIFICATION_EVENT, to, (locale) => ({ id, type: n.type, title: cut(localize(n.title, locale, this.#locale), 120), ...(n.body ? { body: cut(localize(n.body, locale, this.#locale), 500) } : {}), url, ...(n.dedupe ? { dedupe: n.dedupe } : {}) }), n.type)
  }

  activity(to: string[], a: { id: string; type: string; title: Label; status?: Label; progress?: number; state: string; url?: string; tools?: string[] }): Promise<number> {
    const url = a.url ? this.#checkUrl(a.url) : undefined
    return this.emit(
      ACTIVITY_EVENT,
      to,
      (locale) => ({ id: a.id, type: a.type, title: cut(localize(a.title, locale, this.#locale), 120), ...(a.status ? { status: cut(localize(a.status, locale, this.#locale), 120) } : {}), ...(a.progress !== undefined ? { progress: Math.min(1, Math.max(0, a.progress)) } : {}), state: a.state, ...(url ? { url } : {}), ...(a.tools?.length ? { tools: a.tools.slice(0, 3) } : {}) }),
      a.type,
    )
  }
}
