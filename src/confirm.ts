import type { CallToolResult } from "@modelcontextprotocol/server"

import { AccessLog, Revocations } from "./access"
import { canonicalJson } from "./auth"
import { randomToken, sha256 } from "./crypto"
import type { Context, Person } from "./define"
import { escapeHtml, hidden, page, pageLocale, type PageLocale } from "./signin/pages"
import type { Store } from "./store"

/**
 * THE APP'S OWN CONFIRMATION (confirmation guide). A tool with `confirm` never runs on the client's word: the person
 * approves that exact call on the app's page, in a session born from their credentials. The client learns it from a
 * URL-mode elicitation (MCP 2026-07-28 multi round-trip), or, when it declared none, from the tool error
 * `confirmation_required` with the link (CNF-8); the repeated call then runs once.
 */

export const CONFIRM_PATH = "/confirm/"
/** CNF-6: at most 5 minutes from issue. */
export const CONFIRM_SECONDS = 300
/** How long the first result of a confirmed call is kept for repeats (CNF-6). */
const RESULT_SECONDS = 3600

export type Pending = {
  id: string
  tool: string
  title: string
  args: Record<string, unknown>
  digest: string
  subject: string
  personName: string
  clientId: string
  clientName: string | null
  grant: string
  message: string
  values: Record<string, unknown> | null
  issuedAt: string
  expiresAt: string
  state: "pending" | "confirmed" | "declined"
  nonce: string
  decidedAt?: string
}

/** The app's own session for its pages: who is signed in from their own credentials (never a transferred session). */
export type SessionReader = {
  read(request: Request): Promise<Person | null> | Person | null
  /** The app's sign-in page, coming back to `returnTo` (a path on the app). */
  signInUrl?(returnTo: string, request: Request): string
}

const TEXT = {
  en: {
    title: "Confirm this request",
    from: (client: string, at: string) => `Asked by ${client}, started at ${at}.`,
    details: "Every value of the request",
    confirm: "Confirm",
    decline: "Decline",
    notYou: "Not you? Decline and revoke this client's access",
    confirmed: "Confirmed. You can go back: the request goes on there.",
    declined: "Declined. Nothing was done.",
    revoked: "Declined, and the client's access was revoked.",
    expired: "This confirmation has expired or was already used.",
    signIn: "Sign in to the app to see this request.",
    fresh: "This needs a sign-in with your own credentials: a session opened from an assistant cannot confirm.",
    other: (name: string) => `You are signed in as ${name}: this request is for another person.`,
    signInLink: "Sign in",
    stale: "",
  },
  it: {
    title: "Conferma questa richiesta",
    from: (client: string, at: string) => `Richiesta da ${client}, iniziata alle ${at}.`,
    details: "Tutti i valori della richiesta",
    confirm: "Conferma",
    decline: "Rifiuta",
    notYou: "Non sei tu? Rifiuta e revoca l'accesso di questo client",
    confirmed: "Confermato. Puoi tornare indietro: la richiesta prosegue lì.",
    declined: "Rifiutato. Non è stato fatto nulla.",
    revoked: "Rifiutato, e l'accesso del client è stato revocato.",
    expired: "Questa conferma è scaduta o è già stata usata.",
    signIn: "Entra nell'app per vedere questa richiesta.",
    fresh: "Serve un accesso con le tue credenziali: una sessione aperta da un assistente non può confermare.",
    other: (name: string) => `Hai fatto l'accesso come ${name}: questa richiesta è per un'altra persona.`,
    signInLink: "Entra",
    stale: "",
  },
} satisfies Record<PageLocale, Record<string, unknown>>

export type ToolError = { code: string; message: string; [k: string]: unknown }

export const toolError = (error: ToolError, extra: CallToolResult["content"] = []): CallToolResult => ({
  isError: true,
  content: [{ type: "text", text: error.message }, ...extra],
  structuredContent: { error },
})

const hostOf = (clientId: string) => {
  try {
    return new URL(clientId).host
  } catch {
    return clientId
  }
}

export type GateInput = {
  tool: string
  title: string
  args: Record<string, unknown>
  ctx: Context
  message: () => Promise<string>
  values: () => Promise<Record<string, unknown> | null>
  /** The client declared URL-mode elicitation in this request's capabilities. */
  elicitsUrl: boolean
  requestState: string | undefined
  /** The URL-elicitation answer of this round, when the client retried with one. */
  answered: boolean
}

export type GateOutcome = { run: true; pending: Pending; finish(result: CallToolResult): Promise<void> } | { run: false; result: CallToolResult } | { run: false; ask: { url: string; message: string; requestState: string } }

export class Confirmations {
  readonly #store: Store
  readonly #log: AccessLog
  readonly #revocations: Revocations
  readonly #origin: () => string
  readonly #waitMs: number
  readonly #waiters = new Map<string, (() => void)[]>()

  constructor(input: { store: Store; log: AccessLog; revocations: Revocations; origin: () => string; waitMs: number }) {
    this.#store = input.store
    this.#log = input.log
    this.#revocations = input.revocations
    this.#origin = input.origin
    this.#waitMs = input.waitMs
    this.#revocations.onRevoke((grant) => this.cancelGrant(grant))
  }

  url(id: string): string {
    return `${this.#origin()}${CONFIRM_PATH}${id}`
  }

  async #wait(id: string): Promise<void> {
    if (this.#waitMs <= 0) return
    await new Promise<void>((resolve) => {
      const timer = setTimeout(done, this.#waitMs)
      function done() {
        clearTimeout(timer)
        resolve()
      }
      const list = this.#waiters.get(id) ?? []
      list.push(done)
      this.#waiters.set(id, list)
    })
  }

  #wake(id: string): void {
    for (const w of this.#waiters.get(id) ?? []) w()
    this.#waiters.delete(id)
  }

  /** Revoking a grant cancels its pending confirmations (ACC-6). */
  async cancelGrant(grant: string): Promise<void> {
    for (const { value: id } of await this.#store.list<string>(`cnfg:${grant}:`)) {
      const p = await this.#store.take<Pending>(`cnf:${id}`)
      if (p) await this.#store.delete(`cnfd:${p.digest}`)
      this.#wake(id)
    }
  }

  async #digest(tool: string, args: Record<string, unknown>, ctx: Context): Promise<string> {
    return sha256(canonicalJson({ tool, args, client: ctx.grant.clientId, subject: ctx.person.id }))
  }

  /** Decides whether the call runs now (CNF-1 to CNF-8). */
  async gate(input: GateInput): Promise<GateOutcome> {
    const { ctx } = input
    const digest = await this.#digest(input.tool, input.args, ctx)
    let id: string | null = input.requestState ?? null
    if (!id) id = await this.#store.get<string>(`cnfd:${digest}`)
    let p = id ? await this.#store.get<Pending>(`cnf:${id}`) : null
    if (input.requestState && !p) {
      const kept = await this.#store.get<CallToolResult>(`cnfres:${input.requestState}`)
      if (kept) return { run: false, result: kept }
      return { run: false, result: toolError({ code: "confirmation_expired", message: "Nobody confirmed this request in time: call the tool again to ask anew." }) }
    }
    if (p && (p.digest !== digest || p.subject !== ctx.person.id || p.clientId !== ctx.grant.clientId)) {
      // A request state of another call, subject or client proves nothing (CNF-2).
      if (input.requestState) return { run: false, result: toolError({ code: "confirmation_expired", message: "This confirmation belongs to another request." }) }
      p = null
    }
    if (p?.state === "pending" && (input.requestState || input.answered)) {
      await this.#wait(p.id)
      p = await this.#store.get<Pending>(`cnf:${p.id}`)
      if (!p) return { run: false, result: toolError({ code: "confirmation_expired", message: "Nobody confirmed this request in time." }) }
    }
    if (p?.state === "declined") {
      await this.#store.delete(`cnfd:${p.digest}`)
      return { run: false, result: toolError({ code: "confirmation_declined", message: "The person declined this request on the app's page." }) }
    }
    if (p?.state === "confirmed") {
      if (!(await this.#store.add(`cnfrun:${p.id}`, 1, RESULT_SECONDS))) {
        // A repeat of a confirmed call returns the first result: a lost response never runs it twice (CNF-6).
        for (let i = 0; i < 50; i++) {
          const kept = await this.#store.get<CallToolResult>(`cnfres:${p.id}`)
          if (kept) return { run: false, result: kept }
          await new Promise((r) => setTimeout(r, 100))
        }
        return { run: false, result: toolError({ code: "confirmation_expired", message: "This confirmation was already used." }) }
      }
      if (p.values !== null) {
        const now = await input.values()
        if (canonicalJson(now) !== canonicalJson(p.values)) {
          await this.#store.delete(`cnfd:${p.digest}`)
          return { run: false, result: toolError({ code: "confirmation_stale", message: "What the person confirmed has changed since: call the tool again to confirm the new values." }) }
        }
      }
      const pending = p
      return {
        run: true,
        pending,
        finish: async (result) => {
          await this.#store.set(`cnfres:${pending.id}`, result, RESULT_SECONDS)
          await this.#store.delete(`cnf:${pending.id}`)
          await this.#log.write({ person: pending.subject, grant: pending.grant, client: pending.clientId, kind: "call", tool: pending.tool, outcome: result.isError ? "failed" : "done", confirmation: { id: pending.id, digest: pending.digest, time: pending.decidedAt ?? pending.issuedAt } })
        },
      }
    }
    if (!p) {
      const issued = Date.now()
      p = {
        id: randomToken(16),
        tool: input.tool,
        title: input.title,
        args: input.args,
        digest,
        subject: ctx.person.id,
        personName: ctx.person.name,
        clientId: ctx.grant.clientId,
        clientName: ctx.grant.clientName ?? null,
        grant: ctx.grant.id,
        message: await input.message(),
        values: await input.values(),
        issuedAt: new Date(issued).toISOString(),
        expiresAt: new Date(issued + CONFIRM_SECONDS * 1000).toISOString(),
        state: "pending",
        nonce: randomToken(16),
      }
      await this.#store.set(`cnf:${p.id}`, p, CONFIRM_SECONDS)
      await this.#store.set(`cnfd:${digest}`, p.id, CONFIRM_SECONDS)
      await this.#store.set(`cnfg:${p.grant}:${p.id}`, p.id, CONFIRM_SECONDS)
    }
    const url = this.url(p.id)
    if (input.elicitsUrl) return { run: false, ask: { url, message: p.message, requestState: p.id } }
    return {
      run: false,
      result: toolError({ code: "confirmation_required", message: `${p.message} The person confirms on the app's page (${url}); then call the tool again with the same arguments.`, url, expiresAt: p.expiresAt }, [{ type: "resource_link", uri: url, name: input.title, mimeType: "text/html" }]),
    }
  }

  /** `GET`/`POST /confirm/<id>`: the page where the person approves (CNF-3, CNF-5). */
  async page(request: Request, sessions: SessionReader | undefined, transferred: (request: Request) => Promise<boolean>, locale: string): Promise<Response> {
    const url = new URL(request.url)
    const id = url.pathname.slice(CONFIRM_PATH.length)
    const lang = pageLocale(request, null, locale)
    const t = TEXT[lang]
    const show = (body: string, status = 200) => page({ title: t.title, body, locale: lang, status, frameAncestors: [] })
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(id)) return show(`<p>${t.expired}</p>`, 404)
    const p = await this.#store.get<Pending>(`cnf:${id}`)
    if (!p || p.state !== "pending") return show(`<h1>${t.title}</h1><p>${t.expired}</p>`, 410)
    const person = sessions ? await sessions.read(request) : null
    const signIn = sessions?.signInUrl ? sessions.signInUrl(`${CONFIRM_PATH}${id}`, request) : null
    if (!person) {
      if (await transferred(request)) return show(`<h1>${t.title}</h1><p>${t.fresh}</p>${signIn ? `<p><a href="${escapeHtml(signIn)}">${t.signInLink}</a></p>` : ""}`, 403)
      if (signIn && request.method === "GET") return new Response(null, { status: 303, headers: { location: signIn, "cache-control": "no-store", "content-security-policy": "frame-ancestors 'none'" } })
      return show(`<h1>${t.title}</h1><p>${t.signIn}</p>`, 401)
    }
    if (person.id !== p.subject) return show(`<h1>${t.title}</h1><p>${escapeHtml(t.other(person.name))}</p>`, 403)
    if (request.method === "POST") {
      const site = request.headers.get("sec-fetch-site")
      const origin = request.headers.get("origin")
      if ((site && site !== "same-origin") || (origin && origin !== url.origin)) return show(`<p>${t.expired}</p>`, 403)
      const form = await request.formData()
      if (form.get("nonce") !== p.nonce) return show(`<p>${t.expired}</p>`, 403)
      const decision = String(form.get("decision") ?? "")
      if (!["confirm", "decline", "revoke"].includes(decision)) return show(`<p>${t.expired}</p>`, 400)
      const next: Pending = { ...p, state: decision === "confirm" ? "confirmed" : "declined", decidedAt: new Date().toISOString() }
      const left = Math.max(1, Math.ceil((Date.parse(p.expiresAt) - Date.now()) / 1000))
      await this.#store.set(`cnf:${id}`, next, left)
      await this.#log.write({ person: p.subject, grant: p.grant, client: p.clientId, kind: "confirmation", tool: p.tool, outcome: next.state, confirmation: { id: p.id, digest: p.digest, time: next.decidedAt! } })
      if (decision === "revoke") await this.#revocations.revoke(p.grant)
      this.#wake(id)
      return show(`<h1>${t.title}</h1><p>${decision === "confirm" ? t.confirmed : decision === "revoke" ? t.revoked : t.declined}</p>`)
    }
    const at = new Date(p.issuedAt).toLocaleTimeString(lang === "it" ? "it-IT" : "en-GB", { hour: "2-digit", minute: "2-digit" })
    const client = p.clientName ? `${p.clientName} (${hostOf(p.clientId)})` : hostOf(p.clientId)
    const rows = Object.entries(p.args)
      .map(([k, v]) => `<tr><th style="text-align:left;padding-right:12px;vertical-align:top">${escapeHtml(k)}</th><td style="overflow-wrap:anywhere">${escapeHtml(typeof v === "string" ? v : JSON.stringify(v))}</td></tr>`)
      .join("")
    const form = (decision: string, label: string, primary = false) => `<form method="post">${hidden({ nonce: p.nonce, decision })}<button${primary ? ' class="p"' : ""}>${escapeHtml(label)}</button></form>`
    return show(
      `<h1>${escapeHtml(p.title)}</h1><div class="c">${escapeHtml(p.message)}</div><p class="m">${escapeHtml(t.from(client, at))}</p>` +
        `<details><summary class="m">${t.details}</summary><table class="c">${rows}</table></details>` +
        `<div class="b">${form("confirm", t.confirm, true)}${form("decline", t.decline)}</div><div class="b">${form("revoke", t.notYou)}</div>`,
    )
  }
}
