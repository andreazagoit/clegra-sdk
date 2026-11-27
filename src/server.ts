import { createMcpHandler, inputRequired, McpServer, ResourceNotFoundError, ResourceTemplate, type CallToolResult, type ServerContext, type ServerEventBus } from "@modelcontextprotocol/server"
import type { SkillCatalog } from "@modelcontextprotocol/server/ext/skills"

import { AccessLog, ALL_SCOPES, grantHas, Revocations, SCOPES, scopeOf, type AuditEntry } from "./access"
import { agentCatalog } from "./agents"
import { jsonSchemaOf, type App } from "./app"
import { Confirmations, CONFIRM_PATH, toolError, type SessionReader } from "./confirm"
import type { BadgeHandle, Context, EntityHandle, Grant, Person, ToolHandle, ToolResult, WidgetHandle } from "./define"
import { isProduction, env } from "./env"
import { EventError, Events, EVENTS_EXTENSION } from "./events"
import { localize } from "./labels"
import { renderList, renderRecord } from "./generated"
import { boundTool, hasModeScope, linkTool, MARKER, modeScope, REVISION, SESSION_PATH, sessionOutput, SessionTransfer, type PageSession } from "./session"
import type { SignIn } from "./signin/module"
import { MemoryStore, type Store } from "./store"
import { expand, match, pathVars } from "./template"

export const WEB_MAP = "com.clegra/web-map"
export const WEB_MAP_REVISION = "0.2"
export const APP_SHARE = "com.clegra/app-share"
export const APP_SHARE_REVISION = "0.1"
export const PAGES_URI = "webmap://pages"
export const badgeUri = (name: string) => `webmap://badges/${name}`
export const widgetUri = (name: string) => `webmap://widgets/${name}`
/** The Server Card's media type and the `$schema` every card carries (MCP Server Cards, SEP-2127: `ext-server-card` `schema.ts`). */
export const SERVER_CARD_TYPE = "application/mcp-server-card+json"
export const SERVER_CARD_SCHEMA = "https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json"
/** The AI Catalog (v0.9, the release candidate of v1.0): its well-known path, media type and `specVersion`. */
export const AI_CATALOG_PATH = "/.well-known/ai-catalog.json"
export const AI_CATALOG_TYPE = "application/ai-catalog+json"
export const AI_CATALOG_SPEC_VERSION = "0.9"
/** The CORS of the public discovery documents (the Server Card's, from its discovery.md: read-only, public). */
const DISCOVERY_CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET",
  "access-control-allow-headers": "Content-Type, If-None-Match",
  "access-control-expose-headers": "ETag",
}
export const ACCESS_LOG_PATH = "/access/log"
const CAPS_META = "io.modelcontextprotocol/clientCapabilities"
const LANG_META = "io.modelcontextprotocol/acceptLanguage"

/** An error a handler throws for the caller to see (`isError` with `structuredContent.error`). */
export class AppError extends Error {
  constructor(
    readonly code: "not_found" | "invalid_input" | "permission_denied" | "conflict" | "rate_limited" | (string & {}),
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = "AppError"
  }
}

/** How the app verifies the access tokens of its own authorization server (MCP authorization). */
export type VerifyAuth = {
  /** Checks signature, expiry and that the audience is exactly `info.resource` (RFC 8707); null refuses the token. */
  verify(token: string, request: Request, info: { resource: string; scheme: "Bearer" | "DPoP" }): Promise<Grant | null> | Grant | null
  /** The authorization servers named in the protected-resource metadata. */
  authorizationServers: string[]
  /** The app's own browser session (pages, the confirmation page, session transfer). */
  sessions?: SessionReader
  /** Told when the SDK revokes a grant (the person declined and revoked on the confirmation page). */
  revoke?(grant: string): void | Promise<void>
}

export type ServeOptions = {
  /** The app's public origin (`https://jobs.example.com`): web-map's `origin`. Default `CLEGRA_PUBLIC_URL`; required in production. */
  origin?: string
  /** Where the MCP server answers, default `/mcp`. */
  mcpPath?: string
  /** The app's sign-in module (`createSignIn`, `devSignIn`), or its own authorization server. */
  auth: { signIn: SignIn } | VerifyAuth
  store?: Store
  /** The access log's hook (ACC-7): every change, confirmation and session transfer (and reads unless `auditReads: false`). */
  audit?: (entry: AuditEntry) => void | Promise<void>
  auditReads?: boolean
  /** How long the log is kept, in days (default 90). */
  auditDays?: number
  /** Web origins of clients that frame the app's framable pages (`frame: true`) and may post a session redeem. */
  clientOrigins?: string[]
  /** CNF-7: how long a retried confirmed call waits for the person (default 25 000 ms). */
  confirmWaitMs?: number
  /** Generated pages for records and lists (for an app without a site of its own), default false. */
  pages?: "generated" | false
  /** Webhook delivery of events: the fetch it uses (tests). */
  events?: { fetch?: typeof fetch }
  /** The `subscriptions/listen` bus (several instances share one), default in process. */
  bus?: ServerEventBus
  /** Adds anything else to each request's MCP server (prompts, more resources). */
  mcp?(server: McpServer, ctx: Context): void
}

export type ServedApp = {
  readonly app: App
  /** Every route of the app's MCP side; a 404 for any other path. */
  fetch(request: Request): Promise<Response>
  /** The same, null for a path that is not the SDK's (so a server can pass it on). */
  handle(request: Request): Promise<Response | null>
  /** The app's public origin for this request. */
  origin(request?: Request): string
  /** The MCP endpoint URL. */
  mcpUrl(request?: Request): string
  /** A page's session: the app's own, or a transferred one (session transfer). */
  session(request: Request): Promise<PageSession | null>
  /** The banner a page shows over a transferred session (who, through which client, sign out). */
  banner(session: PageSession, request: Request): string
  /** Revokes a grant now: tokens refused, transferred sessions ended, confirmations cancelled, subscriptions ended. */
  revoke(grant: string): Promise<void>
  /** A person's access log (ACC-7). */
  log(person: string): Promise<AuditEntry[]>
  /** Tells subscribed clients that these resources changed (records' URLs, badge and widget handles: PAGE-7). */
  changed(...what: (string | BadgeHandle | WidgetHandle)[]): void
  /** Sends a notification from outside a tool call (a cron job, a webhook). */
  notify(to: string[], n: { type: string; title: import("./labels").Label; body?: import("./labels").Label; url: string; id?: string; dedupe?: string }): Promise<number>
  /** The web URL of a record (its MCP resource URI). */
  url(entity: EntityHandle, record: Record<string, unknown>, request?: Request): string
}

type Extra = { grant: Grant; locale: string; elicitsUrl: boolean; origin: string; hidden: ReadonlySet<string> }

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } })

/** A public discovery document (Server Card, AI Catalog): its media type, CORS `*`, an hour's cache and an ETag (304 on `If-None-Match`). */
async function discoveryDocument(request: Request, body: unknown, type: string): Promise<Response> {
  const text = JSON.stringify(body)
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))
  const etag = `"${Array.from(digest.slice(0, 16), (b) => b.toString(16).padStart(2, "0")).join("")}"`
  const headers = { "content-type": type, "cache-control": "public, max-age=3600", etag, ...DISCOVERY_CORS }
  const match = (request.headers.get("if-none-match") ?? "").split(",").map((t) => t.trim().replace(/^W\//, ""))
  if (match.includes(etag) || match.includes("*")) return new Response(null, { status: 304, headers })
  return new Response(request.method === "HEAD" ? null : text, { status: 200, headers })
}

function normaliseOrigin(value: string, what: string): string {
  let u: URL
  try {
    u = new URL(value)
  } catch {
    throw new Error(`serve: ${what} "${value}" is not a URL`)
  }
  if (!/^https?:$/.test(u.protocol) || (u.pathname !== "/" && u.pathname !== "") || u.search || u.hash) throw new Error(`serve: ${what} "${value}" must be an origin (https://host[:port]) with no path`)
  if (isProduction() && u.protocol !== "https:" && !/^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname)) throw new Error(`serve: ${what} "${value}" must be https in production (http only on a loopback address)`)
  return u.origin
}

const reverseHost = (origin: string) => new URL(origin).hostname.split(".").reverse().join(".")

/** Serves the app: its MCP server with the extensions, the record URLs, the confirmation and session-transfer pages. */
export function serve(app: App, options: ServeOptions): ServedApp {
  if (app?.kind !== "app") throw new Error("serve: give it the app defineApp returned")
  const mcpPath = (options.mcpPath ?? "/mcp").replace(/\/+$/, "")
  if (!/^(\/[A-Za-z0-9._~-]+)+$/.test(mcpPath)) throw new Error(`serve: mcpPath "${options.mcpPath}" must be a path like /mcp`)
  const configured = options.origin ?? env().CLEGRA_PUBLIC_URL
  const fixedOrigin = configured ? normaliseOrigin(configured, options.origin ? "origin" : "CLEGRA_PUBLIC_URL") : null
  if (!fixedOrigin && isProduction()) throw new Error("serve: give the app's public origin (`origin` or CLEGRA_PUBLIC_URL): in production it is never taken from a request")
  const store = options.store ?? new MemoryStore()
  if (!options.store && isProduction()) console.warn(`[${app.name}] serve: no store given: confirmations and transferred sessions live in this process only`)
  const signIn = "signIn" in options.auth ? options.auth.signIn : null
  const auth: VerifyAuth = signIn
    ? {
        verify: (token, request, info) => signIn.verify(token, request, info),
        authorizationServers: signIn.authorizationServers,
        sessions: { read: async (r) => signIn.login.session(r), signInUrl: (returnTo, r) => signIn.login.signInUrl(returnTo, r) },
        revoke: (grant) => signIn.revokeGrant(grant),
      }
    : (options.auth as VerifyAuth)
  if (typeof auth.verify !== "function") throw new Error("serve: auth needs `signIn` or `verify`")
  const clientOrigins = (options.clientOrigins ?? []).map((o) => normaliseOrigin(o, "clientOrigins"))
  let lastOrigin = fixedOrigin ?? "http://localhost:3000"
  const originOf = (request?: Request) => {
    if (fixedOrigin) return fixedOrigin
    if (request) lastOrigin = new URL(request.url).origin
    return lastOrigin
  }
  const revocations = new Revocations(store)
  const log = new AccessLog(store, options.audit, options.auditDays ?? 90)
  const confirmations = new Confirmations({ store, log, revocations, origin: () => originOf(), waitMs: options.confirmWaitMs ?? 25_000 })
  const transfer = new SessionTransfer({ store, log, revocations, origin: () => originOf(), clientOrigins: () => clientOrigins, sessions: auth.sessions, locale: app.locale })
  const events = new Events({ store, fetch: options.events?.fetch, origin: () => originOf(), types: Object.keys(app.config.notifications ?? {}), locale: app.locale })
  let revoking = false
  revocations.onRevoke(async (grant) => {
    await events.cancelGrant(grant)
    if (!revoking) await auth.revoke?.(grant)
  })
  signIn?.onRevoke(async (grant) => {
    revoking = true
    try {
      await revocations.revoke(grant)
    } finally {
      revoking = false
    }
  })
  const catalog: Promise<SkillCatalog> | null = agentCatalog(app)
  let loadedCatalog: SkillCatalog | null = null
  const linkMode = Boolean(app.config.sessionTransfer?.link)
  const shares = [...app.tools.values()].some((t) => t.config.accepts?.length || t.config.plugins?.length) || [...app.entities.values()].some((e) => e.config.shareAs?.length)
  const notifications = Object.keys(app.config.notifications ?? {}).length > 0

  const urlOf = (entity: EntityHandle, record: Record<string, unknown>, origin = originOf()) => origin + expand(entity.config.path, Object.fromEntries(pathVars(entity.config.path).map((v) => [v, record[v]])))
  const changedUri = (w: string | BadgeHandle | WidgetHandle) => (typeof w === "string" ? w : w.kind === "badge" ? badgeUri(w.name) : widgetUri(w.name))

  const context = (grant: Grant, locale: string, origin: string, changed: Set<string>, source: Context["source"] = null): Context => ({
    person: grant.person,
    grant,
    locale,
    origin,
    source,
    t: (label) => localize(label, locale, app.locale),
    has: (scope) => grantHas(grant, scope),
    url: (entity, record) => urlOf(entity, record, origin),
    changed: (...what) => {
      for (const w of what) changed.add(changedUri(w))
    },
    notify: async (n) => {
      await events.notification(n.to ?? [grant.person.id], n)
    },
    activity: async (a) => {
      await events.activity(a.to ?? [grant.person.id], { ...a, tools: a.tools?.map((t) => t.name) })
    },
  })

  /** The record a tool works on (MAP-3): its URL, or a bare id when the template has one variable. */
  async function recordOf(tool: ToolHandle, args: Record<string, unknown>, ctx: Context): Promise<Record<string, unknown> | undefined> {
    const c = tool.config
    if (c.on !== "record" || !c.entity) return undefined
    const raw = args[c.recordArg ?? "id"]
    if (typeof raw !== "string" || !raw) throw new AppError("invalid_input", `${c.recordArg ?? "id"}: the record's URL`)
    const template = ctx.origin + c.entity.config.path
    let vars = /^https?:\/\//.test(raw) ? match(template, raw) : null
    if (!vars && !/^https?:\/\//.test(raw)) {
      const names = pathVars(c.entity.config.path)
      if (names.length === 1) vars = { [names[0]!]: raw }
    }
    if (!vars) throw new AppError("invalid_input", `${c.recordArg ?? "id"}: "${raw}" is not a ${c.entity.name} of this app (${template})`)
    const record = await c.entity.config.get(vars, ctx)
    if (!record) throw new AppError("not_found", `No ${c.entity.name} at ${raw}`)
    return record as Record<string, unknown>
  }

  function resultOf(tool: ToolHandle, out: ToolResult | void, ctx: Context, changed: Set<string>): CallToolResult {
    const result = out ?? {}
    const links: CallToolResult["content"] = []
    for (const r of result.records ?? []) {
      const uri = urlOf(r.entity, r.record, ctx.origin)
      const title = r.record[r.entity.config.card.title]
      links.push({ type: "resource_link", uri, name: typeof title === "string" && title ? title : uri, mimeType: "application/json" })
      if (!tool.config.annotations.readOnly) changed.add(uri)
    }
    for (const l of result.links ?? []) links.push({ type: "resource_link", uri: l.url, name: l.name, mimeType: "text/html" })
    const data = result.data ?? {}
    return {
      content: [{ type: "text", text: result.text ?? JSON.stringify(data) }, ...links],
      structuredContent: data,
      ...(changed.size ? { _meta: { [WEB_MAP]: { changed: [...changed] } } } : {}),
    }
  }

  function buildServer(extra: Extra, handlerNotify: (uri: string) => void): McpServer {
    const { grant, locale, origin } = extra
    const t = (l: import("./labels").Label | undefined) => localize(l, locale, app.locale)
    const ctxBase = context(grant, locale, origin, new Set())
    const extensions: Record<string, Record<string, unknown>> = { [WEB_MAP]: { revision: WEB_MAP_REVISION, origin } }
    if (shares) extensions[APP_SHARE] = { revision: APP_SHARE_REVISION }
    if (notifications) extensions[EVENTS_EXTENSION] = { delivery: ["webhook"] }
    const server = new McpServer(
      { name: app.name, version: app.config.version, title: t(app.config.title), description: t(app.config.description), ...(app.config.icons?.length ? { icons: app.config.icons } : {}) },
      { capabilities: { extensions: extensions as never, resources: { subscribe: true, listChanged: true } }, ...(app.config.instructions ? { instructions: app.config.instructions } : {}) },
    )
    const register = server.registerTool.bind(server) as unknown as (name: string, config: Record<string, unknown>, cb: (args: Record<string, unknown>, mctx: ServerContext) => Promise<CallToolResult>) => void
    const challenge = (scope: string) => async () => (grantHas(grant, scope) ? undefined : { scopes: [...new Set([...grant.scopes, scope])] as [string, ...string[]], errorDescription: `this call needs the scope ${scope}` })

    const pageOf = (tool: ToolHandle) => (tool.config.page ? origin + tool.config.page.config.path : undefined)
    for (const tool of app.tools.values()) {
      // ORG-4: a tool this person may not use is not listed.
      if (extra.hidden.has(tool.name)) continue
      const c = tool.config
      const a = c.annotations
      const mapMeta = c.entity || c.page ? { entity: c.entity?.name, on: c.on ?? "collection", ...(c.on === "record" ? { recordArg: c.recordArg ?? "id" } : {}), ...(pageOf(tool) ? { page: pageOf(tool) } : {}) } : null
      const shareMeta = c.accepts?.length || c.plugins?.length ? { ...(c.accepts?.length ? { accepts: c.accepts.map((x) => ({ ...x, title: t(x.title) })) } : {}), ...(c.plugins?.length ? { plugins: c.plugins.map((x) => ({ ...x, title: t(x.title) })) } : {}) } : null
      const meta: Record<string, unknown> = { ...(mapMeta ? { [WEB_MAP]: mapMeta } : {}), ...(shareMeta ? { [APP_SHARE]: shareMeta } : {}), ...(c.visibility === "app" ? { ui: { visibility: ["app"] } } : {}) }
      const scope = scopeOf(tool)
      register(
        tool.name,
        {
          title: t(c.title),
          description: t(c.description),
          inputSchema: c.input,
          ...(c.output ? { outputSchema: c.output } : {}),
          annotations: a.readOnly
            ? { title: t(c.title), readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: a.openWorld ?? false }
            : { title: t(c.title), readOnlyHint: false, destructiveHint: a.destructive, idempotentHint: a.idempotent ?? false, openWorldHint: a.openWorld ?? false },
          scopeChallenge: challenge(scope),
          ...(Object.keys(meta).length ? { _meta: meta } : {}),
        },
        async (args, mctx) => {
          const changed = new Set<string>()
          const shareSource = ((mctx.mcpReq._meta as Record<string, unknown> | undefined)?.[APP_SHARE] as { source?: Context["source"] } | undefined)?.source ?? null
          const ctx = context(grant, locale, origin, changed, shareSource)
          let recordUrl: string | undefined
          try {
            if (c.allow && !(await c.allow(ctx))) throw new AppError("permission_denied", `You may not use ${t(c.title)}`)
            const requestState = typeof mctx.mcpReq.requestState === "function" ? (mctx.mcpReq.requestState() as string | undefined) : undefined
            // A repeat of a confirmed call returns its first result, even when that call deleted its record (CNF-6).
            const kept = c.confirm ? await confirmations.kept(requestState) : null
            if (kept) return kept
            const record = await recordOf(tool, args, ctx)
            if (record && c.entity) recordUrl = urlOf(c.entity, record, origin)
            const run = async () => {
              const out = await c.run(args as never, ctx, record as never)
              const result = resultOf(tool, out, ctx, changed)
              for (const uri of changed) handlerNotify(uri)
              return result
            }
            if (c.confirm) {
              const confirm = c.confirm
              const gate = await confirmations.gate({
                tool: tool.name,
                title: t(c.title),
                args,
                ctx,
                message: async () => confirm.message(args as never, ctx, record as never),
                values: async () => (confirm.values ? confirm.values(args as never, ctx, record as never) : null),
                elicitsUrl: extra.elicitsUrl,
                requestState,
                answered: Boolean(mctx.mcpReq.inputResponses && "confirm" in mctx.mcpReq.inputResponses),
              })
              if (!gate.run) {
                if ("ask" in gate) {
                  const r = gate.ask
                  return inputRequired({ inputRequests: { confirm: inputRequired.elicitUrl({ url: r.url, message: r.message }) }, requestState: r.requestState }) as unknown as CallToolResult
                }
                return gate.result
              }
              let result: CallToolResult
              try {
                result = await run()
              } catch (error) {
                result = failure(error, tool.name)
              }
              await gate.finish(result)
              return result
            }
            const result = await run()
            if (!a.readOnly || options.auditReads !== false) await log.write({ person: grant.person.id, grant: grant.id, client: grant.clientId, kind: "call", tool: tool.name, ...(recordUrl ? { record: recordUrl } : {}), outcome: "done" })
            return result
          } catch (error) {
            const result = failure(error, tool.name)
            if (!a.readOnly) await log.write({ person: grant.person.id, grant: grant.id, client: grant.clientId, kind: "call", tool: tool.name, ...(recordUrl ? { record: recordUrl } : {}), outcome: `failed: ${(result.structuredContent as { error: { code: string } }).error.code}` })
            return result
          }
        },
      )
    }

    // Session transfer (profile): the strong mode whenever the app has a session of its own; the link mode by choice.
    if (auth.sessions) {
      const modes: { mode: "bound" | "link"; def: typeof boundTool | typeof linkTool }[] = [{ mode: "bound", def: boundTool }, ...(linkMode ? [{ mode: "link" as const, def: linkTool }] : [])]
      for (const { mode, def } of modes) {
        register(
          def.name,
          {
            title: def.title,
            description: def.description,
            inputSchema: def.input,
            outputSchema: sessionOutput,
            annotations: { title: def.title, readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
            scopeChallenge: async () => (hasModeScope(grant, mode) ? undefined : { scopes: [...new Set([...grant.scopes, modeScope(mode)])] as [string, ...string[]] }),
            _meta: { [MARKER]: { revision: REVISION, mode }, ...(mode === "bound" ? { ui: { visibility: ["app"] } } : {}) },
          },
          async (args) => {
            if (!hasModeScope(grant, mode)) return toolError({ code: "insufficient_scope", message: `This needs the scope ${modeScope(mode)}.` })
            try {
              const out = await transfer.issue(mode, args as { target: string; challenge?: string }, ctxBase)
              return { content: [{ type: "text", text: mode === "link" ? `Open this link (it works once, for 5 minutes): ${out.url}` : "Redeem the code in the browser context with the verifier." }], structuredContent: out }
            } catch (error) {
              return toolError({ code: "invalid_input", message: error instanceof Error ? error.message : String(error) })
            }
          },
        )
      }
    }

    // Records at their web URLs (REC-1): one resource template per entity.
    for (const e of app.entities.values()) {
      const c = e.config
      const tools = [...app.tools.values()].filter((x) => x.config.entity === e && x.config.annotations.readOnly)
      const get = tools.find((x) => x.config.on === "record")
      const list = tools.find((x) => (x.config.on ?? "collection") === "collection")
      const record = { entity: e.name, ...(get ? { get: get.name } : {}), ...(list ? { list: list.name } : {}), card: c.card }
      const meta: Record<string, unknown> = { [WEB_MAP]: { record }, ...(c.shareAs?.length ? { [APP_SHARE]: { shareAs: c.shareAs } } : {}) }
      server.registerResource(
        e.name,
        new ResourceTemplate(origin + c.path, { list: undefined }),
        { title: t(c.title), ...(c.description ? { description: t(c.description) } : {}), mimeType: "application/json", _meta: meta, cacheHint: { cacheScope: "private", ttlMs: c.ttlMs ?? 30_000 } },
        async (uri, vars) => {
          const flat = Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, Array.isArray(v) ? String(v[0]) : String(v)]))
          const row = await c.get(flat, ctxBase)
          if (!row) throw new ResourceNotFoundError(uri.href)
          return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(row) }] }
        },
      )
    }

    // The pages this person may open (web-map §5), and the badges and widgets.
    server.registerResource("pages", PAGES_URI, { title: "Pages", mimeType: "application/json", cacheHint: { cacheScope: "private", ttlMs: 60_000 } }, async () => {
      const pages = []
      for (const p of app.pages.values()) {
        const c = p.config
        if (c.allow && !(await c.allow(ctxBase))) continue
        pages.push({
          url: origin + c.path,
          name: p.name,
          title: t(c.title),
          role: c.role,
          ...(c.entity ? { entity: c.entity.name } : {}),
          ...(c.nav ? { nav: { ...(c.nav.section ? { section: t(c.nav.section) } : {}), order: c.nav.order } } : {}),
          ...(c.tools?.length ? { tools: c.tools } : {}),
          ...(c.badge ? { badge: badgeUri(c.badge.name) } : {}),
          ...(c.frame ? { frame: true } : {}),
        })
      }
      return { contents: [{ uri: PAGES_URI, mimeType: "application/json", text: JSON.stringify({ pages }) }] }
    })
    for (const b of app.badges.values()) {
      const uri = badgeUri(b.name)
      server.registerResource(`badge:${b.name}`, uri, { title: t(b.config.title ?? b.name), mimeType: "application/json", cacheHint: { cacheScope: "private", ttlMs: 0 } }, async () => {
        if (b.config.allow && !(await b.config.allow(ctxBase))) throw new ResourceNotFoundError(uri)
        return { contents: [{ uri, mimeType: "application/json", text: JSON.stringify({ value: await b.config.value(ctxBase) }) }] }
      })
    }
    for (const w of app.widgets.values()) {
      const uri = widgetUri(w.name)
      server.registerResource(`widget:${w.name}`, uri, { title: t(w.config.title), ...(w.config.description ? { description: t(w.config.description) } : {}), mimeType: "application/json", _meta: { [WEB_MAP]: { widget: { sizes: w.config.sizes } } }, cacheHint: { cacheScope: "private", ttlMs: 0 } }, async () => {
        if (w.config.allow && !(await w.config.allow(ctxBase))) throw new ResourceNotFoundError(uri)
        return { contents: [{ uri, mimeType: "application/json", text: JSON.stringify(await w.config.data(ctxBase)) }] }
      })
    }
    loadedCatalog?.attach(server)
    options.mcp?.(server, ctxBase)
    return server
  }

  function failure(error: unknown, tool: string): CallToolResult {
    if (error instanceof AppError) return toolError({ code: error.code, message: error.message, ...(error.details ?? {}) })
    console.error(`[${app.name}] ${tool}`, error)
    return toolError({ code: "internal", message: "The call failed." })
  }

  const handler = createMcpHandler(
    (mctx) => {
      const extra = mctx.authInfo?.extra as Extra | undefined
      if (!extra) throw new Error("no caller")
      return buildServer(extra, (uri) => handler.notify.resourceUpdated(uri))
    },
    { legacy: "reject", ...(options.bus ? { bus: options.bus } : {}), onerror: (e) => console.error(`[${app.name}] mcp:`, e.message) },
  )

  const resourceMetadataUrl = (origin: string) => `${origin}/.well-known/oauth-protected-resource${mcpPath}`
  const unauthorized = (origin: string, error?: string) =>
    new Response(JSON.stringify({ error: error ?? "unauthorized", error_description: "Sign in through the app's authorization server" }), {
      status: 401,
      headers: { "content-type": "application/json", "www-authenticate": `Bearer resource_metadata="${resourceMetadataUrl(origin)}", scope="${SCOPES.read}"${error ? `, error="${error}"` : ""}` },
    })

  async function grantOf(request: Request, origin: string): Promise<Grant | null | "none"> {
    const header = request.headers.get("authorization") ?? ""
    const m = /^(Bearer|DPoP)\s+(\S+)$/i.exec(header)
    if (!m) return "none"
    const scheme = m[1]!.toLowerCase() === "dpop" ? "DPoP" : "Bearer"
    let grant: Grant | null
    try {
      grant = await auth.verify(m[2]!, request, { resource: origin + mcpPath, scheme })
    } catch {
      grant = null
    }
    if (!grant) return null
    if (await revocations.revoked(grant.id)) return null
    return grant
  }

  async function mcp(request: Request, origin: string): Promise<Response> {
    if (catalog && !loadedCatalog) loadedCatalog = await catalog
    const grant = await grantOf(request, origin)
    if (grant === "none") return unauthorized(origin)
    if (!grant) return unauthorized(origin, "invalid_token")
    const text = request.method === "POST" ? await request.text() : ""
    let body: { jsonrpc?: string; id?: unknown; method?: string; params?: Record<string, unknown> } = {}
    try {
      body = text ? JSON.parse(text) : {}
    } catch {
      // The MCP handler answers a malformed body itself.
    }
    const meta = (body.params?._meta ?? {}) as Record<string, unknown>
    const langs = meta[LANG_META]
    const locale = (Array.isArray(langs) ? String(langs[0] ?? "") : typeof langs === "string" ? langs.split(",")[0]!.split(";")[0]!.trim() : "") || app.locale
    const caps = (meta[CAPS_META] ?? {}) as { elicitation?: { url?: unknown } }
    if (body.method?.startsWith("events/") && notifications) {
      try {
        return json({ jsonrpc: "2.0", id: body.id ?? null, result: await events.handle(body.method, body.params ?? {}, grant, locale) })
      } catch (error) {
        const e = error instanceof EventError ? error : new EventError(-32603, "internal error")
        return json({ jsonrpc: "2.0", id: body.id ?? null, error: { code: e.code, message: e.message } })
      }
    }
    const forwarded = new Request(request.url, { method: request.method, headers: request.headers, ...(request.method === "POST" ? { body: text } : {}) })
    const hidden = new Set<string>()
    const probe = context(grant, locale, origin, new Set())
    for (const t of app.tools.values()) if (t.config.allow && !(await t.config.allow(probe))) hidden.add(t.name)
    const extra: Extra = { grant, locale, elicitsUrl: Boolean(caps.elicitation && typeof caps.elicitation === "object" && "url" in caps.elicitation), origin, hidden }
    return handler.fetch(forwarded, { authInfo: { token: "verified", clientId: grant.clientId, scopes: [...grant.scopes], extra } })
  }

  async function recordRoute(request: Request, origin: string, entity: EntityHandle, vars: Record<string, string>): Promise<Response> {
    const grant = await grantOf(request, origin)
    if (!grant || grant === "none") return unauthorized(origin, grant === "none" ? undefined : "invalid_token")
    const ctx = context(grant, app.locale, origin, new Set())
    const row = await entity.config.get(vars, ctx)
    const headers = { vary: "Authorization", "cache-control": "private, no-store" }
    if (!row) return json({ error: "not_found" }, 404, headers)
    return json(row, 200, headers)
  }

  function card(origin: string) {
    return {
      $schema: SERVER_CARD_SCHEMA,
      name: `${reverseHost(origin)}/${app.name}`,
      title: localize(app.config.title, app.locale, app.locale),
      description: localize(app.config.description, app.locale, app.locale),
      version: app.config.version,
      ...(app.config.icons?.length ? { icons: app.config.icons } : {}),
      remotes: [{ type: "streamable-http", url: origin + mcpPath }],
    }
  }

  async function handle(request: Request): Promise<Response | null> {
    const url = new URL(request.url)
    const origin = originOf(request)
    const path = url.pathname
    const get = request.method === "GET" || request.method === "HEAD"
    if (path === mcpPath) return mcp(request, origin)
    if ((path === `${mcpPath}/server-card` || path === AI_CATALOG_PATH) && request.method === "OPTIONS") return new Response(null, { status: 204, headers: DISCOVERY_CORS })
    if (path === `${mcpPath}/server-card` && get) return discoveryDocument(request, card(origin), SERVER_CARD_TYPE)
    if (path === AI_CATALOG_PATH && get) {
      // One entry: this app's Server Card by URL (identifier `urn:air:<host>:<app>:mcp`); its title, description and
      // version are read from the card, not repeated here.
      const catalog = {
        specVersion: AI_CATALOG_SPEC_VERSION,
        host: { displayName: localize(app.config.title, app.locale, app.locale) },
        entries: [{ identifier: `urn:air:${new URL(origin).hostname}:${app.name}:mcp`, type: SERVER_CARD_TYPE, url: `${origin}${mcpPath}/server-card` }],
      }
      return discoveryDocument(request, catalog, AI_CATALOG_TYPE)
    }
    if ((path === "/.well-known/oauth-protected-resource" || path === `/.well-known/oauth-protected-resource${mcpPath}`) && get) {
      const scopes = ALL_SCOPES.filter((s) => s !== SCOPES.browserSession || linkMode)
      return json({ resource: origin + mcpPath, authorization_servers: auth.authorizationServers, scopes_supported: scopes, bearer_methods_supported: ["header"], resource_name: localize(app.config.title, app.locale, app.locale) }, 200, { "access-control-allow-origin": "*" })
    }
    if (signIn) {
      const r = await signIn.fetch(request)
      if (r) return r
    }
    if (path.startsWith(SESSION_PATH)) return transfer.fetch(request)
    if (path.startsWith(CONFIRM_PATH)) return confirmations.page(request, auth.sessions, (r) => transfer.hasTransferred(r), app.locale)
    if (path === ACCESS_LOG_PATH && get) {
      // ACC-7: the person reads and takes their log, from a session of their own credentials.
      const person = auth.sessions ? await auth.sessions.read(request) : null
      if (!person) return json({ error: "sign in to the app with your own credentials" }, 401)
      return json({ keptDays: log.days, entries: await log.of(person.id) }, 200, { "cache-control": "no-store", "content-disposition": `attachment; filename="${app.name}-access-log.json"` })
    }
    if (get) {
      for (const e of app.entities.values()) {
        const vars = match(origin + e.config.path, origin + path)
        if (!vars) continue
        if (/^(Bearer|DPoP)\s/i.test(request.headers.get("authorization") ?? "")) return recordRoute(request, origin, e, vars)
        if (options.pages === "generated") return renderRecord({ app, entity: e, vars, request, origin, session: await transfer.session(request), banner: (s) => transfer.banner(s, request), sessions: auth.sessions, clientOrigins, context: (g) => context(g, app.locale, origin, new Set()) })
      }
      if (options.pages === "generated") {
        for (const p of app.pages.values()) {
          if (p.config.role !== "list" || !p.config.entity?.config.list) continue
          if (!match(origin + p.config.path.replace(/\{[?&][^}]*\}/g, ""), origin + path)) continue
          return renderList({ app, page: p, request, origin, session: await transfer.session(request), banner: (s) => transfer.banner(s, request), sessions: auth.sessions, clientOrigins, context: (g) => context(g, app.locale, origin, new Set()), urlOf: (e, r) => urlOf(e, r, origin) })
        }
      }
    }
    return null
  }

  return {
    app,
    handle,
    async fetch(request) {
      return (await handle(request)) ?? new Response("Not found", { status: 404 })
    },
    origin: originOf,
    mcpUrl: (request) => originOf(request) + mcpPath,
    session: (request) => transfer.session(request),
    banner: (session, request) => transfer.banner(session, request),
    revoke: (grant) => revocations.revoke(grant),
    log: (person) => log.of(person),
    changed: (...what) => {
      for (const w of what) handler.notify.resourceUpdated(changedUri(w))
    },
    notify: (to, n) => events.notification(to, n),
    url: (entity, record, request) => urlOf(entity, record, originOf(request)),
  }
}

export type { Person }
