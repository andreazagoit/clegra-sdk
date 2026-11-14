import { createServer as createHttpServer, type IncomingMessage } from "node:http"

import { createMcpHandler, inputRequired, inputResponse, McpServer, type CallToolResult, type Icon, type ServerContext } from "@modelcontextprotocol/server"
import { META_KEY, OAUTH_SCOPE, PROTOCOL_ID, RESOLVE_TOOL, URI_SCHEME, uriPrefix } from "@modelapp/spec/protocol"
import { z } from "zod"

import { AuthError, canonicalJson, DEV_ISSUER, DevAuthority, isLoopback, signConfirmation, tenantOf, TokenVerifier, type AuthOptions, type Caller, type Person, type RequestTrust } from "./auth"
import { MANIFEST_PATH, manifestUri, SPEC_VERSION, type Manifest, type ManifestField } from "./manifest"
import { isLabel, labelMap, localize, type Label } from "./labels"
import { fieldsOf, jsonSchemaOf, plainSchema, type FieldInfo } from "./meaning"
import { MemoryStore, type IdempotencyStore } from "./store"
import type {
  ActionConfig,
  ActionHandle,
  ActionHandler,
  ActionResult,
  AgentConfig,
  Context,
  EntityConfig,
  EntityHandle,
  Filter,
  FragmentConfig,
  FragmentInstance,
  Notification,
  PageConfig,
  PermissionConfig,
  Query,
  SettingConfig,
  Template,
  ViewSource,
} from "./types"
import { MCP_APP_MIME_TYPE, urlPageHtml, viewHtml } from "./view"

/**
 * THE MAP SERVER, v1 (docs/map/spec.md): an MCP server
 * (official SDK, Streamable HTTP, stateless) whose declarations — entities,
 * actions, pages, fragments, agents, permissions, settings — become plain MCP
 * tools and MCP Apps views for any host, and a manifest hosts read to mount
 * the app natively. Internal: authors use defineApp (define.ts).
 *
 * Every request builds a fresh McpServer for its caller: the tools a caller
 * may not use are not listed, titles are in the caller's language, and every
 * handler closes over the verified caller. Permissions, field permissions,
 * exposure to plain clients, confirmations and idempotency are enforced
 * here, on every surface (tools, search, fetch, the resolver, dashboards),
 * before any handler.
 */

/** What a request brings beside its caller: whether dev tokens count (a loopback caller), and each call's arguments as received. */
export type RequestInfo = { trust: RequestTrust; received: ReadonlyMap<string | number, unknown> }

export type ServerOptions = {
  /** The app id: lowercase letters, digits, `-`; 2–40 characters. */
  name: string
  title: Label
  version: string
  description?: Label
  icons?: Icon[]
  /** The locale of bare-string labels (default `en`). */
  locale?: string
  auth?: AuthOptions
  /** MCP `instructions` for models. */
  instructions?: string
  websiteUrl?: string
  /** Where write results and used token ids are kept (default: in memory; several instances share one). */
  store?: IdempotencyStore
  /** Escape hatch: the raw McpServer of each request, to add hand-written tools, resources or views. */
  mcp?: (server: McpServer, caller: Caller | null) => void
}

/** The one `_meta` key of the host protocol (spec §7): `{ call, confirmation, settings }` on requests, `{ notifications, untrusted }` on results. */
export { META_KEY }
type HostMeta = { call?: unknown; confirmation?: unknown; settings?: unknown }
const hostMeta = (meta: Record<string, unknown> | undefined): HostMeta => {
  const m = meta?.[META_KEY]
  return m && typeof m === "object" && !Array.isArray(m) ? (m as HostMeta) : {}
}

export type ErrorCode = "unauthorized" | "permission_denied" | "not_found" | "invalid_input" | "confirmation_required" | "conflict" | "internal"

/** A failure a handler may throw on purpose: it reaches the caller as `{ error: { code, message } }`. */
export class AppError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = "AppError"
  }
}

type ToolName = { name: string; plain: boolean }
type EntityRecord = { name: string; config: EntityConfig<z.ZodObject>; fields: FieldInfo[]; handle: EntityHandle; tools: { list: ToolName; get: ToolName } }
type ActionRecord = { name: string; tool: string; entity?: EntityRecord; config: ActionConfig<z.ZodObject, EntityHandle | undefined>; input: z.ZodObject; handler: ActionHandler<z.ZodObject, EntityHandle | undefined>; write: boolean; confirm: "always" | "optional" | "never"; plain: boolean }
type PageRecord = { name: string; config: PageConfig; derived?: boolean; tool: ToolName }
type FragmentRecord = { type: string; config: FragmentConfig<z.ZodObject, Template>; tool: ToolName }

const NAME = /^[a-z][a-z0-9-]{1,39}$/
const IDENT = /^[a-z][a-z0-9_]{0,39}$/
const PERMISSION = /^[a-z][a-z0-9_-]{0,39}\.[a-z][a-z0-9_-]{0,39}$/
const RESERVED_PARAMS = new Set(["query", "sort", "dir", "cursor", "limit", "id"])
const RESERVED_TOOLS = new Set(["search", "fetch", RESOLVE_TOOL])

const b64url = (s: string) => Buffer.from(s, "utf8").toString("base64url")
const unb64url = (s: string) => Buffer.from(s, "base64url").toString("utf8")

const sortedJson = canonicalJson

// ------------------------------------------------------------ untrusted text

const XML: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\uFF1C": "&lt;", "\uFF1E": "&gt;", "\uFE64": "&lt;", "\uFE65": "&gt;" }
/**
 * Text written by outsiders, as a model reads it (spec §7): inside
 * `<untrusted>`, with `&`, `<` and `>` (and their full-width and small
 * forms) escaped as XML text, so nothing in it is a tag: it can't close or
 * open the wrapper, plainly, nested or already encoded.
 */
export const untrustedText = (value: string) => `<untrusted>${value.replace(/[&<>\uFF1C\uFF1E\uFE64\uFE65]/g, (c) => XML[c]!)}</untrusted>`
const pointerKey = (k: string) => k.replace(/~/g, "~0").replace(/\//g, "~1")
/** Every string inside `value` (at any depth) wrapped as untrusted, its JSON pointer noted. `skip`: keys left as they are. */
function markAll(value: unknown, pointer: string, pointers: string[], skip?: ReadonlySet<string>): unknown {
  if (typeof value === "string") {
    pointers.push(pointer)
    return untrustedText(value)
  }
  if (Array.isArray(value)) return value.map((v, i) => markAll(v, `${pointer}/${i}`, pointers, skip))
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, skip?.has(k) ? v : markAll(v, `${pointer}/${pointerKey(k)}`, pointers, skip)]))
  return value
}
/** A template's keys that are never free text. */
const TEMPLATE_KEYS = new Set(["uri", "kind", "format", "currency"])

const text = (t: string): CallToolResult["content"] => [{ type: "text", text: t }]

/** Whether the client of this request can answer an elicitation (MCP 2026-07-28: capabilities ride every request). */
function elicits(ctx: ServerContext): boolean {
  const caps = (ctx.mcpReq.envelope as Record<string, unknown> | undefined)?.["io.modelcontextprotocol/clientCapabilities"] as { elicitation?: unknown } | undefined
  return Boolean(caps?.elicitation)
}

function failure(code: ErrorCode, message: string, details?: Record<string, unknown>): CallToolResult {
  return { isError: true, content: text(message), structuredContent: { error: { code, message, ...details } } }
}

export class AppServer {
  readonly name: string
  readonly options: ServerOptions
  readonly locale: string
  readonly #verifier: TokenVerifier
  readonly #dev: DevAuthority | null
  readonly #store: IdempotencyStore
  readonly #entities = new Map<string, EntityRecord>()
  readonly #actions = new Map<string, ActionRecord>()
  readonly #pages = new Map<string, PageRecord>()
  readonly #fragments = new Map<string, FragmentRecord>()
  readonly #agents = new Map<string, AgentConfig>()
  readonly #permissions = new Map<string, PermissionConfig>()
  readonly #settings = new Map<string, SettingConfig>()
  #manifest: Manifest | null = null
  #devReady: Promise<void> | null = null
  readonly #handler = createMcpHandler(
    (ctx) => {
      const extra = ctx.authInfo?.extra as { caller?: Caller; request?: RequestInfo } | undefined
      return this.createMcpServer(extra?.caller ?? null, ctx.era, extra?.request)
    },
    {
      legacy: "stateless",
      onerror: (e) => console.error(`[${PROTOCOL_ID}]`, e.message),
    },
  )

  constructor(options: ServerOptions) {
    if (!NAME.test(options.name)) throw new Error(`name "${options.name}": lowercase letters, digits and -, 2 to 40 characters (it is the app id)`)
    this.name = options.name
    this.options = options
    this.locale = options.locale ?? "en"
    const auth = options.auth ?? {}
    if (auth.dev && process.env.NODE_ENV === "production") throw new Error("auth.dev is for development: it is refused when NODE_ENV is production")
    this.#store = options.store ?? new MemoryStore()
    this.#verifier = new TokenVerifier(auth, (key, ttlMs) => this.#store.once(key, ttlMs))
    this.#dev = auth.dev ? new DevAuthority(auth.dev === true ? {} : auth.dev, { name: this.name, title: localize(options.title, this.locale, this.locale), allPermissions: () => [...this.#permissions.keys()] }) : null
    if (this.#dev) this.#verifier.useDev(this.#dev)
  }

  // ------------------------------------------------------------ registration

  #taken(name: string): void {
    if (this.#entities.has(name) || this.#fragments.has(name)) throw new Error(`"${name}" is already an entity or a fragment type (they share one namespace)`)
  }

  #changed() {
    this.#manifest = null
  }

  readonly #toolNames = new Set<string>()
  #claimTools(...names: string[]) {
    for (const n of names) {
      if (!/^[a-zA-Z0-9_.-]{1,64}$/.test(n)) throw new Error(`tool name "${n}": letters, digits, _ . -; at most 64`)
      if (this.#toolNames.has(n) || RESERVED_TOOLS.has(n)) throw new Error(`tool name "${n}" is taken or reserved`)
      this.#toolNames.add(n)
    }
  }

  /** An entity (spec §4): a Zod object with `.meta()` meaning, and its reads. */
  registerEntity<S extends z.ZodObject>(name: string, config: EntityConfig<S>): EntityHandle<S> {
    if (!IDENT.test(name)) throw new Error(`entity "${name}": lowercase letters, digits and _, starting with a letter`)
    this.#taken(name)
    const fields = fieldsOf(name, config.schema)
    for (const f of fields) if ((f.filter || f.sort) && RESERVED_PARAMS.has(f.name) && f.name !== "id") throw new Error(`entity "${name}": field "${f.name}" can't be a filter or sort (reserved parameter name)`)
    const handle: EntityHandle<S> = { kind: "entity", name, schema: config.schema, fields, uri: (id) => this.uri(name, id) }
    const plain = config.expose?.plain !== false
    const tools = { list: { name: config.expose?.list ?? `${name}_list`, plain }, get: { name: config.expose?.get ?? `${name}_get`, plain } }
    this.#claimTools(tools.list.name, tools.get.name)
    this.#entities.set(name, { name, config: config as unknown as EntityConfig<z.ZodObject>, fields, handle: handle as unknown as EntityHandle, tools })
    this.#changed()
    return handle
  }

  /** An action (spec §5), on an entity's records or global. */
  registerAction<I extends z.ZodObject = z.ZodObject<{}>, E extends EntityHandle | undefined = undefined>(name: string, config: ActionConfig<I, E>, handler: ActionHandler<I, E>): ActionHandle {
    if (!IDENT.test(name)) throw new Error(`action "${name}": lowercase letters, digits and _`)
    const entity = config.entity ? this.#entities.get(config.entity.name) : undefined
    if (config.entity && !entity) throw new Error(`action "${name}": entity "${config.entity.name}" is not registered here`)
    const tool = config.expose?.tool ?? (entity ? `${entity.name}_${name}` : name)
    if (this.#actions.has(tool)) throw new Error(`action "${name}": its tool name "${tool}" is taken`)
    this.#claimTools(tool)
    const input = (config.input ?? z.object({})) as z.ZodObject
    if (entity && "id" in input.shape) throw new Error(`action "${name}": "id" is the record's id, given by the SDK; don't declare it in input`)
    const write = config.readOnly !== true
    const confirm = write ? (config.confirm ?? "always") : "never"
    // Writes reach plain MCP clients only when the developer opts in (spec §6).
    const plain = config.expose?.plain ?? !write
    this.#actions.set(tool, { name, tool, ...(entity ? { entity } : {}), config: config as never, input, handler: handler as never, write, confirm, plain })
    this.#changed()
    return { kind: "action", name, tool }
  }

  /** A page (spec §6). Every entity has a `record` page by default; registering one with its name replaces it. */
  registerPage<P extends z.ZodObject = z.ZodObject<{}>>(name: string, config: PageConfig<P>): { readonly kind: "page"; readonly name: string } {
    if (!IDENT.test(name)) throw new Error(`page "${name}": lowercase letters, digits and _`)
    if (this.#pages.has(name) && !this.#pages.get(name)!.derived) throw new Error(`page "${name}" is registered twice`)
    if ((config.kind === "list" || config.kind === "record") && !this.#entities.has(config.entity.name)) throw new Error(`page "${name}": entity "${config.entity.name}" is not registered here`)
    if (config.kind === "list") {
      const fields = this.#entities.get(config.entity.name)!.fields
      for (const c of config.columns) if (!fields.some((f) => f.name === c)) throw new Error(`page "${name}": column "${c}" is not a field of ${config.entity.name}`)
      if (config.params && !config.query) throw new Error(`page "${name}": with params, give query(params) too`)
    }
    if (config.kind === "custom" && "url" in config && !/^https:\/\//.test(config.url) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(config.url)) throw new Error(`page "${name}": url must be https`)
    const tool = config.kind === "record" ? this.#entities.get(config.entity.name)!.tools.get : { name: config.expose?.tool ?? `open_${name}`, plain: config.expose?.plain !== false }
    if (config.kind !== "record") this.#claimTools(tool.name)
    this.#pages.set(name, { name, config: config as unknown as PageConfig, tool })
    this.#changed()
    return { kind: "page", name }
  }

  /** A fragment type (spec §7): params, live data, a native template or an MCP Apps view. */
  registerFragment<P extends z.ZodObject, T extends Template>(type: string, config: FragmentConfig<P, T>): { readonly kind: "fragment"; readonly type: string } {
    if (!IDENT.test(type)) throw new Error(`fragment "${type}": lowercase letters, digits and _`)
    this.#taken(type)
    if (!config.template && !config.view) throw new Error(`fragment "${type}": give a template or a view`)
    const tool = { name: config.expose?.tool ?? `show_${type}`, plain: config.expose?.plain !== false }
    this.#claimTools(tool.name)
    this.#fragments.set(type, { type, config: config as never, tool })
    this.#changed()
    return { kind: "fragment", type }
  }

  /** An agent (spec §8): run by the host's model, with these tools. */
  registerAgent(name: string, config: AgentConfig): void {
    if (!IDENT.test(name)) throw new Error(`agent "${name}": lowercase letters, digits and _`)
    if (!config.tools.length) throw new Error(`agent "${name}": give it at least one tool`)
    this.#agents.set(name, config)
    this.#changed()
  }

  /** A permission (spec §8): `group.verb`. Returns its id. */
  registerPermission(id: string, config: PermissionConfig): string {
    if (!PERMISSION.test(id)) throw new Error(`permission "${id}": group.verb, lowercase`)
    this.#permissions.set(id, config)
    this.#changed()
    return id
  }

  /** A setting an administrator fills per installation (spec §2): text, number or boolean, never a secret. */
  registerSetting(id: string, config: SettingConfig): void {
    if (!/^[a-z][a-z0-9_]{1,39}$/.test(id)) throw new Error(`setting "${id}": lowercase letters, digits and _, starting with a letter, 2 to 40 characters`)
    if (!["text", "number", "boolean"].includes(config.type)) throw new Error(`setting "${id}": type is text, number or boolean`)
    if (config.default !== undefined && typeof config.default !== (config.type === "text" ? "string" : config.type)) throw new Error(`setting "${id}": the default must be a ${config.type}`)
    this.#settings.set(id, config)
    this.#changed()
  }

  // ------------------------------------------------------------ URIs

  /** `modelapp://<app>/<type>/<key>` (spec §4, §7). */
  uri(type: string | EntityHandle, key: string): string {
    return `${uriPrefix(this.name)}/${typeof type === "string" ? type : type.name}/${encodeURIComponent(key)}`
  }

  /** A fragment instance's URI: the record id for record cards, base64url of the sorted params' JSON otherwise. */
  fragmentUri(instance: FragmentInstance): string {
    if (this.#entities.has(instance.type)) return this.uri(instance.type, String(instance.params.id ?? ""))
    return this.uri(instance.type, b64url(sortedJson(instance.params)))
  }

  /** A URI of this app read back: its type and key, or null. */
  parseUri(uri: string): { type: string; key: string; params: Record<string, unknown> } | null {
    const m = new RegExp(`^${URI_SCHEME}://([^/]+)/([^/?#]+)/([^/?#]+)$`).exec(uri)
    if (!m || m[1] !== this.name) return null
    const type = m[2]!
    let key: string
    try {
      key = decodeURIComponent(m[3]!)
    } catch {
      return null
    }
    if (this.#entities.has(type)) return { type, key, params: { id: key } }
    if (this.#fragments.has(type)) {
      try {
        const params = JSON.parse(unb64url(key)) as unknown
        if (params && typeof params === "object" && !Array.isArray(params)) return { type, key, params: params as Record<string, unknown> }
      } catch {}
    }
    return null
  }

  // ------------------------------------------------------------ callers and contexts

  #allPermissions(): string[] {
    return [...this.#permissions.keys()]
  }

  #context(caller: Caller, meta: Record<string, unknown> | undefined, notes: Notification[]): Context {
    const locale = caller.locale ?? this.locale
    const host = hostMeta(meta)
    // Settings are the installation's, set by its administrator: only its workspace host says them. A plain client gets the defaults.
    const sent = (caller.host === "workspace" && host.settings && typeof host.settings === "object" && !Array.isArray(host.settings) ? host.settings : {}) as Record<string, unknown>
    const settings: Record<string, unknown> = {}
    for (const [id, s] of this.#settings) {
      const v = sent[id]
      const ok = s.type === "number" ? typeof v === "number" : s.type === "boolean" ? typeof v === "boolean" : typeof v === "string"
      settings[id] = ok ? v : s.default
    }
    const call = typeof host.call === "string" ? host.call : null
    return {
      app: this.name,
      installation: caller.installation,
      person: caller.person,
      permissions: caller.permissions,
      can: (p) => caller.permissions.has(p),
      locale,
      host: caller.host,
      settings,
      call,
      t: (label) => localize(label, locale, this.locale),
      notify: (n) => void notes.push(n),
      uri: (entity, id) => this.uri(entity, id),
    }
  }

  #t(caller: Caller | null, label: Label | undefined): string {
    return localize(label, caller?.locale ?? this.locale, this.locale)
  }

  #visibleFields(entity: EntityRecord, caller: Caller): FieldInfo[] {
    return entity.fields.filter((f) => !f.permission || caller.permissions.has(f.permission))
  }

  /** Whether this caller reaches the entity at all, on any surface: its permission, and for a plain client its exposure. */
  #canSee(entity: EntityRecord, caller: Caller): boolean {
    if (entity.config.permission && !caller.permissions.has(entity.config.permission)) return false
    return caller.host !== "plain" || entity.tools.get.plain
  }

  /** The same for a fragment type. */
  #canShow(f: FragmentRecord, caller: Caller): boolean {
    if (f.config.permission && !caller.permissions.has(f.config.permission)) return false
    return caller.host !== "plain" || f.tool.plain
  }

  /** Whether a URI inside a fragment's data points to something this caller reaches (a URI of another app is not ours to judge). */
  #uriVisible(uri: unknown, caller: Caller): boolean {
    if (typeof uri !== "string") return true
    const parsed = this.parseUri(uri)
    const entity = parsed ? this.#entities.get(parsed.type) : undefined
    return !entity || this.#canSee(entity, caller)
  }

  #mayUse(action: ActionRecord, caller: Caller): boolean {
    if (action.config.permission && !caller.permissions.has(action.config.permission)) return false
    if (action.entity && !this.#canSee(action.entity, caller)) return false
    if (caller.host === "plain" && !action.plain) return false
    return true
  }

  /** A row with only the fields this caller may see. */
  #strip(entity: EntityRecord, row: Record<string, unknown>, caller: Caller): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    for (const f of this.#visibleFields(entity, caller)) if (row[f.name] !== undefined) out[f.name] = row[f.name]
    return out
  }

  /** What the view and hosts need to draw a field, in the caller's language. */
  #column(f: FieldInfo, caller: Caller) {
    return {
      name: f.name,
      label: this.#t(caller, f.label ?? f.name),
      type: f.type,
      ...(f.role ? { role: f.role } : {}),
      ...(f.enum ? { enum: f.enum } : {}),
      ...(f.labels ? { labels: Object.fromEntries(Object.entries(f.labels).map(([k, v]) => [k, this.#t(caller, v)])) } : f.enum ? { labels: Object.fromEntries(f.enum.map((v) => [v, v])) } : {}),
      ...(f.tones ? { tones: f.tones } : {}),
      ...(f.currency ? { currency: f.currency } : {}),
      ...(f.ref ? { ref: f.ref } : {}),
    }
  }

  #actionInfo(a: ActionRecord, caller: Caller) {
    // The form's labels in the caller's language (plainSchema keeps only bare-string labels).
    const raw = jsonSchemaOf(a.input, "input") as { properties?: Record<string, Record<string, unknown>> }
    const input = plainSchema(raw) as { properties?: Record<string, Record<string, unknown>> }
    for (const [k, p] of Object.entries(raw.properties ?? {})) if (isLabel(p.label) && input.properties?.[k]) input.properties[k]!.title = this.#t(caller, p.label)
    return { tool: a.tool, title: this.#t(caller, a.config.title), confirm: a.confirm, input }
  }

  #recordActions(entity: EntityRecord, caller: Caller) {
    return [...this.#actions.values()].filter((a) => a.entity === entity && this.#mayUse(a, caller)).map((a) => this.#actionInfo(a, caller))
  }

  /** A row as a model reads it: its untrusted fields (strings at any depth) wrapped, their JSON pointers under `base` noted for `_meta`. */
  #markRow(entity: EntityRecord, row: Record<string, unknown>, base: string, pointers: string[]): Record<string, unknown> {
    const copy = { ...row }
    for (const f of entity.fields) if (f.untrusted && copy[f.name] !== undefined) copy[f.name] = markAll(copy[f.name], `${base}/${pointerKey(f.name)}`, pointers)
    return copy
  }

  /** A record card's title and subtitle the same way. */
  #markCard<C extends { title: string; subtitle?: string }>(entity: EntityRecord, card: C, base: string, pointers: string[]): C {
    const untrusted = (role: string) => entity.fields.some((f) => f.role === role && f.untrusted)
    const out = { ...card }
    if (untrusted("title")) out.title = markAll(card.title, `${base}/title`, pointers) as string
    if (card.subtitle !== undefined && untrusted("subtitle")) out.subtitle = markAll(card.subtitle, `${base}/subtitle`, pointers) as string
    return out
  }

  /** A resolved fragment's data as a model reads it (a record's untrusted fields; every text of a fragment declared `untrusted`). */
  #markResolved(r: { fragment: { type: string }; state: string; data?: unknown }, base: string, pointers: string[]): unknown {
    if (r.state !== "ok" || !r.data || typeof r.data !== "object") return r.data
    const entity = this.#entities.get(r.fragment.type)
    if (entity) return this.#markRow(entity, r.data as Record<string, unknown>, `${base}/data`, pointers)
    return this.#fragments.get(r.fragment.type)?.config.untrusted ? markAll(r.data, `${base}/data`, pointers, TEMPLATE_KEYS) : r.data
  }

  #marks(pointers: string[]) {
    return pointers.length ? { _meta: { [META_KEY]: { untrusted: pointers } } } : {}
  }

  // ------------------------------------------------------------ reads

  #queryOf(entity: EntityRecord, caller: Caller, args: Record<string, unknown>, base?: Partial<Pick<Query, "filters" | "text" | "sort">>): Query {
    const visible = this.#visibleFields(entity, caller)
    const filters: Record<string, Filter> = { ...(base?.filters ?? {}) }
    for (const f of visible) if (f.filter && args[f.name] !== undefined) filters[f.name] = args[f.name] as Filter
    for (const k of Object.keys(filters)) {
      const f = visible.find((x) => x.name === k)
      if (!f || !f.filter) throw new AppError("invalid_input", `"${k}" can't be filtered on`)
    }
    const sortField = typeof args.sort === "string" ? args.sort : base?.sort?.field
    if (sortField !== undefined && !visible.some((f) => f.name === sortField && f.sort)) throw new AppError("invalid_input", `"${sortField}" can't be sorted by`)
    const limit = typeof args.limit === "number" ? Math.max(1, Math.min(100, Math.floor(args.limit))) : 25
    const textQuery = typeof args.query === "string" && args.query.trim() ? args.query.trim() : base?.text
    // Text is searched only in the search fields the caller may see: a hidden field must not answer by matching.
    const textFields = visible.filter((f) => f.search).map((f) => f.name)
    if (textQuery && !textFields.length) throw new AppError("invalid_input", `${entity.name} can't be searched by text`)
    return {
      filters,
      ...(textQuery ? { text: textQuery, textFields } : {}),
      ...(sortField ? { sort: { field: sortField, dir: args.dir === "desc" || (args.dir === undefined && base?.sort?.dir === "desc") ? "desc" : "asc" } } : {}),
      ...(typeof args.cursor === "string" ? { cursor: args.cursor } : {}),
      limit,
    }
  }

  async #list(entity: EntityRecord, caller: Caller, ctx: Context, query: Query) {
    const result = await entity.config.list(query, ctx)
    const rows = (result.rows ?? []).slice(0, query.limit).map((r) => this.#strip(entity, r as Record<string, unknown>, caller))
    return { rows, ...(result.next ? { next: result.next } : {}), ...(typeof result.total === "number" ? { total: result.total } : {}) }
  }

  /** Titles of the records a list's ref fields point to (field → id → title), as this caller may see them. */
  async #refs(entity: EntityRecord, rows: Record<string, unknown>[], caller: Caller, ctx: Context): Promise<Record<string, Record<string, string>>> {
    const out: Record<string, Record<string, string>> = {}
    for (const f of this.#visibleFields(entity, caller)) {
      const target = f.ref ? this.#entities.get(f.ref) : undefined
      if (!target || !this.#canSee(target, caller)) continue
      const ids = [...new Set(rows.map((r) => r[f.name]).filter((v): v is string => typeof v === "string"))].slice(0, 50)
      const titles: Record<string, string> = {}
      await Promise.all(
        ids.map(async (id) => {
          const row = await target.config.get(id, ctx)
          if (row) titles[id] = this.#recordCard(target, this.#strip(target, row as Record<string, unknown>, caller), caller).title
        }),
      )
      out[f.name] = titles
    }
    return out
  }

  #listFiltersShape(entity: EntityRecord, caller: Caller): Record<string, z.ZodType> {
    const shape: Record<string, z.ZodType> = {}
    for (const f of this.#visibleFields(entity, caller)) {
      if (!f.filter) continue
      const value: z.ZodType = f.enum ? z.enum(f.enum as [string, ...string[]]) : f.type === "number" || f.type === "integer" ? z.number() : f.type === "boolean" ? z.boolean() : z.string()
      shape[f.name] = z
        .union([value, z.object({ in: z.array(value) }), z.object({ gte: value.optional(), lte: value.optional() })])
        .optional()
        .describe(`${this.#t(caller, f.label ?? f.name)}: a value, { in: [...] }, or a range { gte, lte }`)
    }
    if (this.#visibleFields(entity, caller).some((f) => f.search)) shape.query = z.string().max(200).optional().describe("Text to search for")
    const sortable = this.#visibleFields(entity, caller).filter((f) => f.sort).map((f) => f.name)
    if (sortable.length) {
      shape.sort = z.enum(sortable as [string, ...string[]]).optional().describe("Field to sort by")
      shape.dir = z.enum(["asc", "desc"]).optional()
    }
    return shape
  }

  #recordCard(entity: EntityRecord, row: Record<string, unknown>, caller: Caller) {
    const role = (r: string) => entity.fields.find((f) => f.role === r && (!f.permission || caller.permissions.has(f.permission)))
    const title = role("title")
    const subtitle = role("subtitle")
    const status = role("status")
    const statusValue = status ? row[status.name] : undefined
    return {
      title: String(title ? (row[title.name] ?? "") : row.id),
      ...(subtitle && row[subtitle.name] != null ? { subtitle: String(row[subtitle.name]) } : {}),
      ...(status && statusValue != null ? { status: this.#t(caller, status.labels?.[String(statusValue)] ?? String(statusValue)) } : {}),
    }
  }

  /** One fragment instance as this caller may see it now. */
  async #resolve(instance: FragmentInstance, caller: Caller, ctx: Context) {
    const uri = this.fragmentUri(instance)
    const fragment = { app: this.name, type: instance.type, params: instance.params }
    const entity = this.#entities.get(instance.type)
    if (entity) {
      if (!this.#canSee(entity, caller)) return { fragment, uri, state: "no-access" as const }
      const row = await entity.config.get(String(instance.params.id ?? ""), ctx)
      if (!row) return { fragment, uri, state: "gone" as const }
      const data = this.#strip(entity, row as Record<string, unknown>, caller)
      return {
        fragment,
        uri,
        state: "ok" as const,
        template: "record" as const,
        ...this.#recordCard(entity, data, caller),
        data,
        // The titles of the records it references (field → id → title), as this caller may see them: a host shows those, never the ids.
        refs: await this.#refs(entity, [data], caller, ctx),
        view: { kind: "record", tool: entity.tools.get.name, fields: this.#visibleFields(entity, caller).map((f) => this.#column(f, caller)), actions: this.#recordActions(entity, caller) },
      }
    }
    const f = this.#fragments.get(instance.type)
    if (!f) return { fragment, uri, state: "gone" as const }
    if (!this.#canShow(f, caller)) return { fragment, uri, state: "no-access" as const }
    const parsed = f.config.params.safeParse(instance.params)
    if (!parsed.success) return { fragment, uri, state: "gone" as const }
    let data = (await f.config.data(parsed.data as never, ctx)) as Record<string, unknown> | null
    if (!data) return { fragment, uri, state: "gone" as const }
    // What a template links to is shown only to who reaches it: a card of a record out of reach is no access, such items leave a list.
    if (f.config.template === "card" && !this.#uriVisible(data.uri, caller)) return { fragment, uri, state: "no-access" as const }
    if (f.config.template === "list" && Array.isArray(data.items)) data = { ...data, items: (data.items as { uri?: unknown }[]).filter((i) => this.#uriVisible(i?.uri, caller)) }
    const actions = (f.config.actions ?? []).map((h) => this.#actions.get(h.tool)).filter((a): a is ActionRecord => Boolean(a && this.#mayUse(a, caller))).map((a) => this.#actionInfo(a, caller))
    return { fragment, uri, state: "ok" as const, template: f.config.template ?? "view", title: this.#t(caller, f.config.title), data, ...(actions.length ? { actions } : {}) }
  }

  // ------------------------------------------------------------ calls

  /**
   * Runs one action call: permission, input, record, idempotency, confirmation, handler (spec §7).
   * `raw`: the call's arguments as they were received; the proof and the idempotency check cover those, never the parsed or defaulted input.
   */
  async #runAction(a: ActionRecord, caller: Caller, args: Record<string, unknown>, mctx: ServerContext | null, request: RequestInfo, raw?: unknown): Promise<CallToolResult> {
    const meta = (mctx?.mcpReq._meta ?? undefined) as Record<string, unknown> | undefined
    const notes: Notification[] = []
    const ctx = this.#context(caller, meta, notes)
    if (!this.#mayUse(a, caller)) return failure("permission_denied", `You may not use ${this.#t(caller, a.config.title)}.`)
    const { id, ...rest } = args
    const parsed = a.input.safeParse(a.entity ? rest : args)
    if (!parsed.success) return failure("invalid_input", z.prettifyError(parsed.error))
    let record: Record<string, unknown> | undefined
    if (a.entity) {
      if (typeof id !== "string" || !id) return failure("invalid_input", "id: the record's id is required")
      const row = await a.entity.config.get(id, ctx)
      if (!row) return failure("not_found", `${this.#t(caller, a.entity.config.label)} ${id} doesn't exist.`)
      record = row as Record<string, unknown>
    }
    const received = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : args) as Record<string, unknown>
    // Per caller: a stored answer is only ever given back to who made the call.
    const key = a.write && ctx.call ? `${caller.installation}:${caller.issuer}:${caller.subject}:${a.tool}:${ctx.call}` : null
    const hash = canonicalJson(received)
    if (key) {
      // One atomic step: two requests with the same call id can't both run.
      const existing = await this.#store.begin(key, hash, 120_000)
      if (existing) {
        if (existing.args !== hash) return failure("conflict", "This call id was already used with other arguments.")
        if (existing.result === undefined) return failure("conflict", "This call is still running: ask again for its result.", { pending: true })
        return existing.result as CallToolResult
      }
    }
    let kept = false
    try {
      if (a.write && a.confirm === "always" && caller.host === "workspace") {
        const proof = hostMeta(meta).confirmation
        const why = typeof proof === "string" ? await this.#verifier.checkConfirmation(proof, { issuer: caller.issuer, subject: caller.subject, installation: caller.installationId, tool: a.tool, args: received, call: ctx.call }, request.trust) : "no proof"
        if (why) {
          const card = a.entity && record ? this.#recordCard(a.entity, this.#strip(a.entity, record, caller), caller) : null
          return failure("confirmation_required", `${this.#t(caller, a.config.title)} needs the person's confirmation (${why}).`, {
            confirm: { tool: a.tool, title: this.#t(caller, a.config.title), ...(a.entity && record ? { record: { uri: this.uri(a.entity.name, String(record.id)), ...card } } : {}), input: received },
          })
        }
      }
      // A plain client that can elicit (MCP 2026-07-28 input requests) is asked to confirm an `always` write; others rely on the tool's destructiveHint.
      if (a.write && a.confirm === "always" && caller.host === "plain" && mctx && elicits(mctx)) {
        const answer = inputResponse(mctx.mcpReq.inputResponses, "confirm")
        if (answer.kind !== "elicit") {
          const lines = Object.entries(received).map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`).join("; ")
          return inputRequired({ inputRequests: { confirm: inputRequired.elicit({ message: `${this.#t(caller, a.config.title)}${lines ? ` (${lines})` : ""}?`, requestedSchema: z.object({ confirm: z.boolean() }) }) } }) as unknown as CallToolResult
        }
        if (answer.action !== "accept" || answer.content?.confirm !== true) return failure("confirmation_required", "Not confirmed.")
      }
      let out: ActionResult | void
      try {
        out = await a.handler(parsed.data as never, ctx, record as never)
      } catch (error) {
        if (error instanceof AppError) return failure(error.code, error.message, error.details)
        console.error(`[${PROTOCOL_ID}] ${a.tool}`, error)
        return failure("internal", "The action failed.")
      }
      const recordUri = out?.record ? (out.record.startsWith(`${URI_SCHEME}://`) ? out.record : a.entity ? this.uri(a.entity.name, out.record) : out.record) : undefined
      const message = out?.message ?? "Done."
      const result: CallToolResult = {
        content: text(message),
        structuredContent: { ok: true, message, ...(recordUri ? { record: recordUri } : {}), ...(out?.data ? { data: out.data } : {}) },
        ...(notes.length ? { _meta: { [META_KEY]: { notifications: notes.map((n) => ({ ...n, title: ctx.t(n.title), ...(n.body ? { body: ctx.t(n.body) } : {}), to: n.to ?? (caller.person ? [caller.person.id] : []) })) } } } : {}),
      }
      if (key) {
        await this.#store.finish(key, { args: hash, result }, 24 * 3600_000)
        kept = true
      }
      return result
    } finally {
      // Refused or failed: nothing is kept, the same call id can be tried again.
      if (key && !kept) await this.#store.abandon(key)
    }
  }

  // ------------------------------------------------------------ the MCP server

  #viewUri(): string {
    return `ui://${this.name}/view`
  }

  #pageViewUri(page: string): string {
    return `ui://${this.name}/pages/${page}`
  }

  #entityViewUri(entity: string): string {
    return `ui://${this.name}/entities/${entity}`
  }

  #fragmentViewUri(type: string): string {
    return `ui://${this.name}/fragments/${type}`
  }

  #ui(resourceUri: string, visibility: ("model" | "app")[] = ["model", "app"]) {
    return { ui: { resourceUri, visibility }, "ui/resourceUri": resourceUri, "openai/outputTemplate": resourceUri, "openai/widgetAccessible": true }
  }

  /** A tool without a view of its own that views call (a record's actions): callable from a view in MCP Apps hosts (`ui.visibility` with "app") and in ChatGPT (`openai/widgetAccessible`). Without it a host refuses the view's call. */
  #callable() {
    return { ui: { visibility: ["model", "app"] }, "openai/widgetAccessible": true }
  }

  #allPages(): PageRecord[] {
    const pages = [...this.#pages.values()]
    for (const e of this.#entities.values()) if (!this.#pages.has(e.name)) pages.push({ name: e.name, config: { kind: "record", entity: e.handle } as PageConfig, derived: true, tool: e.tools.get })
    return pages
  }

  #pageParams(page: PageRecord, caller: Caller): z.ZodObject {
    const c = page.config
    if (c.kind === "record") return z.object({ id: z.string() })
    if (c.params) return c.params as z.ZodObject
    if (c.kind === "list") {
      const e = this.#entities.get(c.entity.name)!
      return z.strictObject(this.#listFiltersShape(e, caller))
    }
    return z.object({})
  }

  /** A fresh McpServer for one request, for this caller (null: manifest and views only). `request`: what `fetch` knows of the HTTP request. */
  createMcpServer(caller: Caller | null, era: "legacy" | "modern" = "legacy", request: RequestInfo = { trust: { dev: Boolean(this.#dev), requestResource: null }, received: new Map() }): McpServer {
    void era
    const o = this.options
    // Tool names, titles and descriptions are in the app's own locale: stable for every caller (spec §6). Data labels follow the caller.
    const t = (l: Label | undefined) => localize(l, this.locale, this.locale)
    const s = new McpServer(
      { name: o.name, version: o.version, title: t(o.title), ...(o.description ? { description: t(o.description) } : {}), ...(o.icons ? { icons: o.icons } : {}), ...(o.websiteUrl ? { websiteUrl: o.websiteUrl } : {}) },
      { ...(o.instructions ? { instructions: o.instructions } : {}) },
    )
    // Resources: the manifest, the SDK's view, page, entity and fragment views.
    s.registerResource("manifest", manifestUri(this.name), { mimeType: "application/json", description: "The app's manifest (what hosts read to mount the app)" }, async () => ({
      contents: [{ uri: manifestUri(this.name), mimeType: "application/json", text: JSON.stringify(this.manifest()) }],
    }))
    const view = (uri: string, title: string, html: () => string | Promise<string>, src?: ViewSource | { url: string }) => {
      const csp = src && "url" in src ? { frameDomains: [new URL(src.url).origin] } : src && "csp" in src && src.csp ? src.csp : {}
      const ui = { csp, ...(src && "prefersBorder" in src && src.prefersBorder !== undefined ? { prefersBorder: src.prefersBorder } : {}) }
      s.registerResource(title, uri, { mimeType: MCP_APP_MIME_TYPE, _meta: { ui } }, async () => ({ contents: [{ uri, mimeType: MCP_APP_MIME_TYPE, text: await html(), _meta: { ui } }] }))
    }
    view(this.#viewUri(), `${t(o.title)} view`, () => viewHtml(t(o.title)))
    for (const p of this.#allPages()) {
      const c = p.config
      if (c.kind !== "custom" && c.view) view(this.#pageViewUri(p.name), t(c.title ?? p.name), () => (typeof c.view!.html === "function" ? c.view!.html() : c.view!.html), c.view)
      else if (c.kind === "dashboard") view(this.#pageViewUri(p.name), t(c.title), () => viewHtml(t(c.title), { tool: p.tool.name }))
      if (c.kind === "custom" && "url" in c) view(this.#pageViewUri(p.name), t(c.title), () => urlPageHtml(t(c.title), c.url), { url: c.url })
      if (c.kind === "custom" && "view" in c) view(this.#pageViewUri(p.name), t(c.title), () => (typeof c.view.html === "function" ? c.view.html() : c.view.html), c.view)
    }
    for (const e of this.#entities.values()) if (e.config.view) view(this.#entityViewUri(e.name), t(e.config.label), () => (typeof e.config.view!.html === "function" ? e.config.view!.html() : e.config.view!.html), e.config.view)
    for (const f of this.#fragments.values()) if (f.config.view) view(this.#fragmentViewUri(f.type), t(f.config.title), () => (typeof f.config.view!.html === "function" ? f.config.view!.html() : f.config.view!.html), f.config.view)

    if (!caller) {
      this.options.mcp?.(s, null)
      return s
    }
    const plainCaller = caller.host === "plain"
    const reg = s.registerTool.bind(s) as unknown as (name: string, config: Record<string, unknown>, cb: (args: Record<string, unknown>, ctx: ServerContext) => Promise<CallToolResult>) => void
    const guard = (name: string, fn: (args: Record<string, unknown>, ctx: ServerContext) => Promise<CallToolResult>) => async (args: Record<string, unknown>, ctx: ServerContext) => {
      try {
        return await fn(args ?? {}, ctx)
      } catch (error) {
        if (error instanceof AppError) return failure(error.code, error.message, error.details)
        console.error(`[${PROTOCOL_ID}] ${name}`, error)
        return failure("internal", "The call failed.")
      }
    }
    const ctxOf = (ctx: ServerContext) => this.#context(caller, ctx.mcpReq._meta as Record<string, unknown> | undefined, [])
    const read = { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false }

    // Entities: list and get.
    for (const e of this.#entities.values()) {
      if (!this.#canSee(e, caller) || (plainCaller && !e.tools.list.plain)) continue
      const label = t(e.config.label)
      const plural = t(e.config.plural ?? e.config.label)
      const columns = () => this.#visibleFields(e, caller).filter((f) => f.name !== "id" && (f.role || f.filter)).slice(0, 6).map((f) => this.#column(f, caller))
      reg(
        e.tools.list.name,
        {
          title: plural,
          description: `${t(e.config.description) || plural}. Lists ${plural.toLowerCase()} with filters, sort and paging (pass \`cursor\` from the previous result's \`next\`).`,
          inputSchema: z.strictObject({ ...this.#listFiltersShape(e, caller), cursor: z.string().optional(), limit: z.number().int().min(1).max(100).optional() }),
          annotations: { title: plural, ...read },
          _meta: this.#ui(this.#viewUri()),
        },
        guard(e.tools.list.name, async (args, mctx) => {
          const ctx = ctxOf(mctx)
          const out = await this.#list(e, caller, ctx, this.#queryOf(e, caller, args))
          const uris = out.rows.map((r) => this.uri(e.name, String(r.id)))
          const pointers: string[] = []
          const marked = out.rows.map((r, i) => this.#markRow(e, r, `/rows/${i}`, pointers))
          return {
            content: text(JSON.stringify({ rows: marked.map((r, i) => ({ uri: uris[i], ...r })), ...(out.next ? { next: out.next } : {}), ...(out.total !== undefined ? { total: out.total } : {}) })),
            structuredContent: { entity: e.name, ...out, uris, refs: await this.#refs(e, out.rows, caller, ctx), view: { kind: "list", title: plural, columns: columns(), tool: e.tools.list.name, args, getTool: e.tools.get.name } },
            ...this.#marks(pointers),
          }
        }),
      )
      reg(
        e.tools.get.name,
        {
          title: label,
          description: `One ${label.toLowerCase()} by id, with the actions available on it.`,
          inputSchema: z.object({ id: z.string().describe(`The ${label.toLowerCase()}'s id`) }),
          annotations: { title: label, ...read },
          _meta: this.#ui(e.config.view ? this.#entityViewUri(e.name) : this.#viewUri()),
        },
        guard(e.tools.get.name, async (args, mctx) => {
          const ctx = ctxOf(mctx)
          const row = await e.config.get(String(args.id), ctx)
          if (!row) return failure("not_found", `${label} ${String(args.id)} doesn't exist.`)
          const record = this.#strip(e, row as Record<string, unknown>, caller)
          const pointers: string[] = []
          const marked = this.#markRow(e, record, "/record", pointers)
          const uri = this.uri(e.name, String(record.id))
          return {
            content: text(JSON.stringify({ uri, ...marked })),
            structuredContent: { entity: e.name, uri, record, refs: await this.#refs(e, [record], caller, ctx), view: { kind: "record", title: label, tool: e.tools.get.name, fields: this.#visibleFields(e, caller).map((f) => this.#column(f, caller)), actions: this.#recordActions(e, caller) } },
            ...this.#marks(pointers),
          }
        }),
      )
    }

    // search and fetch (ChatGPT's conventions), over searchable entities.
    const searchable = [...this.#entities.values()].filter((e) => this.#canSee(e, caller) && this.#visibleFields(e, caller).some((f) => f.search))
    if (searchable.length) {
      reg(
        "search",
        {
          title: t({ en: "Search", it: "Cerca" }),
          description: `Searches ${searchable.map((e) => t(e.config.plural ?? e.config.label)).join(", ")} by text. Returns ids (URIs) to pass to fetch.`,
          inputSchema: z.object({ query: z.string().min(1).max(200), limit: z.number().int().min(1).max(50).optional() }),
          annotations: { ...read },
          _meta: this.#ui(this.#viewUri()),
        },
        guard("search", async (args, mctx) => {
          const ctx = ctxOf(mctx)
          const limit = typeof args.limit === "number" ? args.limit : 10
          const results: Record<string, unknown>[] = []
          const forModel: Record<string, unknown>[] = []
          const pointers: string[] = []
          for (const e of searchable) {
            const out = await this.#list(e, caller, ctx, this.#queryOf(e, caller, { query: String(args.query), limit }))
            for (const row of out.rows) {
              const uri = this.uri(e.name, String(row.id))
              const card = this.#recordCard(e, row, caller)
              const marked = this.#markCard(e, card, `/results/${results.length}`, pointers)
              results.push({ id: uri, entity: e.name, entityLabel: t(e.config.label), ...card, url: uri })
              forModel.push({ id: uri, title: marked.title, url: uri })
            }
          }
          return { content: text(JSON.stringify({ results: forModel })), structuredContent: { results, view: { kind: "search" } }, ...this.#marks(pointers) }
        }),
      )
      reg(
        "fetch",
        {
          title: t({ en: "Fetch", it: "Apri" }),
          description: "One record by its id (a URI from search or a list), with all fields the caller may see.",
          inputSchema: z.object({ id: z.string().describe("The record's URI") }),
          annotations: { ...read },
          _meta: this.#ui(this.#viewUri()),
        },
        guard("fetch", async (args, mctx) => {
          const ctx = ctxOf(mctx)
          const parsed = this.parseUri(String(args.id))
          if (!parsed) return failure("not_found", "Unknown id.")
          const r = await this.#resolve({ type: parsed.type, params: parsed.params }, caller, ctx)
          if (r.state !== "ok") return failure(r.state === "no-access" ? "permission_denied" : "not_found", r.state === "no-access" ? "No access." : "Not found.")
          const entity = this.#entities.get(parsed.type)
          const record = r.data as Record<string, unknown>
          const pointers: string[] = []
          const marked = entity ? this.#markRow(entity, record, "/record", pointers) : this.#markResolved(r, "", pointers)
          const title = "title" in r ? r.title : ""
          return {
            content: text(JSON.stringify({ id: r.uri, title: entity ? this.#markCard(entity, { title }, "", []).title : title, text: JSON.stringify(marked), url: r.uri, metadata: { type: parsed.type } })),
            structuredContent: entity ? { entity: entity.name, uri: r.uri, record, refs: await this.#refs(entity, [record], caller, ctx), view: r.template === "record" ? { ...("view" in r ? r.view : {}), title: t(entity.config.label) } : undefined } : { ...r, view: { kind: "fragment", title } },
            ...this.#marks(pointers),
          }
        }),
      )
    }

    // The resolver hosts use for cards (hidden from models).
    reg(
      RESOLVE_TOOL,
      {
        title: "Resolve",
        description: "For hosts: fragment and record URIs resolved for the viewer.",
        inputSchema: z.object({ uris: z.array(z.string()).max(50), want: z.enum(["reference", "fragment", "snapshot"]).optional() }),
        annotations: { ...read },
        _meta: { ui: { visibility: ["app"] }, "openai/visibility": "private", "openai/widgetAccessible": true },
      },
      guard(RESOLVE_TOOL, async (args, mctx) => {
        const ctx = ctxOf(mctx)
        const results = []
        const pointers: string[] = []
        for (const uri of args.uris as string[]) {
          const parsed = this.parseUri(uri)
          if (!parsed) {
            results.push({ uri, state: "gone" })
            continue
          }
          const r = await this.#resolve({ type: parsed.type, params: parsed.params }, caller, ctx)
          if (r.state !== "ok") results.push({ uri, state: r.state })
          else {
            // For the host: which values are outsiders' text (it wraps them before a model reads them).
            const at = `/results/${results.length}`
            const entity = this.#entities.get(parsed.type)
            if (entity && "title" in r) this.#markCard(entity, { title: String(r.title), ...("subtitle" in r && typeof r.subtitle === "string" ? { subtitle: r.subtitle } : {}) }, at, pointers)
            if (args.want !== "reference") this.#markResolved(r, at, pointers)
            const { fragment: _f, view, ...rest } = r as typeof r & { view?: { actions?: { tool: string }[] } }
            const actions = view?.actions ? { actions: view.actions.map((a) => a.tool) } : "actions" in rest && Array.isArray(rest.actions) ? { actions: (rest.actions as { tool: string }[]).map((a) => a.tool) } : {}
            results.push(args.want === "reference" ? { uri, state: "ok", title: "title" in rest ? rest.title : "", ...("subtitle" in rest ? { subtitle: rest.subtitle } : {}), ...("status" in rest ? { status: rest.status } : {}) } : { ...rest, ...actions, uri })
          }
        }
        return { content: text(`${results.length} resolved`), structuredContent: { results }, ...this.#marks(pointers) }
      }),
    )

    // Actions.
    for (const a of this.#actions.values()) {
      if (!this.#mayUse(a, caller)) continue
      const title = t(a.config.title)
      const input = a.entity ? z.object({ id: z.string().describe(`The ${t(a.entity.config.label).toLowerCase()}'s id`), ...a.input.shape }) : a.input
      reg(
        a.tool,
        {
          title,
          description: `${t(a.config.description) || title}${a.write ? (a.confirm === "always" ? " (a change; the person confirms it first)" : " (a change)") : ""}.`,
          inputSchema: input,
          annotations: { title, readOnlyHint: !a.write, destructiveHint: a.write && a.confirm === "always", idempotentHint: !a.write, openWorldHint: false },
          _meta: this.#callable(),
        },
        guard(a.tool, (args, mctx) => this.#runAction(a, caller, args, mctx, request, request.received.get(mctx.mcpReq.id as string | number))),
      )
    }

    // Pages: open_<page> (record pages are <entity>_get).
    for (const p of this.#allPages()) {
      const c = p.config
      if (c.kind === "record" || (plainCaller && !p.tool.plain)) continue
      if (c.permission && !caller.permissions.has(c.permission)) continue
      if (c.kind === "list" && !this.#canSee(this.#entities.get(c.entity.name)!, caller)) continue
      const title = t(c.title)
      const params = this.#pageParams(p, caller)
      const shape = c.kind === "list" ? { ...params.shape, cursor: z.string().optional(), limit: z.number().int().min(1).max(100).optional() } : params.shape
      const resource = c.kind === "list" && !c.view ? this.#viewUri() : this.#pageViewUri(p.name)
      reg(
        p.tool.name,
        {
          title,
          description: `Opens the page «${title}»${t(c.description) ? `: ${t(c.description)}` : ""}. Its parameters set the state it opens in.`,
          inputSchema: c.kind === "list" && !c.params ? z.strictObject(shape) : z.object(shape),
          annotations: { title, ...read },
          _meta: this.#ui(resource),
        },
        guard(p.tool.name, async (args, mctx) => {
          const ctx = ctxOf(mctx)
          const { cursor, limit, ...rest } = args
          const parsed = params.safeParse(rest)
          if (!parsed.success) return failure("invalid_input", z.prettifyError(parsed.error))
          const pageParams = parsed.data as Record<string, unknown>
          if (c.kind === "list") {
            const e = this.#entities.get(c.entity.name)!
            const query = this.#queryOf(e, caller, { ...(c.query ? {} : pageParams), cursor, limit }, c.query ? c.query(pageParams as never) : undefined)
            const out = await this.#list(e, caller, ctx, query)
            const visible = new Set(this.#visibleFields(e, caller).map((f) => f.name))
            const columns = c.columns.filter((n) => visible.has(n)).map((n) => this.#column(e.fields.find((f) => f.name === n)!, caller))
            const pointers: string[] = []
            const marked = out.rows.map((r, i) => this.#markRow(e, r, `/rows/${i}`, pointers))
            return {
              content: text(JSON.stringify({ page: p.name, rows: marked, ...(out.next ? { next: out.next } : {}) })),
              structuredContent: { page: p.name, entity: e.name, params: pageParams, ...out, uris: out.rows.map((r) => this.uri(e.name, String(r.id))), refs: await this.#refs(e, out.rows, caller, ctx), view: { kind: "list", title, columns, tool: p.tool.name, args: pageParams, getTool: e.tools.get.name } },
              ...this.#marks(pointers),
            }
          }
          if (c.kind === "dashboard") {
            const instances = typeof c.fragments === "function" ? await c.fragments(pageParams as never, ctx) : c.fragments
            const fragments = []
            for (const i of instances) fragments.push({ ...(await this.#resolve(i, caller, ctx)), ...(i.size ? { size: i.size } : {}) })
            const pointers: string[] = []
            return {
              content: text(JSON.stringify({ page: p.name, fragments: fragments.map((f, i) => ({ uri: f.uri, state: f.state, ...("data" in f ? { data: this.#markResolved(f, `/fragments/${i}`, pointers) } : {}) })) })),
              structuredContent: { page: p.name, params: pageParams, fragments, view: { kind: "dashboard", title } },
              ...this.#marks(pointers),
            }
          }
          return { content: text(`Opened ${title}.`), structuredContent: { page: p.name, params: pageParams, view: { kind: "custom", title } } }
        }),
      )
    }

    // Custom fragment types: show_<type>.
    for (const f of this.#fragments.values()) {
      if (!this.#canShow(f, caller)) continue
      const title = t(f.config.title)
      reg(
        f.tool.name,
        {
          title,
          description: `${t(f.config.description).replace(/[.\s]*$/, "")}. Shows it as a live fragment; don't repeat its data in full.`,
          inputSchema: f.config.params,
          annotations: { title, ...read },
          _meta: this.#ui(f.config.view ? this.#fragmentViewUri(f.type) : this.#viewUri()),
        },
        guard(f.tool.name, async (args, mctx) => {
          const r = await this.#resolve({ type: f.type, params: args }, caller, ctxOf(mctx))
          if (r.state !== "ok") return failure(r.state === "no-access" ? "permission_denied" : "not_found", r.state === "no-access" ? "No access." : "Not available.")
          const pointers: string[] = []
          return { content: text(JSON.stringify({ uri: r.uri, data: this.#markResolved(r, "", pointers) })), structuredContent: { ...r, view: { kind: "fragment", title } }, ...this.#marks(pointers) }
        }),
      )
    }
    this.options.mcp?.(s, caller)
    return s
  }

  // ------------------------------------------------------------ the manifest

  /** The manifest (spec §2), built from the definition: pure JSON. Throws on references that don't hold. */
  manifest(): Manifest {
    if (this.#manifest) return this.#manifest
    const L = (l: Label | undefined) => labelMap(l, this.locale)
    const perm = (p: string | undefined, where: string) => {
      if (p && !this.#permissions.has(p)) throw new Error(`${where}: permission "${p}" is not registered`)
      return p ? { permission: p } : {}
    }
    // An action's input for hosts that draw its form: the plain JSON Schema, each property with its `label` map.
    const labelled = (schema: z.ZodObject): Record<string, unknown> => {
      const raw = jsonSchemaOf(schema, "input") as { properties?: Record<string, Record<string, unknown>> }
      const plain = plainSchema(raw) as { properties?: Record<string, Record<string, unknown>> }
      for (const [k, p] of Object.entries(raw.properties ?? {})) if (isLabel(p.label) && plain.properties?.[k]) plain.properties[k]!.label = L(p.label)
      return plain as Record<string, unknown>
    }
    const entities = [...this.#entities.values()].map((e) => {
      for (const f of e.fields) {
        if (f.ref && !this.#entities.has(f.ref)) throw new Error(`entity "${e.name}", field "${f.name}": ref "${f.ref}" is not an entity`)
        perm(f.permission, `entity "${e.name}", field "${f.name}"`)
      }
      const fields: ManifestField[] = e.fields.map((f) => ({
        name: f.name,
        type: f.type,
        required: f.required,
        ...(f.enum ? { enum: f.enum } : {}),
        ...(f.role ? { role: f.role } : {}),
        label: L(f.label ?? f.name)!,
        ...(f.ref ? { ref: f.ref } : {}),
        ...(f.permission ? { permission: f.permission } : {}),
        ...(f.filter ? { filter: true } : {}),
        ...(f.sort ? { sort: true } : {}),
        ...(f.search ? { search: true } : {}),
        ...(f.labels ? { labels: Object.fromEntries(Object.entries(f.labels).map(([k, v]) => [k, L(v)!])) } : {}),
        ...(f.tones ? { tones: f.tones } : {}),
        ...(f.currency ? { currency: f.currency } : {}),
        ...(f.untrusted ? { untrusted: true } : {}),
      }))
      return {
        name: e.name,
        label: L(e.config.label)!,
        plural: L(e.config.plural ?? e.config.label)!,
        ...(e.config.description ? { description: L(e.config.description) } : {}),
        ...(e.config.icon ? { icon: e.config.icon } : {}),
        ...perm(e.config.permission, `entity "${e.name}"`),
        schema: plainSchema(jsonSchemaOf(e.config.schema)) as Record<string, unknown>,
        fields,
        tools: { list: e.tools.list, get: e.tools.get },
        searchable: e.fields.some((f) => f.search),
      }
    })
    const actions = [...this.#actions.values()].map((a) => ({
      name: a.name,
      tool: { name: a.tool, plain: a.plain },
      ...(a.entity ? { entity: a.entity.name } : {}),
      title: L(a.config.title)!,
      ...(a.config.description ? { description: L(a.config.description) } : {}),
      ...(a.config.icon ? { icon: a.config.icon } : {}),
      input: labelled(a.input),
      readOnly: !a.write,
      confirm: a.confirm,
      ...perm(a.config.permission, `action "${a.name}"`),
    }))
    const everyone: Caller = { installation: "manifest", installationId: "manifest", person: null, permissions: new Set(this.#permissions.keys()), host: "workspace", issuer: "", subject: "" }
    const pages = this.#allPages().map((p) => {
      const c = p.config
      const base = {
        name: p.name,
        kind: c.kind,
        ...(c.kind !== "record" || c.title ? { title: L(c.kind === "record" ? (c.title ?? this.#entities.get(c.entity.name)!.config.label) : c.title)! } : { title: L(this.#entities.get(c.entity.name)!.config.label)! }),
        ...(c.icon ? { icon: c.icon } : c.kind === "record" || c.kind === "list" ? (this.#entities.get(c.entity.name)!.config.icon ? { icon: this.#entities.get(c.entity.name)!.config.icon } : {}) : {}),
        ...perm(c.permission, `page "${p.name}"`),
        params: plainSchema(jsonSchemaOf(this.#pageParams(p, everyone), "input")) as Record<string, unknown>,
      }
      const override = c.kind !== "custom" && c.view ? { view: this.#pageViewUri(p.name) } : {}
      if (c.kind === "list") return { ...base, entity: c.entity.name, columns: c.columns, tool: p.tool, ...override }
      if (c.kind === "record") {
        for (const s of c.sections ?? []) for (const f of s.fields) if (!c.entity.fields.some((x) => x.name === f)) throw new Error(`page "${p.name}": field "${f}" is not a field of ${c.entity.name}`)
        return { ...base, entity: c.entity.name, tool: p.tool, ...override, ...(c.sections ? { sections: c.sections.map((s) => ({ title: L(s.title)!, fields: s.fields })) } : {}), ...(p.derived ? { derived: true } : {}) }
      }
      if (c.kind === "dashboard") return { ...base, tool: p.tool, view: this.#pageViewUri(p.name) }
      return { ...base, tool: p.tool, view: this.#pageViewUri(p.name), ...("url" in c ? { url: c.url } : {}) }
    })
    const fragments = [
      ...[...this.#entities.values()].map((e) => ({ type: e.name, title: L(e.config.label)!, entity: e.name, template: "record" as const, params: { type: "object", properties: { id: { type: "string" } }, required: ["id"] }, tool: e.tools.get, ...(e.config.view ? { view: this.#entityViewUri(e.name) } : {}), ...perm(e.config.permission, `entity "${e.name}"`) })),
      ...[...this.#fragments.values()].map((f) => {
        for (const h of f.config.actions ?? []) if (!this.#actions.has(h.tool)) throw new Error(`fragment "${f.type}": action ${h.tool} is not registered`)
        return {
          type: f.type,
          title: L(f.config.title)!,
          description: L(f.config.description),
          ...(f.config.icon ? { icon: f.config.icon } : {}),
          params: plainSchema(jsonSchemaOf(f.config.params, "input")) as Record<string, unknown>,
          ...(f.config.template ? { template: f.config.template } : {}),
          ...(f.config.view ? { view: this.#fragmentViewUri(f.type) } : {}),
          tool: f.tool,
          ...perm(f.config.permission, `fragment "${f.type}"`),
          ...(f.config.actions?.length ? { actions: f.config.actions.map((h) => h.name) } : {}),
          ...(f.config.size ? { size: f.config.size } : {}),
          ...(f.config.untrusted ? { untrusted: true } : {}),
        }
      }),
    ]
    const agents = [...this.#agents.entries()].map(([name, a]) => {
      // An agent's tools: entities (their reads) and actions, by name; or tool names as they are.
      const tools = a.tools.flatMap((x) => {
        const n = typeof x === "string" ? x : x.kind === "entity" ? x.name : x.name
        const entity = this.#entities.get(n)
        if (entity) return [entity.tools.list.name, entity.tools.get.name]
        const action = [...this.#actions.values()].find((y) => y.name === n || y.tool === n)
        if (action) return [action.tool]
        if (this.#toolNames.has(n) || n === "search" || n === "fetch") return [n]
        throw new Error(`agent "${name}": "${n}" is not an entity, action or tool of this app`)
      })
      return { name, title: L(a.title)!, description: L(a.description)!, instructions: a.instructions, tools, tier: a.tier ?? "standard", ...(a.starters?.length ? { starters: a.starters.map((s) => L(s)!) } : {}) }
    })
    const auth = this.options.auth ?? {}
    this.#manifest = {
      specVersion: SPEC_VERSION,
      name: this.name,
      title: L(this.options.title)!,
      version: this.options.version,
      ...(this.options.description ? { description: L(this.options.description) } : {}),
      ...(this.options.icons ? { icons: this.options.icons } : {}),
      locale: this.locale,
      mcp: { url: "/mcp" },
      // The server's own address is what its tokens are for (never a name an app could claim): a host installs the app from it or not at all.
      auth: { ...(auth.resource ? { resource: auth.resource } : {}), authorizationServers: auth.authorizationServers ?? (auth.issuers ?? []).map((i) => i.issuer) },
      view: this.#viewUri(),
      resolveTool: RESOLVE_TOOL,
      ...([...this.#entities.values()].some((e) => e.fields.some((f) => f.search)) ? { searchTool: "search" } : {}),
      entities,
      actions,
      pages,
      fragments,
      agents,
      permissions: [...this.#permissions.entries()].map(([id, p]) => ({ id, label: L(p.label)!, ...(p.description ? { description: L(p.description) } : {}), default: p.default === true })),
      settings: [...this.#settings.entries()].map(([id, s]) => ({
        id,
        label: L(s.label)!,
        ...(s.description ? { description: L(s.description) } : {}),
        type: s.type,
        required: s.required === true,
        ...(s.default !== undefined ? { default: s.default } : {}),
      })),
    }
    return this.#manifest!
  }

  // ------------------------------------------------------------ dev helpers

  async #devStarted(): Promise<DevAuthority> {
    if (!this.#dev) throw new Error("auth.dev is off")
    this.#devReady ??= this.#dev.start()
    await this.#devReady
    return this.#dev
  }

  /** A dev access token (tests, local hosts). `host: "workspace"` makes the SDK ask for confirmation proofs. */
  async devToken(input: { person?: string | Person; permissions?: string[] | "all"; host?: "workspace" | "plain"; installation?: string; locale?: string } = {}): Promise<string> {
    const dev = await this.#devStarted()
    return dev.token({ ...input, audience: DEV_ISSUER })
  }

  /** A dev confirmation proof for one call (what a workspace host signs after «Confirm»). */
  async devConfirmation(input: { tool: string; args: Record<string, unknown>; call: string; person?: string; installation?: string }): Promise<string> {
    const dev = await this.#devStarted()
    const sub = input.person ?? dev.people[0]!.id
    return signConfirmation(dev.key, { iss: DEV_ISSUER, aud: DEV_ISSUER, sub, installation: input.installation ?? dev.installation, tool: input.tool, args: input.args, call: input.call })
  }

  // ------------------------------------------------------------ HTTP

  #origin(request: Request): string {
    const url = new URL(request.url)
    const proto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() || url.protocol.replace(":", "")
    const host = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim() || request.headers.get("host") || url.host
    return `${proto}://${host}`
  }

  async #caller(request: Request, resource: string, trust: RequestTrust): Promise<Caller | Response> {
    const auth = this.options.auth ?? {}
    const bearer = /^Bearer\s+(.+)$/i.exec(request.headers.get("authorization") ?? "")?.[1]?.trim()
    const metadata = `${new URL(resource).origin}/.well-known/oauth-protected-resource${new URL(resource).pathname}`
    const challenge = (reason: string) =>
      new Response(JSON.stringify({ error: "invalid_token", error_description: reason }), {
        status: 401,
        headers: { "content-type": "application/json", "www-authenticate": `Bearer resource_metadata="${metadata}", error="invalid_token", error_description="${reason.replace(/"/g, "'")}"`, ...CORS },
      })
    if (!bearer) {
      if (auth.anonymous) {
        const a = auth.anonymous
        return { installation: tenantOf(a.installation, "anonymous"), installationId: a.installation, person: a.person ?? null, permissions: new Set(a.permissions === "all" ? this.#allPermissions() : a.permissions), ...(a.locale ? { locale: a.locale } : {}), host: "plain", issuer: "anonymous", subject: a.person?.id ?? "anonymous" }
      }
      return challenge("sign in first")
    }
    if (trust.dev) await this.#devStarted()
    try {
      return await this.#verifier.verify(bearer, trust)
    } catch (error) {
      return challenge(error instanceof AuthError ? error.message : "invalid token")
    }
  }

  /**
   * One HTTP request (Fetch API): MCP at `/mcp`, the manifest, OAuth metadata, the dev authority, `/health`.
   * `info.remoteAddress`: the address the request came from. Dev sign-in and dev tokens count only when it is
   * a loopback address, checked on every request (`listen` passes the socket's; without it dev mode stays shut).
   */
  async fetch(request: Request, info: { remoteAddress?: string | null } = {}): Promise<Response> {
    const url = new URL(request.url)
    const origin = this.#origin(request)
    const auth = this.options.auth ?? {}
    const devHere = Boolean(this.#dev) && isLoopback(info.remoteAddress)
    // In dev the server is whatever address the caller reached it by (a tunnel); otherwise only its configured one.
    const requestResource = `${origin}/mcp`
    const resource = devHere ? requestResource : (auth.resource ?? requestResource)
    const trust: RequestTrust = { dev: devHere, requestResource: devHere ? requestResource : null }
    const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...CORS, ...headers } })
    // Preflight: the headers the browser asks for are allowed as asked (MCP 2026-07-28 clients send mcp-method, mcp-name, Mcp-Param-*; no cookies are ever used).
    if (request.method === "OPTIONS") {
      const asked = request.headers.get("access-control-request-headers")
      return new Response(null, { status: 204, headers: { ...CORS, ...(asked && /^[\w\-, ]{1,2000}$/.test(asked) ? { "access-control-allow-headers": asked } : {}), "access-control-max-age": "600", vary: "access-control-request-headers" } })
    }
    if (url.pathname === MANIFEST_PATH) return json(this.manifest(), 200, { "cache-control": "public, max-age=30" })
    if (url.pathname === "/" && request.method === "GET" && (request.headers.get("accept") ?? "").includes("application/json")) return json({ name: this.name, manifest: MANIFEST_PATH, mcp: "/mcp" })
    if (url.pathname === "/health") return json({ ok: true, name: this.name, version: this.options.version })
    if (url.pathname === "/.well-known/oauth-protected-resource" || url.pathname === "/.well-known/oauth-protected-resource/mcp") {
      // Where a client signs a person in. With dev sign-in on it is this server alone: trusted issuers that are hosts sign their own tokens, a client has nothing to ask them.
      const servers = auth.authorizationServers ?? (devHere ? [origin] : (auth.issuers ?? []).map((i) => i.issuer))
      return json({ resource, authorization_servers: servers, bearer_methods_supported: ["header"], scopes_supported: [OAUTH_SCOPE], resource_name: localize(this.options.title, this.locale, this.locale) })
    }
    if (devHere) {
      const dev = await this.#devStarted()
      const answered = await dev.handle(request, origin, resource)
      if (answered) return answered
    }
    if (url.pathname !== "/mcp") return new Response(`${localize(this.options.title, this.locale, this.locale)}: MCP at /mcp, manifest at ${MANIFEST_PATH}`, { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } })
    const caller = await this.#caller(request, resource, trust)
    if (caller instanceof Response) return caller
    // Each call's arguments as received (the MCP SDK hands tools the parsed ones): what a confirmation proof and the idempotency check cover.
    const received = new Map<string | number, unknown>()
    if (request.method === "POST") {
      try {
        const body = JSON.parse(await request.clone().text()) as unknown
        for (const m of Array.isArray(body) ? body : [body]) {
          const message = m as { id?: unknown; method?: unknown; params?: { arguments?: unknown } } | null
          if (message && message.method === "tools/call" && (typeof message.id === "string" || typeof message.id === "number")) received.set(message.id, message.params?.arguments ?? {})
        }
      } catch {}
    }
    const response = await this.#handler.fetch(request, { authInfo: { token: "verified", clientId: caller.issuer, scopes: [], extra: { caller, request: { trust, received } satisfies RequestInfo } } })
    const headers = new Headers(response.headers)
    for (const [k, v] of Object.entries(CORS)) headers.set(k, v)
    return new Response(response.body, { status: response.status, headers })
  }

  /** Serves `fetch` on Node's HTTP server. Dev auth only on a loopback address. */
  async listen(options: { port?: number; host?: string; log?: boolean } = {}): Promise<{ url: string; close: () => Promise<void> }> {
    const port = options.port ?? 3000
    const host = options.host ?? "127.0.0.1"
    if (this.#dev && !isLoopback(host)) throw new Error(`auth.dev works only on a loopback address, not ${host}`)
    this.manifest()
    if (this.#dev) await this.#devStarted()
    const auth = this.options.auth ?? {}
    if (!this.#dev && !auth.issuers?.length && !auth.anonymous) console.warn(`[${PROTOCOL_ID}] nobody can sign in: give auth.issuers (with auth.resource), or turn on auth.dev while developing`)
    const http = createHttpServer(async (req, res) => {
      const started = Date.now()
      try {
        const response = await this.fetch(await toRequest(req), { remoteAddress: req.socket.remoteAddress ?? null })
        const headers: Record<string, string> = {}
        response.headers.forEach((v, k) => (headers[k] = v))
        res.writeHead(response.status, headers)
        if (response.body) {
          const reader = response.body.getReader()
          for (let r = await reader.read(); !r.done; r = await reader.read()) res.write(r.value)
        }
        res.end()
      } catch (error) {
        console.error(`[${PROTOCOL_ID} http]`, error)
        if (!res.headersSent) res.writeHead(500).end()
        else res.end()
      } finally {
        if (options.log !== false) console.log(`${new Date().toISOString()} ${req.method} ${req.url} ${res.statusCode} ${Date.now() - started}ms`)
      }
    })
    await new Promise<void>((resolve) => http.listen(port, host, resolve))
    const url = `http://${host}:${port}`
    console.log(`${localize(this.options.title, this.locale, this.locale)} — MCP ${url}/mcp · manifest ${url}${MANIFEST_PATH}`)
    if (this.#dev) console.log(`DEV AUTH ON (never in production) — sign-in code: ${this.#dev.code}`)
    return { url, close: () => new Promise((resolve) => http.close(() => resolve())) }
  }
}

const CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
  "access-control-allow-headers": "authorization, content-type, mcp-session-id, mcp-protocol-version, last-event-id",
  "access-control-expose-headers": "www-authenticate, mcp-session-id",
}

async function toRequest(req: IncomingMessage): Promise<Request> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  const headers = new Headers()
  for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(", ") : v)
  const body = chunks.length && req.method !== "GET" && req.method !== "HEAD" ? Buffer.concat(chunks) : undefined
  return new Request(`http://${req.headers.host ?? "localhost"}${req.url}`, { method: req.method, headers, ...(body ? { body } : {}) })
}
