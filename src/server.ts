import { AsyncLocalStorage } from "node:async_hooks"
import { createHash, randomUUID } from "node:crypto"

import { createMcpHandler, inputRequired, inputResponse, McpServer, type CallToolResult, type Icon, type ServerContext } from "@modelcontextprotocol/server"
import { entityKindProblems, keyOf, kindNameProblem, kindDefinitionProblems, kindOfRecord, kindSentence, kindsOf, normaliseKey, type KindDef, type KindField, type Normalisation } from "../spec/src/kinds"
import { DELETE_TOOL, type AppAccent, EXPORT_TOOL, INSTALLATION_TOOL, INSTALLATION_TOOLS, LATER_TOOL, META_KEY, OAUTH_SCOPE, PROTOCOL_ID, RESOLVE_TOOL, SITE_BRIDGE_PATH, URI_SCHEME, uriPrefix, VIEW_TOOL, VIEWS_PATH } from "../spec/src/protocol"
import { viewPath, viewPolicy, ViewError, ViewTickets, withHost, type ViewDocument } from "./views"
import { LIMITS, manifestRuleProblems } from "../spec/src/rules"
import { z } from "zod"

import { argsHash, AuthError, canonicalJson, DEV_ISSUER, DevAuthority, INSTALLATION, isLoopback, laterDeadline, signConfirmation, tenantOf, TokenVerifier, type AuthOptions, type Caller, type Person, type RequestTrust } from "./auth"
import { DpopError } from "./dpop"
import { siteBridgeScript, siteFraming, siteStart, type SiteOptions } from "./site"
import { MANIFEST_PATH, manifestUri, SPEC_VERSION, type Manifest, type ManifestField } from "./manifest"
import { isLabel, labelMap, localize, type Label } from "./labels"
import { fieldsOf, jsonSchemaOf, kindRef, localRef, plainSchema, type FieldInfo } from "./meaning"
import { MemoryStore, type IdempotencyStore, type LaterOutcome, type LaterRun } from "./store"
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
  ArtifactConfig,
  ArtifactInstance,
  ComponentConfig,
  KindConfig,
  LaterInfo,
  LifecycleConfig,
  NavSection,
  Notification,
  NotificationTypeConfig,
  PageConfig,
  PermissionConfig,
  Publisher,
  Query,
  ScheduleConfig,
  SettingConfig,
  Template,
  ViewSource,
  WidgetConfig,
  WidgetSize,
} from "./types"
import { MCP_APP_MIME_TYPE, viewHtml } from "./view"
import { A2UI_MIME_TYPE, appCatalog, appCatalogId, COMPONENT_NAME, componentSurface, recordSurface, RESERVED_COMPONENTS, surfaceResourceUri, templateSurface, type ComponentEntry } from "./a2ui"

/**
 * THE CLEGRA APP SERVER, v1 (docs/spec.md): an MCP server
 * (official SDK, Streamable HTTP, stateless) whose declarations — entities,
 * actions, pages, artifacts, agents, permissions, settings — become plain MCP
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
export type RequestInfo = {
  trust: RequestTrust
  received: ReadonlyMap<string | number, unknown>
  /** The public origin the request reached (what a same-site `url` page is resolved against), when known. */
  origin?: string
}

/** The DPoP proof algorithms the SDK verifies (`algs` of its DPoP challenge, RFC 9449 §7.1). */
const DPOP_ALGS = "EdDSA ES256"

/** The issuer name of callers named by the app's own `auth.resolve`. */
export const OWN_ISSUER = "app"

export type ServerOptions = {
  /** The app id: lowercase letters, digits, `-`; 2–40 characters. */
  name: string
  title: Label
  version: string
  description?: Label
  icons?: Icon[]
  /** The app's tint (spec §2), one of `APP_ACCENTS`, like an Apple app's: its buttons, selection and links in Clegra. Default `blue`. */
  accent?: AppAccent
  /**
   * Who publishes the app (spec §2): a name and the publisher's web address (https). A claim, granting nothing: a
   * store or host may verify it against the address's domain and show it as verified.
   */
  publisher?: Publisher
  /** The locale of bare-string labels (default `en`). */
  locale?: string
  auth?: AuthOptions
  /**
   * Where the app's own routes live on its public address (default none): MCP at `<path>/mcp`, `<path>/health`.
   * The manifest and the OAuth metadata stay where their standards put them, under `/.well-known/` at the root.
   */
  path?: string
  /** MCP `instructions` for models. */
  instructions?: string
  websiteUrl?: string
  /** Where write results and used token ids are kept (default: in memory; several instances share one). */
  store?: IdempotencyStore
  /** Escape hatch: the raw McpServer of each request, to add hand-written tools, resources or views. */
  mcp?: (server: McpServer, caller: Caller | null) => void
  /** The names of people of the installation by their ids (the values of `person` fields): what a host shows in place of an id. */
  people?: PeopleResolver
  /**
   * The origins of the workspace clients that frame the app (Clegra's web and desktop clients): its site's pages and
   * its views are framable by them only (spec §5.1, §5.3). Default none.
   */
  clientOrigins?: string[]
  /** The app's own website, shown as it is in a workspace client's frame (spec §5.1): where it opens. People sign in there with the app's own sign-in. */
  site?: SiteOptions
}

/**
 * The app's own site (spec §5.1), for whatever serves its pages (`@clegra/sdk/next`'s `siteProxy` and
 * `getClegraCaller`, or any server): who calls a page, and what a page request answers in front of the app.
 */
export type AppSite = {
  /** Where the site opens (`/`). */
  readonly start: string
  /** The workspace clients that may frame it. */
  readonly clientOrigins: readonly string[]
  /** The headers in front of every page of the site: framable by the app itself and its client origins only. */
  headers(): Record<string, string>
}

/** Names by person id, for the ids it knows (spec §3, «People»). An id it leaves out is shown as an unknown person, never as the id. */
export type PeopleResolver = (ids: string[], ctx: Context) => Record<string, string> | Promise<Record<string, string>>

/** The one `_meta` key of the host protocol (spec §7): `{ call, confirmation, settings }` on requests, `{ notifications, untrusted, l10n }` on results. */
export { META_KEY }
type HostMeta = { call?: unknown; confirmation?: unknown; confirmed?: unknown; settings?: unknown; schedule?: unknown }
const hostMeta = (meta: Record<string, unknown> | undefined): HostMeta => {
  const m = meta?.[META_KEY]
  return m && typeof m === "object" && !Array.isArray(m) ? (m as HostMeta) : {}
}

export type ErrorCode = "unauthorized" | "permission_denied" | "not_found" | "invalid_input" | "confirmation_required" | "conflict" | "rate_limited" | "internal"

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
/** `keys`: the fields that hold a key of the entity's kind (spec §3.1 rule 5), with how their values compare. */
type EntityRecord = { name: string; config: EntityConfig<z.ZodObject>; fields: FieldInfo[]; handle: EntityHandle; tools: { list: ToolName; get: ToolName }; keys: Map<string, { property: string; how: Normalisation }> }
type ActionRecord = {
  name: string
  tool: string
  entity?: EntityRecord
  config: ActionConfig<z.ZodObject, EntityHandle | undefined>
  input: z.ZodObject
  handler: ActionHandler<z.ZodObject, EntityHandle | undefined>
  write: boolean
  confirm: "always" | "optional" | "never"
  plain: boolean
  /** «Approve now, act later»: the input that says when, and the minutes it may run late. */
  later?: { at: string; window: number }
}
/** A schedule as the server runs it: the SDK's own `clegra_later` has no action. */
type ScheduleRecord = { name: string; action?: ActionRecord; tool: string; every: number; maxSeconds: number }
/** A notification as a result carries it (`_meta.clegra.notifications`): its texts in the caller's language, its recipients said. */
export type SentNotification = { type?: string; title: string; body?: string; uri?: string; to: string[] | "admins" }
/** What one pass over the due later runs did: each run's outcome, and the notifications for the host to deliver. */
export type LaterReport = { runs: { id: string; tool: string; at: string; status: LaterOutcome["status"]; message: string }[]; notifications: SentNotification[] }
type PageRecord = { name: string; config: PageConfig; derived?: boolean; tool: ToolName }
type ArtifactRecord = { type: string; config: ArtifactConfig<z.ZodObject, Template>; tool: ToolName }

const NAME = /^[a-z][a-z0-9-]{1,39}$/
const IDENT = /^[a-z][a-z0-9_]{0,39}$/
const PERMISSION = /^[a-z][a-z0-9_-]{0,39}\.[a-z][a-z0-9_-]{0,39}$/
const RESERVED_PARAMS = new Set(["query", "sort", "dir", "cursor", "limit", "id"])
const RESERVED_TOOLS = new Set(["search", "fetch", RESOLVE_TOOL, VIEW_TOOL, ...INSTALLATION_TOOLS])
/** How far in the past a later run's `at` may be when it is confirmed, and how far ahead. */
const LATER_PAST_MS = 5 * 60_000
const LATER_AHEAD_MS = 366 * 24 * 3600_000
/** Later runs taken per pass. */
const LATER_BATCH = 25
/** The largest export a host takes. */
const EXPORT_MAX_BYTES = 512 * 1024 * 1024
/** The words of the SDK's own notification when a later run did not run, per language (the app's locale when the caller's is missing). */
const DID_NOT_RUN: Record<string, (title: string) => string> = { en: (t) => `«${t}» did not run`, it: (t) => `«${t}» non è stata eseguita` }
/** The SDK's notification type for later runs that did not run. */
const LATER_NOTIFICATION: NotificationTypeConfig = { label: { en: "Scheduled actions that did not run", it: "Azioni programmate non eseguite" }, description: { en: "An action you confirmed for later expired or was refused.", it: "Un'azione confermata per dopo è scaduta o è stata rifiutata." }, default: true }
/** The `_meta` of a tool only views and the host's own UI call: never a model's (MCP Apps visibility, ChatGPT). */
const APP_ONLY_META = { ui: { visibility: ["app"] }, "openai/visibility": "private", "openai/widgetAccessible": true }

/** The fixed hint on the tools of an entity with cross-app references (spec §3.2): how a model opens such a record. */
export const CROSS_INPUT_HINT = "An input that takes a record of another app takes its URI (clegra://<app>/<entity>/<id>), as that app's search or lists give it."
export const CROSS_APP_HINT = "A record of another app appears as { uri, kind }: the app the URI names opens it with its fetch tool."

/** JSON Schema formats of key properties (spec §6: a key filter carries `format` where JSON Schema has one). */
const KEY_FORMATS: Record<string, string> = { email: "email" }

/** A field as the kind rules read it (spec/src/kinds.ts): its meaning, and an array's item type. */
function kindField(f: FieldInfo): KindField {
  const items = f.schema.items as { type?: unknown } | undefined
  const itemType = f.type === "array" && items && typeof items.type === "string" ? items.type : undefined
  return { name: f.name, type: f.type, required: f.required, ...(f.enum ? { enum: f.enum } : {}), ...(f.permission ? { permission: f.permission } : {}), ...(f.as !== undefined ? { as: f.as } : {}), ...(f.filter ? { filter: true } : {}), ...(f.currency ? { currency: f.currency } : {}), ...(itemType ? { itemType } : {}) }
}

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

/**
 * The key of a record action's display hint (spec §6 rule 10): the record's title as the model read it, for a client's
 * own approval prompt. Never trusted: the app names the record from `id`; a hint that names another record stops the call.
 */
export const RECORD_TITLE_PARAM = "record_title"
/** A title compared as a person reads it: the untrusted wrapper and its escapes undone, case, width, quotes and spaces ignored. */
const comparableTitle = (value: string) =>
  value
    .replace(/<\/?untrusted>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^["'«»“”‘’]+|["'«»“”‘’]+$/g, "")
    .trim()
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

// ------------------------------------------------------------ labels for views (spec §7, `_meta.clegra.l10n`)

/** Per locale: each label as this call showed it → the same label in that locale. */
type L10n = Map<string, Record<string, string>>
const shownLabels = new AsyncLocalStorage<L10n>()

/**
 * A label in `locale`; inside a tool call, its other locales are noted too, so the call's view can draw it
 * in the reader's language (MCP Apps `hostContext.locale`), whatever language the token named.
 */
function say(label: Label | undefined, locale: string | undefined, fallback: string): string {
  const shown = localize(label, locale, fallback)
  const notes = shownLabels.getStore()
  if (notes && label && typeof label === "object" && shown) {
    for (const [l, value] of Object.entries(label)) {
      // Every locale, the shown one too (as itself): a reader in the shown language must not fall back to another.
      if (typeof value !== "string") continue
      let d = notes.get(l)
      if (!d) notes.set(l, (d = {}))
      d[shown] ??= value
    }
  }
  return shown
}

/** The labels a call showed, beside its result (`_meta.clegra.l10n`), for its view only: a model never reads `_meta`. */
function withL10n(result: CallToolResult, notes: L10n): CallToolResult {
  if (!notes.size) return result
  const meta = (result._meta ?? {}) as Record<string, unknown>
  const own = (meta[META_KEY] && typeof meta[META_KEY] === "object" ? meta[META_KEY] : {}) as Record<string, unknown>
  return { ...result, _meta: { ...meta, [META_KEY]: { ...own, l10n: Object.fromEntries(notes) } } }
}

/**
 * A tool's input as it is listed (the same JSON Schema), left for the SDK's own handler to check: an action's
 * input is validated there (#runAction), so what is wrong is said field by field, in the caller's language,
 * as a tool error a view and a model can read, not as a protocol error in English.
 */
function listedOnly(schema: z.ZodObject, title: (label: Label) => string): z.ZodObject {
  const std = (schema as unknown as { "~standard": Record<string, unknown> })["~standard"]
  // Listed as plain JSON Schema: the meaning keys (`label`, `ref`, `currency`, …) are the manifest's, a plain client gets each field's `title`.
  const listed = () => {
    const raw = jsonSchemaOf(schema, "input") as { properties?: Record<string, Record<string, unknown>> }
    const plain = plainSchema(raw) as { properties?: Record<string, Record<string, unknown>> }
    for (const [k, p] of Object.entries(raw.properties ?? {})) if (isLabel(p.label) && plain.properties?.[k]) plain.properties[k]!.title = title(p.label)
    return plain
  }
  return { "~standard": { ...std, validate: (value: unknown) => ({ value }), jsonSchema: { input: listed, output: listed } } } as unknown as z.ZodObject
}

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
  readonly #artifacts = new Map<string, ArtifactRecord>()
  readonly #components = new Map<string, ComponentConfig>()
  readonly #agents = new Map<string, AgentConfig>()
  readonly #permissions = new Map<string, PermissionConfig>()
  readonly #settings = new Map<string, SettingConfig>()
  readonly #schedules = new Map<string, { action: ActionHandle; every: number; maxSeconds: number }>()
  readonly #notificationTypes = new Map<string, NotificationTypeConfig>()
  #nav: NavSection[] | null = null
  #lifecycle: LifecycleConfig = {}
  #kinds: Record<string, KindConfig> = {}
  #manifest: Manifest | null = null
  #devReady: Promise<void> | null = null
  readonly #path: string
  readonly #site: { start: string } | null
  readonly #clientOrigins: string[]
  readonly #viewTickets: ViewTickets | null
  #warnedStore = false
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
    if (auth.anonymous && process.env.NODE_ENV === "production") throw new Error("auth.anonymous is for local demos: it is refused when NODE_ENV is production (public operations: auth.public)")
    if (auth.anonymous && auth.public) throw new Error("auth.anonymous and auth.public: one or the other (a call without a token is either a local demo's caller or the public caller)")
    if (auth.public && (typeof auth.public.installation !== "string" || !INSTALLATION.test(auth.public.installation))) throw new Error("auth.public.installation must match [A-Za-z0-9._:-]{1,128}")
    const path = (options.path ?? "").replace(/\/+$/, "")
    if (path && !/^(\/[A-Za-z0-9._~-]+)+$/.test(path)) throw new Error(`path "${options.path}": a URL path like /api/clegra`)
    this.#path = path
    this.#store = options.store ?? new MemoryStore()
    this.#verifier = new TokenVerifier(auth, (key, ttlMs) => this.#store.once(key, ttlMs))
    this.#dev = auth.dev ? new DevAuthority(auth.dev === true ? {} : auth.dev, { name: this.name, title: localize(options.title, this.locale, this.locale), allPermissions: () => [...this.#permissions.keys()] }) : null
    if (this.#dev) this.#verifier.useDev(this.#dev)
    this.#clientOrigins = (options.clientOrigins ?? []).map((o) => {
      // A web origin, or a desktop client's own scheme (`app://client`): scheme, host and port, nothing more.
      const value = o.replace(/\/$/, "").toLowerCase()
      if (!/^[a-z][a-z0-9+.-]*:\/\/[a-z0-9.-]+(:\d{1,5})?$/.test(value)) throw new Error(`clientOrigins: "${o}" must be an origin (scheme, host and port, no path)`)
      return value
    })
    this.#site = options.site ? { start: siteStart(options.site.start) } : null
    this.#viewTickets = this.#clientOrigins.length ? new ViewTickets(this.#store, () => this.#clientOrigins) : null
  }

  // ------------------------------------------------------------ the app's own site (spec §5.1)

  /** The app's origin: its configured public address, else the one the request reached. */
  #appOrigin(requestOrigin: string): string {
    const resource = this.options.auth?.resource ?? this.options.auth?.signIn?.resource
    return resource ? new URL(resource).origin : requestOrigin
  }

  /** The site's side for whatever serves its pages: null when the app declares no `site`. */
  get site(): AppSite | null {
    const site = this.#site
    if (!site) return null
    const origins = this.#clientOrigins
    return { start: site.start, clientOrigins: [...origins], headers: () => ({ "content-security-policy": siteFraming(origins) }) }
  }

  // ------------------------------------------------------------ registration

  #taken(name: string): void {
    if (this.#entities.has(name) || this.#artifacts.has(name)) throw new Error(`"${name}" is already an entity or an artifact type (they share one namespace)`)
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

  /** The namespaced kinds this app defines (spec §3.1), before any entity that uses them. */
  defineKinds(kinds: Record<string, KindConfig>): void {
    if (this.#entities.size) throw new Error("kinds: define them before the entities")
    const problems = kindDefinitionProblems(kinds as unknown as Record<string, KindDef>)
    if (problems.length) throw new Error(problems.join("; "))
    this.#kinds = { ...kinds }
    this.#changed()
  }

  /** An entity (spec §4): a Zod object with `.meta()` meaning, and its reads. */
  registerEntity<S extends z.ZodObject>(name: string, config: EntityConfig<S>): EntityHandle<S> {
    if (!IDENT.test(name)) throw new Error(`entity "${name}": lowercase letters, digits and _, starting with a letter`)
    this.#taken(name)
    const fields = fieldsOf(name, config.schema)
    for (const f of fields) if ((f.filter || f.sort) && RESERVED_PARAMS.has(f.name) && f.name !== "id") throw new Error(`entity "${name}": field "${f.name}" can't be a filter or sort (reserved parameter name)`)
    // Kinds (spec §3.1): what `as` says must hold for the entity's kind, or the definition fails here, not at a host.
    const own = this.#kinds as unknown as Record<string, KindDef>
    const problems = entityKindProblems(`entity "${name}"`, config.kind, fields.map(kindField), own)
    if (problems.length) throw new Error(problems.join("; "))
    const keys = new Map<string, { property: string; how: Normalisation }>()
    for (const f of fields) {
      const how = f.as ? keyOf(f.as, kindsOf(config.kind), own) : null
      if (how) keys.set(f.name, { property: f.as!, how })
    }
    const handle: EntityHandle<S> = { kind: "entity", name, schema: config.schema, fields, uri: (id) => this.uri(name, id) }
    const plain = config.expose?.plain !== false
    const tools = { list: { name: config.expose?.list ?? `${name}_list`, plain }, get: { name: config.expose?.get ?? `${name}_get`, plain } }
    this.#claimTools(tools.list.name, tools.get.name)
    this.#entities.set(name, { name, config: config as unknown as EntityConfig<z.ZodObject>, fields, handle: handle as unknown as EntityHandle, tools, keys })
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
    if (entity && RECORD_TITLE_PARAM in input.shape) throw new Error(`action "${name}": "${RECORD_TITLE_PARAM}" is the record's title hint, given by the SDK; don't declare it in input`)
    const write = config.readOnly !== true
    const confirm = write ? (config.confirm ?? "always") : "never"
    if (config.public) {
      // Public operations (spec §7): one call, no record to see, no permission to hold, and a write the host always confirms.
      if (entity) throw new Error(`action "${name}": a public action is global (no entity): a caller without a token sees no record`)
      if (config.permission) throw new Error(`action "${name}": a public action needs no permission (a caller without a token holds none)`)
      if (write && confirm !== "always") throw new Error(`action "${name}": a public write is always confirmed (confirm: "always")`)
      if (config.expose?.plain === false || config.visibility === "app") throw new Error(`action "${name}": a public action is for every client (no plain: false, no visibility "app")`)
    }
    // Every client acts with a delegation the app issued (or as the public caller): its writes reach every client,
    // unless the developer keeps one for the app's own views (`expose.plain: false`, spec §6).
    const plain = config.public ? true : (config.expose?.plain ?? true)
    if (config.later && !this.#store.later) throw new Error(`action "${name}": later keeps the confirmed call in the store, and this store has no later part (MemoryStore and SqlStore have one)`)
    const later = config.later ? { at: String(config.later.at), window: config.later.window ?? LIMITS.laterWindow.default } : undefined
    this.#actions.set(tool, { name, tool, ...(entity ? { entity } : {}), config: config as never, input, handler: handler as never, write, confirm, plain, ...(later ? { later } : {}) })
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
    const tool = config.kind === "record" ? this.#entities.get(config.entity.name)!.tools.get : { name: config.expose?.tool ?? `open_${name}`, plain: config.expose?.plain !== false }
    if (config.kind !== "record") this.#claimTools(tool.name)
    this.#pages.set(name, { name, config: config as unknown as PageConfig, tool })
    this.#changed()
    return { kind: "page", name }
  }

  /** An artifact type (spec §7): params, live data, a native template or an MCP Apps view. */
  registerArtifact<P extends z.ZodObject, T extends Template>(type: string, config: ArtifactConfig<P, T>): { readonly kind: "artifact"; readonly type: string } {
    if (!IDENT.test(type)) throw new Error(`artifact "${type}": lowercase letters, digits and _`)
    this.#taken(type)
    const component = (config as { component?: string }).component
    if (!config.template && !config.view && !component) throw new Error(`artifact "${type}": give a template, a component or a view`)
    if (component && (config.template || config.view)) throw new Error(`artifact "${type}": a component artifact has no template and no view of its own`)
    if (component && !this.#components.has(component)) throw new Error(`artifact "${type}": component "${component}" is not a component of this app`)
    const tool = { name: config.expose?.tool ?? `show_${type}`, plain: config.expose?.plain !== false }
    this.#claimTools(tool.name)
    this.#artifacts.set(type, { type, config: config as never, tool })
    this.#changed()
    return { kind: "artifact", type }
  }

  readonly #widgets = new Map<string, { sizes: WidgetSize[]; size: WidgetSize }>()

  /** An artifact type offered as a Home widget (spec §5.5), in declaration order; its sizes default to medium and large. */
  registerWidget(artifact: string, config: WidgetConfig = {}): void {
    if (this.#widgets.has(artifact)) throw new Error(`widget "${artifact}" is registered twice`)
    const sizes = config.sizes?.length ? [...config.sizes] : (["medium", "large"] as WidgetSize[])
    this.#widgets.set(artifact, { sizes, size: config.size ?? sizes[0]! })
    this.#changed()
  }

  /** One of the app's own A2UI components (spec §5.4 rule 6): a page of the app drawing the props a host gives it. */
  registerComponent(name: string, config: ComponentConfig): void {
    if (!COMPONENT_NAME.test(name)) throw new Error(`component "${name}": a capital letter, then letters and digits (at most 40)`)
    if ((RESERVED_COMPONENTS as readonly string[]).includes(name)) throw new Error(`component "${name}": the name of an A2UI Basic Catalog or Clegra component`)
    if (this.#components.has(name)) throw new Error(`component "${name}" is registered twice`)
    this.#components.set(name, config)
    this.#changed()
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

  /** The navigation: sections of pages (their references are checked with the manifest). */
  registerNav(sections: NavSection[]): void {
    this.#nav = sections.map((s) => ({ ...s, pages: [...s.pages] }))
    this.#changed()
  }

  /** A schedule: a global action the workspace host runs as the installation every `every` minutes. */
  registerSchedule(name: string, config: ScheduleConfig): void {
    if (name === LATER_TOOL) throw new Error(`schedule "${name}" is reserved (the SDK runs later actions with it)`)
    if (this.#schedules.has(name)) throw new Error(`schedule "${name}" is registered twice`)
    this.#schedules.set(name, { action: config.action, every: config.every, maxSeconds: config.maxSeconds ?? LIMITS.scheduleSeconds.default })
    this.#changed()
  }

  /** A notification type the app's notifications name (`ctx.notify({ type })`). */
  registerNotificationType(type: string, config: NotificationTypeConfig): void {
    if (type === LATER_TOOL) throw new Error(`notification "${type}" is reserved (the SDK tells a later run's author with it)`)
    if (!IDENT.test(type)) throw new Error(`notification "${type}": lowercase letters, digits and _, starting with a letter`)
    this.#notificationTypes.set(type, config)
    this.#changed()
  }

  /** What the app does when the workspace host tells it of its installation, asks for its data, or asks it to delete them. */
  registerLifecycle(config: LifecycleConfig): void {
    for (const [k, v] of Object.entries(config)) {
      if (!["installation", "export", "delete"].includes(k)) throw new Error(`lifecycle: "${k}" is not installation, export or delete`)
      if (v !== undefined && typeof v !== "function") throw new Error(`lifecycle.${k}: a function`)
    }
    this.#lifecycle = { ...config }
    this.#changed()
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

  /** `clegra://<app>/<type>/<key>` (spec §4, §7). */
  uri(type: string | EntityHandle, key: string): string {
    return `${uriPrefix(this.name)}/${typeof type === "string" ? type : type.name}/${encodeURIComponent(key)}`
  }

  /** An artifact instance's URI: the record id for record cards, base64url of the sorted params' JSON otherwise. */
  artifactUri(instance: ArtifactInstance): string {
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
    if (this.#artifacts.has(type)) {
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

  /** Whether the caller administers the app, as its own sign-in says. */
  #isAdmin(caller: Caller): boolean {
    return caller.admin === true
  }

  /** The actions with `later`. */
  #laterActions(): ActionRecord[] {
    return [...this.#actions.values()].filter((a) => a.later)
  }

  /** Every schedule, the SDK's own `clegra_later` included when an action has later. */
  #allSchedules(): ScheduleRecord[] {
    const out: ScheduleRecord[] = [...this.#schedules.entries()].map(([name, s]) => {
      const action = this.#actions.get(s.action.tool)
      return { name, ...(action ? { action } : {}), tool: s.action.tool, every: s.every, maxSeconds: s.maxSeconds }
    })
    if (this.#laterActions().length) out.push({ name: LATER_TOOL, tool: LATER_TOOL, every: LIMITS.laterEvery, maxSeconds: LIMITS.scheduleSeconds.default })
    return out
  }

  /** Whether the caller is the installation itself: a workspace host's token without a person (schedules, later runs, lifecycle). */
  #isInstallation(caller: Caller): boolean {
    return caller.host === "workspace" && !caller.person
  }

  /**
   * Why a call's `_meta.clegra.schedule` is refused, or null: it names one of the app's schedules, of this very tool,
   * and comes from the installation-level caller (a workspace host, no person). A call without it is not a schedule's.
   */
  #scheduleProblem(tool: string, caller: Caller, meta: Record<string, unknown> | undefined): string | null {
    const name = hostMeta(meta).schedule
    if (name === undefined) return null
    if (!this.#isInstallation(caller)) return "a schedule's run comes from a workspace host as the installation, with no person"
    const s = typeof name === "string" ? this.#allSchedules().find((x) => x.name === name) : undefined
    if (!s) return `"${String(name)}" is not a schedule of this app`
    if (s.tool !== tool) return `schedule "${s.name}" runs ${s.tool}, not ${tool}`
    return null
  }

  /** A notification as `ctx.notify` takes it, checked: a declared type (or none when none is declared), recipients said when there is no person. */
  #checkNotification(n: Notification, caller: Caller): void {
    if (!n || typeof n !== "object") throw new Error("ctx.notify: give { title, … }")
    const types = [...this.#notificationTypes.keys()]
    if (types.length && (typeof n.type !== "string" || !this.#notificationTypes.has(n.type))) throw new Error(`ctx.notify: type ${n.type === undefined ? "is missing" : `"${String(n.type)}" is not declared`}: this app's notification types are ${types.join(", ")}`)
    if (!types.length && n.type !== undefined) throw new Error(`ctx.notify: type "${String(n.type)}": this app declares no notification types (declare them in notifications, or leave type out)`)
    const to = n.to
    if (to === undefined) {
      if (!caller.person) throw new Error("ctx.notify: this call has no person (a schedule, the installation itself): say who receives it in to")
    } else if (Array.isArray(to)) {
      if (!to.every((id) => typeof id === "string" && id)) throw new Error("ctx.notify: to is a list of person ids")
    } else if (to !== "admins") throw new Error(`ctx.notify: to is a list of person ids or "admins" (the company's administrators), not ${JSON.stringify(to)}`)
  }

  /** Notifications as a result carries them, in the caller's language; `to` said (default: the person of `caller`). */
  #sent(notes: Notification[], caller: Caller, ctx: Context): SentNotification[] {
    return notes.map((n) => ({
      ...(n.type !== undefined ? { type: n.type } : {}),
      title: ctx.t(n.title),
      ...(n.body !== undefined ? { body: ctx.t(n.body) } : {}),
      ...(n.uri !== undefined ? { uri: n.uri } : {}),
      to: n.to ?? (caller.person ? [caller.person.id] : []),
    }))
  }

  #notificationsMeta(sent: SentNotification[], changed: readonly string[] = []) {
    return sent.length || changed.length ? { _meta: { [META_KEY]: { ...(sent.length ? { notifications: sent } : {}), ...(changed.length ? { changed: [...changed] } : {}) } } } : {}
  }

  #context(caller: Caller, meta: Record<string, unknown> | undefined, notes: Notification[], run?: { later: LaterInfo; call: string | null }): Context {
    const locale = caller.locale ?? this.locale
    const host = hostMeta(meta)
    // Settings are the installation's, set by its administrator: only its workspace host says them (also when it runs a later run). A plain client gets the defaults.
    const sent = ((caller.host === "workspace" || run) && host.settings && typeof host.settings === "object" && !Array.isArray(host.settings) ? host.settings : {}) as Record<string, unknown>
    const settings: Record<string, unknown> = {}
    for (const [id, s] of this.#settings) {
      const v = sent[id]
      const ok = s.type === "number" ? typeof v === "number" : s.type === "boolean" ? typeof v === "boolean" : typeof v === "string"
      settings[id] = ok ? v : s.default
    }
    const call = run ? run.call : typeof host.call === "string" ? host.call : null
    const schedule = run ? LATER_TOOL : typeof host.schedule === "string" && this.#isInstallation(caller) && this.#allSchedules().some((x) => x.name === host.schedule) ? host.schedule : null
    return {
      app: this.name,
      installation: caller.installation,
      person: caller.person,
      permissions: caller.permissions,
      can: (p) => caller.permissions.has(p),
      locale,
      host: caller.host,
      admin: this.#isAdmin(caller),
      settings,
      call,
      schedule,
      later: run?.later ?? null,
      cancelLater: async (id) => (this.#store.later ? this.#store.later.cancel(String(id), caller.installation) : false),
      rateLimit: async (name, limit) => {
        if (!/^[A-Za-z0-9._:-]{1,64}$/.test(name)) throw new Error("ctx.rateLimit: name is letters, digits, . _ : -; at most 64")
        if (!Number.isInteger(limit.max) || limit.max < 1 || !Number.isInteger(limit.seconds) || limit.seconds < 1) throw new Error("ctx.rateLimit: max and seconds are whole numbers from 1")
        const who = limit.per === "tenant" ? "" : `:${caller.issuer}:${caller.subject}`
        const count = await this.#store.hit(`rate:${name}:${caller.installation}${who}`, limit.seconds * 1000)
        if (count > limit.max) throw new AppError("rate_limited", `Too many requests: at most ${limit.max} every ${limit.seconds} seconds. Try again later.`, { retryAfterSeconds: limit.seconds })
      },
      t: (label) => say(label, locale, this.locale),
      notify: (n) => {
        this.#checkNotification(n, caller)
        notes.push(n)
      },
      uri: (entity, id) => this.uri(entity, id),
      changed: (...what) => {
        const kept = this.#changes.get(notes) ?? new Set<string>()
        for (const w of what) kept.add(this.#changeOf(w))
        this.#changes.set(notes, kept)
      },
    }
  }

  /** What a call said it changed (`ctx.changed`), by the call's notifications list (one per call). */
  readonly #changes = new WeakMap<Notification[], Set<string>>()

  /** One thing a call changed, as `_meta.clegra.changed` says it: an artifact URI of this app, or a type of it. */
  #changeOf(what: string | EntityHandle): string {
    const name = typeof what === "string" ? what : what.name
    if (name.startsWith(`${URI_SCHEME}://`)) {
      const parsed = this.parseUri(name)
      if (!parsed || (!this.#entities.has(parsed.type) && !this.#artifacts.has(parsed.type))) throw new Error(`ctx.changed: ${name} is not an artifact URI of this app`)
      return name
    }
    if (!this.#entities.has(name) && !this.#artifacts.has(name)) throw new Error(`ctx.changed: "${name}" is not an entity, an artifact type or an artifact URI of this app`)
    return name
  }

  #t(caller: Caller | null, label: Label | undefined): string {
    return say(label, caller?.locale ?? this.locale, this.locale)
  }

  #visibleFields(entity: EntityRecord, caller: Caller): FieldInfo[] {
    return entity.fields.filter((f) => !f.permission || caller.permissions.has(f.permission))
  }

  /** Whether this caller reaches the entity at all, on any surface: its permission, and for a plain client its exposure. */
  #canSee(entity: EntityRecord, caller: Caller): boolean {
    if (caller.public) return false
    if (entity.config.permission && !caller.permissions.has(entity.config.permission)) return false
    return caller.host !== "plain" || entity.tools.get.plain
  }

  /** The same for an artifact type. */
  #canShow(f: ArtifactRecord, caller: Caller): boolean {
    if (caller.public) return false
    if (f.config.permission && !caller.permissions.has(f.config.permission)) return false
    return caller.host !== "plain" || f.tool.plain
  }

  /** Whether a URI inside an artifact's data points to something this caller reaches (a URI of another app is not ours to judge). */
  #uriVisible(uri: unknown, caller: Caller): boolean {
    if (typeof uri !== "string") return true
    const parsed = this.parseUri(uri)
    const entity = parsed ? this.#entities.get(parsed.type) : undefined
    return !entity || this.#canSee(entity, caller)
  }

  #mayUse(action: ActionRecord, caller: Caller): boolean {
    if (caller.public) return action.config.public === true
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
      // A date or a date-time (z.iso.date(), z.iso.datetime()): the view writes it in the reader's locale, never the raw ISO text.
      ...(f.schema.format === "date" || f.schema.format === "date-time" ? { format: f.schema.format } : {}),
      ...(f.ref ? { ref: f.ref } : {}),
      ...(f.sort ? { sort: true } : {}),
    }
  }

  #actionInfo(a: ActionRecord, caller: Caller) {
    // The form's labels in the caller's language (plainSchema keeps only bare-string labels).
    const raw = jsonSchemaOf(a.input, "input") as { properties?: Record<string, Record<string, unknown>> }
    const input = plainSchema(raw) as { properties?: Record<string, Record<string, unknown>> }
    for (const [k, p] of Object.entries(raw.properties ?? {})) {
      const shown = input.properties?.[k]
      if (!shown) continue
      if (isLabel(p.label)) shown.title = this.#t(caller, p.label)
      if (typeof p.currency === "string") shown.currency = p.currency
      if (p.labels && typeof p.labels === "object") shown.labels = Object.fromEntries(Object.entries(p.labels as Record<string, Label>).filter(([, l]) => isLabel(l)).map(([v, l]) => [v, this.#t(caller, l)]))
      // An input that holds another record's id: the form offers a picker over that entity's list (its tool, the field that names a record), never a box for a raw id.
      const target = typeof p.ref === "string" ? this.#entities.get(p.ref) : undefined
      if (target && this.#canSee(target, caller) && (caller.host !== "plain" || target.tools.list.plain)) {
        const title = this.#visibleFields(target, caller).find((f) => f.role === "title")
        shown.ref = { entity: target.name, tool: target.tools.list.name, title: title?.name ?? "id", search: this.#visibleFields(target, caller).some((f) => f.search) }
      }
      // A record of any app (spec §3.2): the host's picker gives the URI; the generated view takes it as text.
      const kind = kindRef(p)
      if (kind) shown.ref = { kind }
    }
    return { tool: a.tool, title: this.#t(caller, a.config.title), confirm: a.confirm, input }
  }

  /**
   * An input that failed its schema, said field by field in the caller's language (Zod's own locales):
   * `error.fields` maps each input key to what is wrong with it, the message names the fields by their labels.
   */
  #invalid(schema: z.ZodObject, error: z.ZodError, caller: Caller): CallToolResult {
    const raw = jsonSchemaOf(schema, "input") as { properties?: Record<string, Record<string, unknown>> }
    const fields: Record<string, string> = {}
    for (const issue of error.issues) {
      const key = issue.path.map(String).join(".") || "_"
      fields[key] ??= issue.message
    }
    const label = (key: string) => {
      const l = raw.properties?.[key.split(".")[0]!]?.label
      return isLabel(l) ? this.#t(caller, l) : key
    }
    const message = Object.entries(fields).map(([k, m]) => (k === "_" ? m : `${label(k)}: ${m}`)).join("; ")
    return failure("invalid_input", message, { fields })
  }

  /** An input's label in the caller's language (its key when it has none). */
  #fieldLabel(schema: z.ZodObject, key: string, caller: Caller): string {
    const l = (jsonSchemaOf(schema, "input") as { properties?: Record<string, Record<string, unknown>> }).properties?.[key]?.label
    return isLabel(l) ? this.#t(caller, l) : key
  }

  /** Zod's messages in the caller's language, when Zod has it (else English). */
  #zodLocale(caller: Caller): { error?: z.core.$ZodErrorMap } {
    const lang = (caller.locale ?? this.locale).split("-")[0]!.toLowerCase()
    const make = (z.locales as unknown as Record<string, (() => { localeError: z.core.$ZodErrorMap }) | undefined>)[lang]
    return typeof make === "function" ? { error: make().localeError } : {}
  }

  /**
   * An action's input as a person reads it before confirming (label → value): referenced records by their titles,
   * dates, numbers and money in the caller's language. What can't be named stays as sent.
   */
  async #shownInput(a: ActionRecord, received: Record<string, unknown>, caller: Caller, ctx: Context): Promise<{ label: string; value: string }[]> {
    const raw = jsonSchemaOf(a.input, "input") as { properties?: Record<string, Record<string, unknown>> }
    const locale = caller.locale ?? this.locale
    const out: { label: string; value: string }[] = []
    for (const [k, v] of Object.entries(received)) {
      // The model's title hint is never shown as the app's: the record is named from its id.
      if (v === undefined || v === null || v === "" || (a.entity && k === RECORD_TITLE_PARAM)) continue
      const p = raw.properties?.[k] ?? {}
      let label = isLabel(p.label) ? this.#t(caller, p.label) : k
      let value = typeof v === "string" ? v : JSON.stringify(v)
      const target = k === "id" && a.entity ? a.entity : typeof p.ref === "string" ? this.#entities.get(p.ref) : undefined
      if (k === "id" && a.entity) label = this.#t(caller, a.entity.config.label)
      try {
        if (target && typeof v === "string" && this.#canSee(target, caller)) {
          const row = await target.config.get(v, ctx)
          if (row) value = this.#recordCard(target, this.#strip(target, row as Record<string, unknown>, caller), caller).title
        } else if (typeof v === "number") value = typeof p.currency === "string" ? new Intl.NumberFormat(locale, { style: "currency", currency: p.currency }).format(v) : new Intl.NumberFormat(locale).format(v)
        else if (typeof v === "string" && p.format === "date" && /^\d{4}-\d{2}-\d{2}$/.test(v)) value = new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(new Date(`${v}T12:00:00`))
        else if (typeof v === "boolean") value = v ? "✓" : "—"
        else if (typeof v === "string" && p.labels && isLabel((p.labels as Record<string, unknown>)[v])) value = this.#t(caller, (p.labels as Record<string, Label>)[v])
      } catch {}
      out.push({ label, value })
    }
    return out
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

  /** A resolved artifact's data as a model reads it (a record's untrusted fields; every text of an artifact declared `untrusted`). */
  #markResolved(r: { artifact: { type: string }; state: string; data?: unknown }, base: string, pointers: string[]): unknown {
    if (r.state !== "ok" || !r.data || typeof r.data !== "object") return r.data
    const entity = this.#entities.get(r.artifact.type)
    if (entity) return this.#markRow(entity, r.data as Record<string, unknown>, `${base}/data`, pointers)
    return this.#artifacts.get(r.artifact.type)?.config.untrusted ? markAll(r.data, `${base}/data`, pointers, TEMPLATE_KEYS) : r.data
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
    // A key filter is exact on the normalised value (spec §3.1 rule 5): the handler gets it normalised (an email lower-cased).
    for (const [k, key] of entity.keys) {
      const f = filters[k]
      if (f === undefined) continue
      const norm = (v: unknown) => {
        if (typeof v !== "string") throw new AppError("invalid_input", `"${k}" is an exact ${key.property}: give a string`)
        const n = normaliseKey(v, key.how)
        if (n === null) throw new AppError("invalid_input", `"${k}": ${JSON.stringify(v)} is not a ${key.property}`)
        return n
      }
      if (f !== null && typeof f === "object" && "in" in f && Array.isArray(f.in)) filters[k] = { in: f.in.map(norm) }
      else if (f !== null && typeof f === "object") throw new AppError("invalid_input", `"${k}" is an exact ${key.property}: give a value or { in: [...] }, not a range`)
      else filters[k] = norm(f)
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
    this.#exact(entity, query, (result.rows ?? []) as Record<string, unknown>[])
    const rows = (result.rows ?? []).slice(0, query.limit).map((r) => this.#strip(entity, r as Record<string, unknown>, caller))
    return { rows, ...(result.next ? { next: result.next } : {}), ...(typeof result.total === "number" ? { total: result.total } : {}) }
  }

  /**
   * A handler that answered an exact key filter with a row that doesn't hold the value (spec §3.1 rule 5) fails
   * the call, clearly: a host matches records by these filters, and a wrong row would be a wrong match.
   */
  #exact(entity: EntityRecord, query: Query, rows: Record<string, unknown>[]): void {
    for (const [k, key] of entity.keys) {
      const f = query.filters[k]
      if (f === undefined) continue
      const wanted = typeof f === "string" ? [f] : f && typeof f === "object" && "in" in f ? f.in.map(String) : []
      for (const row of rows) {
        const values = Array.isArray(row[k]) ? (row[k] as unknown[]) : [row[k]]
        if (values.some((v) => typeof v === "string" && wanted.includes(normaliseKey(v, key.how) ?? "\u0000"))) continue
        const why = `${entity.tools.list.name}: the app's list returned ${entity.name} ${String(row.id)}, whose ${k} doesn't hold the exact ${key.property} asked for (${wanted.join(", ")}). A key filter is exact on the normalised value (spec §3.1).`
        console.error(`[${PROTOCOL_ID}] ${why}`)
        throw new AppError("internal", why)
      }
    }
  }

  /**
   * Titles of the records a list's ref fields point to (field → id → title), as this caller may see them.
   * `pointers`: the titles that are outsiders' text are noted there (under `/refs`), like any untrusted value.
   */
  async #refs(entity: EntityRecord, rows: Record<string, unknown>[], caller: Caller, ctx: Context, pointers?: string[]): Promise<Record<string, Record<string, string>>> {
    const out: Record<string, Record<string, string>> = {}
    await Promise.all(
      this.#visibleFields(entity, caller).map(async (f) => {
        // Same-app references only: a record of another app is the host's to name, for each viewer (spec §3.2).
        const local = localRef(f)
        const target = local ? this.#entities.get(local) : undefined
        if (!target || !this.#canSee(target, caller)) return
        const ids = [...new Set(rows.map((r) => r[f.name]).filter((v): v is string => typeof v === "string"))].slice(0, 50)
        const titles: Record<string, string> = {}
        await Promise.all(
          ids.map(async (id) => {
            const row = await target.config.get(id, ctx)
            if (row) titles[id] = this.#recordCard(target, this.#strip(target, row as Record<string, unknown>, caller), caller).title
          }),
        )
        out[f.name] = titles
      }),
    )
    Object.assign(out, await this.#personRefs(entity, rows, caller, ctx))
    // In declaration order, whatever finished first.
    const ordered: Record<string, Record<string, string>> = {}
    for (const f of entity.fields) {
      if (!out[f.name]) continue
      ordered[f.name] = out[f.name]!
      if (pointers && localRef(f) && this.#untrustedTitle(this.#entities.get(localRef(f)!)!)) for (const id of Object.keys(ordered[f.name]!)) pointers.push(`/refs/${pointerKey(f.name)}/${pointerKey(id)}`)
    }
    return ordered
  }

  /** Whether this app names people: it declares `people`, or its dev sign-in knows its test people. */
  #namesPeople(): boolean {
    return Boolean(this.options.people || this.#dev)
  }

  /**
   * The names of the people a list's `person` fields hold (field → id → name), when the app names people:
   * the caller's own name from the token, the dev sign-in's test people, then the app's `people`. An id none
   * of them knows is left out (a host shows an unknown person, never the id). Without a way to name people
   * nothing is sent: the field's values are the names themselves.
   */
  async #personRefs(entity: EntityRecord, rows: Record<string, unknown>[], caller: Caller, ctx: Context): Promise<Record<string, Record<string, string>>> {
    const fields = this.#visibleFields(entity, caller).filter((f) => f.role === "person" && !f.ref)
    if (!fields.length || !this.#namesPeople()) return {}
    const ids = [...new Set(rows.flatMap((r) => fields.map((f) => r[f.name])).filter((v): v is string => typeof v === "string" && v !== ""))].slice(0, 200)
    const names: Record<string, string> = {}
    if (caller.person?.name) names[caller.person.id] = caller.person.name
    for (const p of this.#dev?.people ?? []) if (p.name) names[p.id] ??= p.name
    const unknown = ids.filter((id) => !names[id])
    if (unknown.length && this.options.people) {
      try {
        const found = await this.options.people(unknown, ctx)
        for (const id of unknown) if (typeof found?.[id] === "string" && found[id]) names[id] = found[id]!
      } catch (error) {
        console.error(`[${PROTOCOL_ID}] people`, error)
      }
    }
    const out: Record<string, Record<string, string>> = {}
    for (const f of fields) {
      const own: Record<string, string> = {}
      for (const r of rows) {
        const id = r[f.name]
        if (typeof id === "string" && names[id]) own[id] = names[id]!
      }
      out[f.name] = own
    }
    return out
  }

  #untrustedTitle(entity: EntityRecord): boolean {
    return entity.fields.some((f) => f.role === "title" && f.untrusted)
  }

  /** A record's title as a model reads it beside its URI (spec §6 rule 10): what it names the record by (an outsider's title wrapped). */
  #modelTitle(entity: EntityRecord, row: Record<string, unknown>, caller: Caller): string {
    const title = this.#recordCard(entity, row, caller).title
    return this.#untrustedTitle(entity) ? untrustedText(title) : title
  }

  /** A row as a model reads it, with the records it references named: `{ id, title }` in place of a bare id (an outsider's title wrapped). */
  #named(entity: EntityRecord, row: Record<string, unknown>, refs: Record<string, Record<string, string>>): Record<string, unknown> {
    const out = { ...row }
    for (const f of entity.fields) {
      const id = out[f.name]
      // A record of another app: its URI and kind, never a title (the app has none, and keeps none: spec §3.2).
      const kind = kindRef(f)
      if (kind) {
        if (typeof id === "string") out[f.name] = { uri: id, kind }
        continue
      }
      const title = typeof id === "string" ? refs[f.name]?.[id] : undefined
      if (title === undefined) continue
      // A person by name; a referenced record by its title (an outsider's title wrapped).
      if (localRef(f)) out[f.name] = { id, title: this.#untrustedTitle(this.#entities.get(localRef(f)!)!) ? untrustedText(title) : title }
      else if (f.role === "person") out[f.name] = { id, name: title }
    }
    return out
  }

  #listFiltersShape(entity: EntityRecord, caller: Caller): Record<string, z.ZodType> {
    const shape: Record<string, z.ZodType> = {}
    for (const f of this.#visibleFields(entity, caller)) {
      if (!f.filter) continue
      // Descriptions are in the app's locale, the same for every caller (spec §6 rule 2); a field with `as` names its property.
      const label = say(f.label ?? f.name, this.locale, this.locale)
      const key = entity.keys.get(f.name)
      if (key) {
        // A key is matched exactly (spec §3.1 rule 5): a value or a set of values, never a range.
        const value = KEY_FORMATS[key.property] ? z.string().meta({ format: KEY_FORMATS[key.property] }) : z.string()
        shape[f.name] = z.union([value, z.object({ in: z.array(value) })]).optional().describe(`${label}: exact ${key.property}; a value or { in: [...] }`)
        continue
      }
      const value: z.ZodType = f.enum ? z.enum(f.enum as [string, ...string[]]) : f.type === "number" || f.type === "integer" ? z.number() : f.type === "boolean" ? z.boolean() : z.string()
      shape[f.name] = z
        .union([value, z.object({ in: z.array(value) }), z.object({ gte: value.optional(), lte: value.optional() })])
        .optional()
        .describe(`${label}${f.as ? ` (${f.as})` : ""}: a value, { in: [...] }, or a range { gte, lte }`)
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

  /** The record template's key fields (spec §5.4 rule 4 `record`): as declared, else the first four a list would show (not the title, subtitle or status). */
  #recordFields(entity: EntityRecord): FieldInfo[] {
    const declared = entity.config.record?.fields
    if (declared) return declared.map((n) => entity.fields.find((f) => f.name === n)!).filter(Boolean)
    return entity.fields.filter((f) => f.name !== "id" && f.role !== "title" && f.role !== "subtitle" && f.role !== "status" && (f.role || f.filter) && f.type !== "object" && f.type !== "array").slice(0, 4)
  }

  /** A record's surface data: every value a text in the caller's language (referenced records by their titles, dates, numbers, money, labels). */
  #recordData(entity: EntityRecord, row: Record<string, unknown>, refs: Record<string, Record<string, string>>, uri: string, caller: Caller) {
    const card = this.#recordCard(entity, row, caller)
    const status = entity.fields.find((f) => f.role === "status" && (!f.permission || caller.permissions.has(f.permission)))
    const tone = status?.tones?.[String(row[status.name])]
    const locale = caller.locale ?? this.locale
    const shown = (f: FieldInfo, v: unknown): string => {
      if (v === undefined || v === null || v === "") return ""
      if (typeof v === "string" && refs[f.name]?.[v]) return refs[f.name]![v]!
      try {
        if (typeof v === "number") return f.currency ? new Intl.NumberFormat(locale, { style: "currency", currency: f.currency }).format(v) : new Intl.NumberFormat(locale).format(v)
        if (typeof v === "boolean") return v ? "✓" : "—"
        if (typeof v === "string" && f.labels?.[v]) return this.#t(caller, f.labels[v])
        if (typeof v === "string" && f.schema.format === "date" && /^\d{4}-\d{2}-\d{2}$/.test(v)) return new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(new Date(`${v}T12:00:00`))
        if (typeof v === "string" && f.schema.format === "date-time" && Number.isFinite(Date.parse(v))) return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(v))
      } catch {}
      return typeof v === "string" ? v : Array.isArray(v) ? v.map(String).join(", ") : JSON.stringify(v)
    }
    const fields = this.#recordFields(entity)
      .filter((f) => !f.permission || caller.permissions.has(f.permission))
      .map((f) => ({ name: f.name, label: this.#t(caller, f.label ?? f.name), value: shown(f, row[f.name]) }))
      .filter((f) => f.value !== "")
    return { ...card, ...(tone ? { tone } : {}), uri, fields }
  }

  /** The record template's actions this caller may use, each an event carrying the record's id. */
  #recordTemplateActions(entity: EntityRecord, caller: Caller, id: string) {
    return (entity.config.record?.actions ?? [])
      .map((n) => [...this.#actions.values()].find((a) => a.name === n && a.entity === entity))
      .filter((a): a is ActionRecord => Boolean(a && this.#mayUse(a, caller)))
      .map((a) => ({ tool: a.tool, title: this.#t(caller, a.config.title), context: { id } }))
  }

  /** One artifact instance as this caller may see it now. */
  async #resolve(instance: ArtifactInstance, caller: Caller, ctx: Context) {
    const uri = this.artifactUri(instance)
    const artifact = { app: this.name, type: instance.type, params: instance.params }
    const entity = this.#entities.get(instance.type)
    if (entity) {
      if (!this.#canSee(entity, caller)) return { artifact, uri, state: "no-access" as const }
      const row = await entity.config.get(String(instance.params.id ?? ""), ctx)
      if (!row) return { artifact, uri, state: "gone" as const }
      const data = this.#strip(entity, row as Record<string, unknown>, caller)
      const card = this.#recordCard(entity, data, caller)
      // The titles of the records it references (field → id → title), as this caller may see them: a host shows those, never the ids.
      const refs = await this.#refs(entity, [data], caller, ctx)
      return {
        artifact,
        uri,
        state: "ok" as const,
        template: "record" as const,
        ...card,
        data,
        refs,
        view: { kind: "record", tool: entity.tools.get.name, fields: this.#visibleFields(entity, caller).map((f) => this.#column(f, caller)), actions: this.#recordActions(entity, caller) },
        // The record as an A2UI 1.0 surface (spec §5.4 rule 4 `record`): its template's key fields and actions.
        a2ui: recordSurface(this.#recordData(entity, data, refs, uri, caller), { surfaceId: uri, title: card.title, actions: this.#recordTemplateActions(entity, caller, String(data.id ?? instance.params.id)) }),
      }
    }
    const f = this.#artifacts.get(instance.type)
    if (!f) return { artifact, uri, state: "gone" as const }
    if (!this.#canShow(f, caller)) return { artifact, uri, state: "no-access" as const }
    const parsed = f.config.params.safeParse(instance.params)
    if (!parsed.success) return { artifact, uri, state: "gone" as const }
    let data = (await f.config.data(parsed.data as never, ctx)) as Record<string, unknown> | null
    if (!data) return { artifact, uri, state: "gone" as const }
    // What a template links to is shown only to who reaches it: a card of a record out of reach is no access, such items leave a list.
    if (f.config.template === "card" && !this.#uriVisible(data.uri, caller)) return { artifact, uri, state: "no-access" as const }
    if (f.config.template === "list" && Array.isArray(data.items)) data = { ...data, items: (data.items as { uri?: unknown }[]).filter((i) => this.#uriVisible(i?.uri, caller)) }
    const actions = (f.config.actions ?? []).map((h) => this.#actions.get(h.tool)).filter((a): a is ActionRecord => Boolean(a && this.#mayUse(a, caller))).map((a) => this.#actionInfo(a, caller))
    const title = this.#t(caller, f.config.title)
    // The artifact as an A2UI 1.0 surface (spec §5.4): the tree for its template or component, its data as the data model.
    const surface = { surfaceId: uri, title, actions: actions.map((a) => ({ tool: a.tool, title: a.title })) }
    const name = (f.config as { component?: string }).component
    let a2ui
    if (name) {
      const props = this.#components.get(name)!.props
      const checked = props.safeParse(data)
      // A component draws only props valid against its schema: anything else is the artifact's error, never a half-drawn component.
      if (!checked.success) throw new AppError("internal", `artifact "${f.type}": its data are not valid props of component "${name}"`)
      data = checked.data as Record<string, unknown>
      a2ui = componentSurface(this.name, name, data, Object.keys(props.shape), surface)
    } else if (f.config.template) a2ui = templateSurface(f.config.template, data as never, surface)
    return { artifact, uri, state: "ok" as const, template: f.config.template ?? (name ? "component" : "view"), ...(name ? { component: name } : {}), title, data, ...(actions.length ? { actions } : {}), ...(a2ui ? { a2ui } : {}) }
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
    const { id, [RECORD_TITLE_PARAM]: hint, ...rest } = args
    const parsed = a.input.safeParse(a.entity ? rest : args, this.#zodLocale(caller))
    if (!parsed.success) return this.#invalid(a.input, parsed.error, caller)
    let record: Record<string, unknown> | undefined
    if (a.entity) {
      if (typeof id !== "string" || !id) return failure("invalid_input", "id: the record's id is required")
      if (hint !== undefined && typeof hint !== "string") return failure("invalid_input", `${RECORD_TITLE_PARAM}: a string`, { fields: { [RECORD_TITLE_PARAM]: "a string" } })
      const row = await a.entity.config.get(id, ctx)
      if (!row) return failure("not_found", `${this.#t(caller, a.entity.config.label)} ${id} doesn't exist.`)
      record = row as Record<string, unknown>
      // The hint is what a client's own approval prompt may have shown the person: one that names another record stops
      // the call (the person approved something else). It never changes what runs, and is never shown as the app's.
      const titleField = a.entity.fields.find((f) => f.role === "title" && (!f.permission || caller.permissions.has(f.permission)))
      const real = titleField ? record[titleField.name] : undefined
      if (typeof hint === "string" && hint.trim() && real !== undefined && real !== null && comparableTitle(hint) !== comparableTitle(String(real))) {
        const label = this.#t(caller, a.entity.config.label).toLowerCase()
        const why = `${RECORD_TITLE_PARAM} doesn't match the ${label} with id ${id}: read it again (${a.entity.tools.get.name}) and name the one the person means`
        return failure("invalid_input", why, { fields: { [RECORD_TITLE_PARAM]: why } })
      }
    }
    const received = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : args) as Record<string, unknown>
    // A later action: when it runs is checked before anyone is asked to confirm it, and the deadline the proof must carry follows from it.
    // (A call id already answered gives its answer back first, whatever the time is now.)
    let until: number | undefined
    let laterRefused: CallToolResult | null = null
    if (a.later) {
      const at = received[a.later.at]
      const atMs = typeof at === "string" ? Date.parse(at) : NaN
      const now = Date.now()
      const why = !Number.isFinite(atMs) ? "a date and time" : atMs < now - LATER_PAST_MS ? "a time that has not passed" : atMs > now + LATER_AHEAD_MS ? "at most a year ahead" : null
      if (why) laterRefused = failure("invalid_input", `${this.#fieldLabel(a.input, a.later.at, caller)}: ${why}`, { fields: { [a.later.at]: why } })
      else until = laterDeadline(at as string, a.later.window)
    }
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
      if (laterRefused) return laterRefused
      let proven: { proof: string; iat: number } | null = null
      const confirmRequired = (why: string) => {
        const card = a.entity && record ? this.#recordCard(a.entity, this.#strip(a.entity, record, caller), caller) : null
        return failure("confirmation_required", `${this.#t(caller, a.config.title)} needs the person's confirmation (${why}).`, {
          confirm: { tool: a.tool, title: this.#t(caller, a.config.title), ...(a.entity && record ? { record: { uri: this.uri(a.entity.name, String(record.id)), ...card } } : {}), input: received, ...(a.later && until !== undefined ? { later: { at: received[a.later.at], until } } : {}) },
        })
      }
      if (a.write && a.confirm === "always" && caller.host === "workspace") {
        const proof = hostMeta(meta).confirmation
        const checked = typeof proof === "string" ? await this.#verifier.checkConfirmation(proof, { issuer: caller.issuer, subject: caller.subject, installation: caller.installationId, tool: a.tool, args: received, call: ctx.call, ...(until !== undefined ? { until } : {}) }, request.trust) : { ok: false as const, why: "no proof" }
        if (checked.ok) proven = { proof: proof as string, iat: checked.iat }
        if (!checked.ok) return confirmRequired(checked.why)
      }
      // A plain client that can elicit (MCP 2026-07-28 input requests) is asked to confirm an `always` write; others rely on the tool's destructiveHint.
      if (a.write && a.confirm === "always" && caller.host === "plain" && mctx && elicits(mctx)) {
        const answer = inputResponse(mctx.mcpReq.inputResponses, "confirm")
        if (answer.kind !== "elicit") {
          const lines = (await this.#shownInput(a, received, caller, ctx)).map((l) => `${l.label}: ${l.value}`).join("; ")
          return inputRequired({ inputRequests: { confirm: inputRequired.elicit({ message: `${this.#t(caller, a.config.title)}${lines ? ` (${lines})` : ""}?`, requestedSchema: z.object({ confirm: z.boolean() }) }) } }) as unknown as CallToolResult
        }
        if (answer.action !== "accept" || answer.content?.confirm !== true) return failure("confirmation_required", "Not confirmed.")
      }
      // Confirmed now, run later: the call is kept as received, with its proof, and runs when it is due (clegra_later).
      if (a.later && until !== undefined) {
        const at = received[a.later.at] as string
        const run: LaterRun = {
          id: randomUUID(),
          tenant: caller.installation,
          tool: a.tool,
          args: received,
          argsHash: argsHash(received),
          at,
          until,
          author: caller.person ? { id: caller.person.id, name: caller.person.name } : null,
          permissions: [a.config.permission, a.entity?.config.permission].filter((x): x is string => typeof x === "string" && caller.permissions.has(x)),
          proof: proven?.proof ?? null,
          issuer: caller.issuer,
          subject: caller.subject,
          installation: caller.installationId,
          call: ctx.call,
          confirmedAt: proven?.iat ?? Math.floor(Date.now() / 1000),
        }
        await this.#store.later!.add(run)
        const message = `Scheduled for ${at}.`
        const result: CallToolResult = { content: text(message), structuredContent: { ok: true, message, data: { later: { id: run.id, at, until } } } }
        if (key) {
          await this.#store.finish(key, { args: hash, result }, 24 * 3600_000)
          kept = true
        }
        return result
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
      // What changed (spec §5.4 rule 8): the record a write acted on, the record it returned, and what the handler said.
      const changed = new Set<string>()
      if (a.write && a.entity && record) changed.add(this.uri(a.entity.name, String(record.id)))
      if (a.write && recordUri && this.parseUri(recordUri)) changed.add(recordUri)
      for (const c of this.#changes.get(notes) ?? []) changed.add(c)
      const result: CallToolResult = {
        content: text(message),
        structuredContent: { ok: true, message, ...(recordUri ? { record: recordUri } : {}), ...(out?.data ? { data: out.data } : {}) },
        ...this.#notificationsMeta(this.#sent(notes, caller, ctx), [...changed]),
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

  // ------------------------------------------------------------ later runs

  /**
   * One pass over a tenant's due later runs: each is claimed (once: a claimed run is never given again), checked
   * against what the person confirmed, and run as its author. `meta`: the request's (`_meta.clegra.settings`).
   */
  async #runDue(tenant: string, meta: Record<string, unknown> | undefined, trust: RequestTrust, locale: string | undefined): Promise<LaterReport> {
    const report: LaterReport = { runs: [], notifications: [] }
    const store = this.#store.later
    if (!store) return report
    for (const due of await store.due(tenant, new Date(), LATER_BATCH)) {
      const run = await store.claim(due.id, tenant)
      if (!run) continue // another pass took it
      let done: { outcome: LaterOutcome; notes: SentNotification[] }
      try {
        done = await this.#runOne(run, meta, trust)
      } catch (error) {
        console.error(`[${PROTOCOL_ID}] ${LATER_TOOL} ${run.tool} ${run.id}`, error)
        done = { outcome: { status: "failed", message: "The action failed." }, notes: [] }
      }
      await store.finish(run.id, done.outcome)
      report.runs.push({ id: run.id, tool: run.tool, at: run.at, ...done.outcome })
      report.notifications.push(...done.notes)
      if ((done.outcome.status === "expired" || done.outcome.status === "refused") && run.author) report.notifications.push(this.#didNotRun(run, done.outcome, locale))
    }
    return report
  }

  /** One claimed later run: refused unless it is exactly what was confirmed (arguments, time, proof as of its confirmation), expired after its deadline, else run. */
  async #runOne(run: LaterRun, meta: Record<string, unknown> | undefined, trust: RequestTrust): Promise<{ outcome: LaterOutcome; notes: SentNotification[] }> {
    const refused = (message: string) => ({ outcome: { status: "refused" as const, message }, notes: [] })
    const failed = (message: string, notes: SentNotification[] = []) => ({ outcome: { status: "failed" as const, message }, notes })
    const a = this.#actions.get(run.tool)
    if (!a?.later) return refused(`${run.tool} is not an action that runs later`)
    if (argsHash(run.args) !== run.argsHash) return refused("its arguments are not the ones confirmed")
    const at = run.args[a.later.at]
    if (typeof at !== "string" || at !== run.at) return refused("its time is not the one confirmed")
    if (!(Date.parse(at) <= Date.now())) return refused("it is not due yet")
    if (run.proof) {
      // The host's proof, verified as of when the person confirmed it: its signature, and that it covers exactly these arguments, this call and this deadline.
      const checked = await this.#verifier.checkConfirmation(run.proof, { issuer: run.issuer, subject: run.subject, installation: run.installation, tool: run.tool, args: run.args, call: run.call, until: run.until }, trust, new Date(run.confirmedAt * 1000))
      if (!checked.ok) return refused(checked.why)
      if (checked.iat !== run.confirmedAt) return refused("the proof is not the one kept")
    }
    if (Math.floor(Date.now() / 1000) > run.until) return { outcome: { status: "expired", message: `its deadline passed (${new Date(run.until * 1000).toISOString()})` }, notes: [] }
    const caller: Caller = { installation: run.tenant, installationId: run.installation, person: run.author, permissions: new Set(run.permissions), host: run.proof ? "workspace" : "plain", issuer: run.issuer, subject: run.subject }
    if (!this.#mayUse(a, caller)) return refused("its author may not use it")
    const notes: Notification[] = []
    const ctx = this.#context(caller, meta, notes, { later: { id: run.id, at: run.at, until: run.until, confirmedAt: run.confirmedAt }, call: run.call })
    const { id, [RECORD_TITLE_PARAM]: _hint, ...rest } = run.args
    const parsed = a.input.safeParse(a.entity ? rest : run.args)
    if (!parsed.success) return failed(`its arguments no longer fit the action: ${parsed.error.issues.map((i) => `${i.path.join(".") || "_"}: ${i.message}`).join("; ")}`)
    let record: Record<string, unknown> | undefined
    if (a.entity) {
      const row = await a.entity.config.get(String(id ?? ""), ctx)
      if (!row) return failed(`${this.#t(caller, a.entity.config.label)} ${String(id)} doesn't exist.`)
      record = row as Record<string, unknown>
    }
    let out: ActionResult | void
    try {
      out = await a.handler(parsed.data as never, ctx, record as never)
    } catch (error) {
      if (error instanceof AppError) return failed(error.message, this.#sent(notes, caller, ctx))
      console.error(`[${PROTOCOL_ID}] ${LATER_TOOL} ${a.tool}`, error)
      return failed("The action failed.")
    }
    return { outcome: { status: "done", message: out?.message ?? "Done." }, notes: this.#sent(notes, caller, ctx) }
  }

  /** What the author of a later run that did not run is told. */
  #didNotRun(run: LaterRun, outcome: LaterOutcome, locale: string | undefined): SentNotification {
    const a = this.#actions.get(run.tool)
    const lang = (locale ?? this.locale).split("-")[0]!.toLowerCase()
    const title = a ? say(a.config.title, locale ?? this.locale, this.locale) : run.tool
    return { type: LATER_TOOL, title: (DID_NOT_RUN[lang] ?? DID_NOT_RUN.en!)(title), body: outcome.message, to: [run.author!.id] }
  }

  /**
   * Runs the tenant's due later runs now, as `clegra_later` does when the workspace host calls it: for an app whose
   * callers are its own (no workspace host runs its schedules), from the app's own cron. `settings`: what handlers
   * see as `ctx.settings`. The notifications in the report are the app's to deliver.
   */
  async runLater(tenant: string, options: { settings?: Record<string, unknown>; locale?: string } = {}): Promise<LaterReport> {
    if (!this.#store.later) throw new Error("runLater: the store has no later part")
    return this.#runDue(tenant, options.settings ? { [META_KEY]: { settings: options.settings } } : undefined, { dev: Boolean(this.#dev), requestResource: null }, options.locale)
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

  #artifactViewUri(type: string): string {
    return `ui://${this.name}/artifacts/${type}`
  }

  #componentViewUri(name: string): string {
    return `ui://${this.name}/components/${name}`
  }

  /** The app's own components as its A2UI catalog and the manifest describe them (spec §5.4 rule 6). */
  #componentEntries(): ComponentEntry[] {
    const t = (l: Label | undefined) => say(l, this.locale, this.locale)
    return [...this.#components].map(([name, c]) => ({
      name,
      title: t(c.title),
      ...(c.description ? { description: t(c.description) } : {}),
      view: this.#componentViewUri(name),
      props: plainSchema(jsonSchemaOf(c.props, "output")) as Record<string, unknown>,
      actions: (c.actions ?? []).map((h) => h.tool),
    }))
  }

  /** A tool's view; `appOnly`: the tool of an app-only item, which no model is given (MCP Apps `visibility: ["app"]`, ChatGPT `openai/visibility: private`). */
  #ui(resourceUri: string, appOnly = false) {
    return { ui: { resourceUri, visibility: appOnly ? ["app"] : ["model", "app"] }, "ui/resourceUri": resourceUri, "openai/outputTemplate": resourceUri, "openai/widgetAccessible": true, ...(appOnly ? { "openai/visibility": "private" } : {}) }
  }

  /** A tool without a view of its own that views call (a record's actions): callable from a view in MCP Apps hosts (`ui.visibility` with "app") and in ChatGPT (`openai/widgetAccessible`). Without it a host refuses the view's call. */
  #callable(appOnly = false) {
    return appOnly ? APP_ONLY_META : { ui: { visibility: ["model", "app"] }, "openai/widgetAccessible": true }
  }

  /** Whether this caller may open a page (its tool's gates: exposure, permission, its list's entity). */
  #canOpen(p: PageRecord, caller: Caller): boolean {
    const c = p.config
    if (caller.public || c.kind === "record" || (caller.host === "plain" && !p.tool.plain)) return false
    if (c.permission && !caller.permissions.has(c.permission)) return false
    return c.kind !== "list" || this.#canSee(this.#entities.get(c.entity.name)!, caller)
  }

  /**
   * The navigation as this caller may use it (`view.nav` of a page): sections in the reader's language, each page
   * with its title, the tool that opens it and its badge's tool. Without declared `nav`: every non-record page, one section.
   */
  #navFor(caller: Caller) {
    const sections: NavSection[] = this.#nav ?? [{ pages: [...this.#pages.values()].filter((p) => p.config.kind !== "record").map((p) => p.name) }]
    return sections
      .map((s) => ({
        ...(s.section !== undefined ? { section: this.#t(caller, s.section) } : {}),
        pages: s.pages.flatMap((name) => {
          const p = this.#pages.get(name)
          if (!p || !this.#canOpen(p, caller) || p.config.kind === "record") return []
          const badge = p.config.badge ? this.#artifacts.get(p.config.badge) : undefined
          return [{ name, title: this.#t(caller, p.config.title), tool: p.tool.name, ...(badge && this.#canShow(badge, caller) ? { badge: badge.tool.name } : {}) }]
        }),
      }))
      .filter((s) => s.pages.length)
  }

  /** A page's actions as this caller may use them (like a record's), each with its inputs prefilled from the page's params of the same name. */
  #pageActions(c: PageConfig, caller: Caller, params: Record<string, unknown>) {
    if (c.kind === "record") return []
    return (c.actions ?? []).flatMap((h) => {
      const a = this.#actions.get(h.tool)
      if (!a || !this.#mayUse(a, caller)) return []
      const info = this.#actionInfo(a, caller)
      const props = info.input.properties ?? {}
      const prefill = Object.fromEntries(Object.entries(params).filter(([k, v]) => Object.hasOwn(props, k) && v !== undefined && v !== null && v !== ""))
      return [{ ...info, ...(Object.keys(prefill).length ? { prefill } : {}) }]
    })
  }

  /** What every page's `view` carries beside its kind and title: its actions and the app's navigation (the page itself named). */
  #pageExtras(p: PageRecord, caller: Caller, params: Record<string, unknown>) {
    const actions = this.#pageActions(p.config, caller, params)
    const nav = this.#navFor(caller)
    return { page: p.name, ...(actions.length ? { actions } : {}), ...(nav.length ? { nav } : {}) }
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

  /**
   * Every view the app declares (the SDK's generated view, page, entity and artifact views), by URI: what
   * `resources/read` returns and what `<path>/clegra/views/…` serves (spec §5.3).
   */
  #viewDocuments(): Map<string, ViewDocument> {
    const o = this.options
    const t = (l: Label | undefined) => say(l, this.locale, this.locale)
    const views = new Map<string, ViewDocument>()
    const view = (uri: string, title: string, html: () => string | Promise<string>, src?: ViewSource) => {
      const csp = src?.csp ?? {}
      const ui = { csp, ...(src && "prefersBorder" in src && src.prefersBorder !== undefined ? { prefersBorder: src.prefersBorder } : {}) }
      views.set(uri, { title, html, ui })
    }
    view(this.#viewUri(), `${t(o.title)} view`, () => viewHtml(t(o.title)))
    for (const p of this.#allPages()) {
      const c = p.config
      if (c.kind !== "custom" && c.view) view(this.#pageViewUri(p.name), t(c.title ?? p.name), () => (typeof c.view!.html === "function" ? c.view!.html() : c.view!.html), c.view)
      else if (c.kind === "dashboard") view(this.#pageViewUri(p.name), t(c.title), () => viewHtml(t(c.title), { tool: p.tool.name }))
      if (c.kind === "custom" && "view" in c) view(this.#pageViewUri(p.name), t(c.title), () => (typeof c.view.html === "function" ? c.view.html() : c.view.html), c.view)
    }
    for (const e of this.#entities.values()) if (e.config.view) view(this.#entityViewUri(e.name), t(e.config.label), () => (typeof e.config.view!.html === "function" ? e.config.view!.html() : e.config.view!.html), e.config.view)
    for (const f of this.#artifacts.values()) if (f.config.view) view(this.#artifactViewUri(f.type), t(f.config.title), () => (typeof f.config.view!.html === "function" ? f.config.view!.html() : f.config.view!.html), f.config.view)
    for (const [name, c] of this.#components) view(this.#componentViewUri(name), t(c.title), () => (typeof c.view.html === "function" ? c.view.html() : c.view.html), c.view)
    return views
  }

  /** A fresh McpServer for one request, for this caller (null: manifest and views only). `request`: what `fetch` knows of the HTTP request. */
  createMcpServer(caller: Caller | null, era: "legacy" | "modern" = "legacy", request: RequestInfo = { trust: { dev: Boolean(this.#dev), requestResource: null }, received: new Map() }): McpServer {
    void era
    const o = this.options
    // Tool names, titles and descriptions are in the app's own locale: stable for every caller (spec §6). Data labels follow the caller.
    const t = (l: Label | undefined) => say(l, this.locale, this.locale)
    const s = new McpServer(
      { name: o.name, version: o.version, title: t(o.title), ...(o.description ? { description: t(o.description) } : {}), ...(o.icons ? { icons: o.icons } : {}), ...(o.websiteUrl ? { websiteUrl: o.websiteUrl } : {}) },
      { ...(o.instructions ? { instructions: o.instructions } : {}) },
    )
    // Resources: the manifest, the SDK's view, page, entity and artifact views.
    s.registerResource("manifest", manifestUri(this.name), { mimeType: "application/json", description: "The app's manifest (what hosts read to mount the app)" }, async () => ({
      contents: [{ uri: manifestUri(this.name), mimeType: "application/json", text: JSON.stringify(this.manifest()) }],
    }))
    // The app's own A2UI catalog (spec §5.4 rule 3), when it has components.
    if (this.#components.size) {
      const catalog = appCatalogId(this.name)
      s.registerResource("a2ui-catalog", catalog, { mimeType: "application/json", description: "The app's own A2UI 1.0 components (its catalog)" }, async () => ({
        contents: [{ uri: catalog, mimeType: "application/json", text: JSON.stringify(appCatalog(this.name, t(o.title), this.#componentEntries())) }],
      }))
    }
    for (const [uri, v] of this.#viewDocuments()) {
      const ui = v.ui
      s.registerResource(v.title, uri, { mimeType: MCP_APP_MIME_TYPE, _meta: { ui } }, async () => ({ contents: [{ uri, mimeType: MCP_APP_MIME_TYPE, text: await v.html(), _meta: { ui } }] }))
    }

    if (!caller) {
      this.options.mcp?.(s, null)
      return s
    }
    const plainCaller = caller.host === "plain"
    const reg = s.registerTool.bind(s) as unknown as (name: string, config: Record<string, unknown>, cb: (args: Record<string, unknown>, ctx: ServerContext) => Promise<CallToolResult>) => void
    const guard = (name: string, fn: (args: Record<string, unknown>, ctx: ServerContext) => Promise<CallToolResult>) => async (args: Record<string, unknown>, ctx: ServerContext) => {
      const notes: L10n = new Map()
      // A schedule's run is the installation's, of that schedule's own tool: anything else naming a schedule is refused.
      const scheduleWhy = this.#scheduleProblem(name, caller, ctx.mcpReq._meta as Record<string, unknown> | undefined)
      if (scheduleWhy) return failure("permission_denied", `Not a run of this schedule: ${scheduleWhy}.`)
      try {
        return withL10n(await shownLabels.run(notes, () => fn(args ?? {}, ctx)), notes)
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
      // What the entity is, for every client: the kind's fixed sentence ends both descriptions; hosts read `_meta.clegra` (spec §6).
      // The kind's sentence is always last (spec §6 rule 8); the cross-app hint (spec §3.2) before it.
      const kindText = `${e.fields.some((f) => kindRef(f)) ? ` ${CROSS_APP_HINT}` : ""}${e.config.kind !== undefined ? ` ${kindSentence(e.config.kind)}` : ""}`
      const entityMeta = { [META_KEY]: { entity: e.name, ...(e.config.kind !== undefined ? { kind: e.config.kind } : {}) } }
      const appOnlyEntity = e.config.visibility === "app"
      reg(
        e.tools.list.name,
        {
          title: plural,
          description: `${t(e.config.description) || plural}. Lists ${plural.toLowerCase()} with filters, sort and paging (pass \`cursor\` from the previous result's \`next\`).${kindText}`,
          inputSchema: z.strictObject({ ...this.#listFiltersShape(e, caller), cursor: z.string().optional(), limit: z.number().int().min(1).max(100).optional() }),
          annotations: { title: plural, ...read },
          _meta: { ...this.#ui(this.#viewUri(), appOnlyEntity), ...entityMeta },
        },
        guard(e.tools.list.name, async (args, mctx) => {
          const ctx = ctxOf(mctx)
          const query = this.#queryOf(e, caller, args)
          const out = await this.#list(e, caller, ctx, query)
          const uris = out.rows.map((r) => this.uri(e.name, String(r.id)))
          const pointers: string[] = []
          const marked = out.rows.map((r, i) => this.#markRow(e, r, `/rows/${i}`, pointers))
          const refs = await this.#refs(e, out.rows, caller, ctx, pointers)
          return {
            content: text(JSON.stringify({ rows: marked.map((r, i) => ({ uri: uris[i], title: this.#modelTitle(e, out.rows[i]!, caller), ...this.#named(e, r, refs) })), ...(out.next ? { next: out.next } : {}), ...(out.total !== undefined ? { total: out.total } : {}) })),
            structuredContent: { entity: e.name, ...out, uris, refs, view: { kind: "list", title: this.#t(caller, e.config.plural ?? e.config.label), columns: columns(), tool: e.tools.list.name, args, getTool: e.tools.get.name, ...(query.sort ? { sort: query.sort } : {}) } },
            ...this.#marks(pointers),
          }
        }),
      )
      reg(
        e.tools.get.name,
        {
          title: label,
          description: `One ${label.toLowerCase()} by id, with the actions available on it.${kindText}`,
          inputSchema: z.object({ id: z.string().describe(`The ${label.toLowerCase()}'s id`) }),
          annotations: { title: label, ...read },
          _meta: { ...this.#ui(e.config.view ? this.#entityViewUri(e.name) : this.#viewUri(), appOnlyEntity), ...entityMeta },
        },
        guard(e.tools.get.name, async (args, mctx) => {
          const ctx = ctxOf(mctx)
          const row = await e.config.get(String(args.id), ctx)
          if (!row) return failure("not_found", `${label} ${String(args.id)} doesn't exist.`)
          const record = this.#strip(e, row as Record<string, unknown>, caller)
          const pointers: string[] = []
          const marked = this.#markRow(e, record, "/record", pointers)
          const uri = this.uri(e.name, String(record.id))
          const refs = await this.#refs(e, [record], caller, ctx, pointers)
          return {
            content: text(JSON.stringify({ uri, title: this.#modelTitle(e, record, caller), ...this.#named(e, marked, refs) })),
            structuredContent: { entity: e.name, uri, record, refs, view: { kind: "record", title: this.#t(caller, e.config.label), tool: e.tools.get.name, fields: this.#visibleFields(e, caller).map((f) => this.#column(f, caller)), actions: this.#recordActions(e, caller) } },
            ...this.#marks(pointers),
          }
        }),
      )
    }

    // search and fetch (ChatGPT's conventions), over searchable entities.
    // App-only entities are never a model's: search and fetch leave their records out.
    const searchable = [...this.#entities.values()].filter((e) => e.config.visibility !== "app" && this.#canSee(e, caller) && this.#visibleFields(e, caller).some((f) => f.search))
    // The kinds search can be limited to (spec §6): those of the searchable entities.
    const searchKinds = [...new Set(searchable.flatMap((e) => kindsOf(e.config.kind)))]
    if (searchable.length) {
      reg(
        "search",
        {
          title: t({ en: "Search", it: "Cerca" }),
          description: `Searches ${searchable.map((e) => t(e.config.plural ?? e.config.label)).join(", ")} by text. Returns ids (URIs) to pass to fetch.${searchKinds.length ? ` \`kind\` limits it to records of one kind; each result says its kind.` : ""}`,
          inputSchema: z.object({
            query: z.string().min(1).max(200),
            ...(searchKinds.length ? { kind: z.enum(searchKinds as [string, ...string[]]).optional().describe("Only records of this kind") } : {}),
            limit: z.number().int().min(1).max(50).optional(),
          }),
          annotations: { ...read },
          _meta: this.#ui(this.#viewUri()),
        },
        guard("search", async (args, mctx) => {
          const ctx = ctxOf(mctx)
          const limit = typeof args.limit === "number" ? args.limit : 10
          const only = typeof args.kind === "string" ? args.kind : undefined
          const results: Record<string, unknown>[] = []
          const forModel: Record<string, unknown>[] = []
          const pointers: string[] = []
          for (const e of searchable) {
            if (only && !kindsOf(e.config.kind).includes(only)) continue
            const out = await this.#list(e, caller, ctx, this.#queryOf(e, caller, { query: String(args.query), limit }))
            for (const row of out.rows) {
              // One kind per record: the record's own (its `by` field has no permission, so the caller sees it).
              const kind = kindOfRecord(e.config.kind, row)
              if (only && kind !== only) continue
              const uri = this.uri(e.name, String(row.id))
              const card = this.#recordCard(e, row, caller)
              const marked = this.#markCard(e, card, `/results/${results.length}`, pointers)
              results.push({ id: uri, entity: e.name, entityLabel: this.#t(caller, e.config.label), ...(kind ? { kind } : {}), ...card, url: uri })
              forModel.push({ id: uri, title: marked.title, url: uri, ...(kind ? { kind } : {}) })
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
          const hidden = parsed && (this.#entities.get(parsed.type)?.config.visibility === "app" || this.#artifacts.get(parsed.type)?.config.visibility === "app")
          if (!parsed || hidden) return failure("not_found", "Unknown id.")
          const r = await this.#resolve({ type: parsed.type, params: parsed.params }, caller, ctx)
          if (r.state !== "ok") return failure(r.state === "no-access" ? "permission_denied" : "not_found", r.state === "no-access" ? "No access." : "Not found.")
          const entity = this.#entities.get(parsed.type)
          const record = r.data as Record<string, unknown>
          const pointers: string[] = []
          const refs = entity ? await this.#refs(entity, [record], caller, ctx, pointers) : {}
          const marked = entity ? this.#named(entity, this.#markRow(entity, record, "/record", pointers), refs) : this.#markResolved(r, "", pointers)
          const title = "title" in r ? r.title : ""
          const kind = entity ? kindOfRecord(entity.config.kind, record) : null
          return {
            content: text(JSON.stringify({ id: r.uri, title: entity ? this.#markCard(entity, { title }, "", []).title : title, text: JSON.stringify(marked), url: r.uri, metadata: { type: parsed.type, ...(kind ? { kind } : {}) } })),
            structuredContent: entity ? { entity: entity.name, uri: r.uri, record, refs, view: r.template === "record" ? { ...("view" in r ? r.view : {}), title: this.#t(caller, entity.config.label) } : undefined } : { ...r, view: { kind: "artifact", title } },
            ...this.#marks(pointers),
          }
        }),
      )
    }

    // View tickets (spec §5.3): a workspace client frames the app's views from the app itself, for a signed-in person
    // (never the public caller), hidden from models.
    const tickets = this.#viewTickets
    if (tickets && caller.person && !caller.public) {
      reg(
        VIEW_TOOL,
        {
          title: "View ticket",
          description: "For Clegra clients: a one-minute, single-use ticket that opens one of the app's views at the app's own address, framed by a document of the given origin.",
          inputSchema: z.object({ view: z.string().describe("The view's URI (ui://…)"), origin: z.string().describe("The origin of the document that frames the view and posts the ticket") }),
          annotations: { title: "View ticket", readOnlyHint: true, idempotentHint: false, destructiveHint: false, openWorldHint: false },
          _meta: APP_ONLY_META,
        },
        guard(VIEW_TOOL, async (args) => {
          const uri = String(args.view)
          const path = viewPath(uri, this.name)
          const appOrigin = this.#appOrigin(request.origin ?? "")
          if (!path || !this.#viewDocuments().has(uri)) return failure("not_found", `No view ${uri}.`)
          try {
            const ticket = await tickets.issue({ view: uri, origin: String(args.origin), tenant: caller.installation, sub: caller.subject, action: `${appOrigin}${this.#path}${path}` })
            return { content: text(`A ticket for the view ${uri}, valid until ${ticket.expiresAt}.`), structuredContent: ticket }
          } catch (error) {
            if (!(error instanceof ViewError)) throw error
            return failure("permission_denied", error.message, { fields: { origin: error.message } })
          }
        }),
      )
    }

    // The resolver hosts use for cards (hidden from models).
    reg(
      RESOLVE_TOOL,
      {
        title: "Resolve",
        description: "For hosts: artifact and record URIs resolved for the viewer.",
        inputSchema: z.object({ uris: z.array(z.string()).max(50), want: z.enum(["reference", "artifact", "snapshot"]).optional() }),
        annotations: { ...read },
        _meta: { ui: { visibility: ["app"] }, "openai/visibility": "private", "openai/widgetAccessible": true },
      },
      guard(RESOLVE_TOOL, async (args, mctx) => {
        const ctx = ctxOf(mctx)
        const results = []
        const pointers: string[] = []
        // Every URI is read at once (one slow record doesn't hold the others); the answer keeps the order asked.
        const uris = args.uris as string[]
        const resolved = await Promise.all(
          uris.map((uri) => {
            const parsed = this.parseUri(uri)
            return parsed ? this.#resolve({ type: parsed.type, params: parsed.params }, caller, ctx).then((r) => ({ parsed, r })) : null
          }),
        )
        for (const [i, uri] of uris.entries()) {
          const found = resolved[i]
          if (!found) {
            // Another app's URI is not this app's to answer (spec §6): not_found, never a guess. This app's unknown type or record: gone.
            results.push({ uri, state: uri.startsWith(`${uriPrefix(this.name)}/`) ? "gone" : "not_found" })
            continue
          }
          const { parsed, r } = found
          if (r.state !== "ok") results.push({ uri, state: r.state })
          else {
            // For the host: which values are outsiders' text (it wraps them before a model reads them).
            const at = `/results/${results.length}`
            const entity = this.#entities.get(parsed.type)
            if (entity && "title" in r) this.#markCard(entity, { title: String(r.title), ...("subtitle" in r && typeof r.subtitle === "string" ? { subtitle: r.subtitle } : {}) }, at, pointers)
            if (args.want !== "reference") this.#markResolved(r, at, pointers)
            const { artifact: _f, view, ...rest } = r as typeof r & { view?: { actions?: { tool: string }[] } }
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
      // An action on a record: the id, and the record's title as a display hint, so a client's own approval prompt can
      // name the record the person approves (spec §6 rule 10). Descriptions in the app's locale, like every tool's.
      const one = a.entity ? t(a.entity.config.label).toLowerCase() : ""
      const input = a.entity
        ? z.object({
            id: z.string().describe(`The ${one}'s id, from a list, search or get result. When you describe this action or ask the person to approve it, name the ${one} by its title, never by this id`),
            [RECORD_TITLE_PARAM]: z.string().max(300).optional().describe(`The ${one}'s title as the list, search or get result gave it, so the person sees which ${one} they approve. Display only: the app names the ${one} from its id, and refuses the call if this names another one`),
            ...a.input.shape,
          })
        : a.input
      const crossInput = Object.values(((jsonSchemaOf(a.input, "input") as { properties?: Record<string, Record<string, unknown>> }).properties ?? {})).some((p) => kindRef(p))
      reg(
        a.tool,
        {
          title,
          description: `${t(a.config.description) || title}${a.write ? (a.confirm === "always" ? " (a change; the person confirms it first)" : " (a change)") : ""}.${a.entity ? ` On one ${one}: its \`id\`, and its title in \`${RECORD_TITLE_PARAM}\`.` : ""}${crossInput ? ` ${CROSS_INPUT_HINT}` : ""}`,
          inputSchema: listedOnly(input, t),
          annotations: { title, readOnlyHint: !a.write, destructiveHint: a.write && a.confirm === "always", idempotentHint: !a.write, openWorldHint: false },
          _meta: this.#callable(a.config.visibility === "app"),
        },
        guard(a.tool, (args, mctx) => this.#runAction(a, caller, args, mctx, request, request.received.get(mctx.mcpReq.id as string | number))),
      )
    }

    // Pages: open_<page> (record pages are <entity>_get).
    for (const p of this.#allPages()) {
      const c = p.config
      if (c.kind === "record" || !this.#canOpen(p, caller)) continue
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
          const parsed = params.safeParse(rest, this.#zodLocale(caller))
          if (!parsed.success) return this.#invalid(params, parsed.error, caller)
          const pageParams = parsed.data as Record<string, unknown>
          if (c.kind === "list") {
            const e = this.#entities.get(c.entity.name)!
            const query = this.#queryOf(e, caller, { ...(c.query ? {} : pageParams), cursor, limit }, c.query ? c.query(pageParams as never) : undefined)
            const out = await this.#list(e, caller, ctx, query)
            const visible = new Set(this.#visibleFields(e, caller).map((f) => f.name))
            // A page with parameters of its own decides its order itself (query): its columns are not sortable from outside.
            const columns = c.columns.filter((n) => visible.has(n)).map((n) => this.#column(e.fields.find((f) => f.name === n)!, caller)).map(({ sort, ...col }) => (sort && !c.params ? { ...col, sort } : col))
            const pointers: string[] = []
            const marked = out.rows.map((r, i) => this.#markRow(e, r, `/rows/${i}`, pointers))
            const refs = await this.#refs(e, out.rows, caller, ctx, pointers)
            return {
              content: text(JSON.stringify({ page: p.name, rows: marked.map((r) => this.#named(e, r, refs)), ...(out.next ? { next: out.next } : {}) })),
              structuredContent: { page: p.name, entity: e.name, params: pageParams, ...out, uris: out.rows.map((r) => this.uri(e.name, String(r.id))), refs, view: { kind: "list", title: this.#t(caller, c.title), columns, tool: p.tool.name, args: pageParams, getTool: e.tools.get.name, ...(query.sort && !c.params ? { sort: query.sort } : {}), ...this.#pageExtras(p, caller, pageParams) } },
              ...this.#marks(pointers),
            }
          }
          if (c.kind === "dashboard") {
            const instances = typeof c.artifacts === "function" ? await c.artifacts(pageParams as never, ctx) : c.artifacts
            const artifacts = []
            for (const i of instances) artifacts.push({ ...(await this.#resolve(i, caller, ctx)), ...(i.size ? { size: i.size } : {}) })
            const pointers: string[] = []
            return {
              content: text(JSON.stringify({ page: p.name, artifacts: artifacts.map((f, i) => ({ uri: f.uri, state: f.state, ...("data" in f ? { data: this.#markResolved(f, `/artifacts/${i}`, pointers) } : {}) })) })),
              structuredContent: { page: p.name, params: pageParams, artifacts, view: { kind: "dashboard", title: this.#t(caller, c.title), tool: p.tool.name, args: pageParams, ...this.#pageExtras(p, caller, pageParams) } },
              ...this.#marks(pointers),
            }
          }
          return { content: text(`Opened ${title}.`), structuredContent: { page: p.name, params: pageParams, view: { kind: "custom", title: this.#t(caller, c.title), ...this.#pageExtras(p, caller, pageParams) } } }
        }),
      )
    }

    // Custom artifact types: show_<type>.
    for (const f of this.#artifacts.values()) {
      if (!this.#canShow(f, caller)) continue
      const title = t(f.config.title)
      reg(
        f.tool.name,
        {
          title,
          description: `${t(f.config.description).replace(/[.\s]*$/, "")}. Shows it as a live artifact; don't repeat its data in full.`,
          inputSchema: f.config.params,
          annotations: { title, ...read },
          _meta: this.#ui(f.config.view ? this.#artifactViewUri(f.type) : this.#viewUri(), f.config.visibility === "app"),
        },
        guard(f.tool.name, async (args, mctx) => {
          const r = await this.#resolve({ type: f.type, params: args }, caller, ctxOf(mctx))
          if (r.state !== "ok") return failure(r.state === "no-access" ? "permission_denied" : "not_found", r.state === "no-access" ? "No access." : "Not available.")
          const pointers: string[] = []
          // A2UI over MCP (spec §5.4 rule 2): the surface also as an embedded resource, beside the text a model reads.
          const surface = "a2ui" in r && r.a2ui ? [{ type: "resource" as const, resource: { uri: surfaceResourceUri(this.name, f.type), mimeType: A2UI_MIME_TYPE, text: JSON.stringify(r.a2ui) } }] : []
          return { content: [...text(JSON.stringify({ uri: r.uri, data: this.#markResolved(r, "", pointers) })), ...surface], structuredContent: { ...r, view: { kind: "artifact", title: this.#t(caller, f.config.title) } }, ...this.#marks(pointers) }
        }),
      )
    }
    // The installation's own tools: listed only to the installation-level caller (a workspace host, no person).
    if (this.#isInstallation(caller)) this.#installationTools(caller, reg, guard, request)
    this.options.mcp?.(s, caller)
    return s
  }

  /** `clegra_later` (when an action has later) and the lifecycle tools the app implements, for the installation-level caller. */
  #installationTools(
    caller: Caller,
    reg: (name: string, config: Record<string, unknown>, cb: (args: Record<string, unknown>, ctx: ServerContext) => Promise<CallToolResult>) => void,
    guard: (name: string, fn: (args: Record<string, unknown>, ctx: ServerContext) => Promise<CallToolResult>) => (args: Record<string, unknown>, ctx: ServerContext) => Promise<CallToolResult>,
    request: RequestInfo,
  ): void {
    const write = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
    const meta = (mctx: ServerContext) => mctx.mcpReq._meta as Record<string, unknown> | undefined
    /** A lifecycle handler's context, its notifications kept for the result. */
    const run = async (mctx: ServerContext, fn: (ctx: Context) => Promise<CallToolResult>): Promise<CallToolResult> => {
      const notes: Notification[] = []
      const ctx = this.#context(caller, meta(mctx), notes)
      const result = await fn(ctx)
      const sent = this.#notificationsMeta(this.#sent(notes, caller, ctx))
      return { ...result, ...sent }
    }
    if (this.#laterActions().length) {
      reg(
        LATER_TOOL,
        {
          title: "Run due later actions",
          description: "For the workspace host, as the installation (its schedule clegra_later): runs the actions people confirmed for later whose time has come.",
          inputSchema: z.object({}),
          annotations: { title: "Run due later actions", ...write },
          _meta: APP_ONLY_META,
        },
        guard(LATER_TOOL, async (_args, mctx) => {
          const report = await this.#runDue(caller.installation, meta(mctx), request.trust, caller.locale)
          const count = (status: string) => report.runs.filter((r) => r.status === status).length
          return {
            content: text(`${report.runs.length} due: ${count("done")} done, ${count("failed")} failed, ${count("expired")} expired, ${count("refused")} refused.`),
            structuredContent: { runs: report.runs },
            ...this.#notificationsMeta(report.notifications),
          }
        }),
      )
    }
    const life = this.#lifecycle
    if (life.installation) {
      const handler = life.installation
      reg(
        INSTALLATION_TOOL,
        {
          title: "Installation changed",
          description: "For the workspace host, as the installation: the administrator enabled, disabled or uninstalled the app.",
          inputSchema: z.object({ state: z.enum(["enabled", "disabled", "uninstalled"]) }),
          annotations: { title: "Installation changed", ...write, idempotentHint: true },
          _meta: APP_ONLY_META,
        },
        guard(INSTALLATION_TOOL, (args, mctx) =>
          run(mctx, async (ctx) => {
            await handler(args.state as "enabled" | "disabled" | "uninstalled", ctx)
            return { content: text(`The installation is ${String(args.state)}.`), structuredContent: { ok: true } }
          }),
        ),
      )
    }
    if (life.export) {
      const handler = life.export
      reg(
        EXPORT_TOOL,
        {
          title: "Export",
          description: "For the workspace host, as the installation: everything the app keeps for it, as one file (an embedded resource).",
          inputSchema: z.object({}),
          annotations: { title: "Export", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
          _meta: APP_ONLY_META,
        },
        guard(EXPORT_TOOL, (_args, mctx) =>
          run(mctx, async (ctx) => {
            const file = await handler(ctx)
            if (!file) return { content: text("The app keeps nothing for this installation."), structuredContent: { empty: true } }
            return this.#exportResult(file)
          }),
        ),
      )
    }
    if (life.delete) {
      const handler = life.delete
      reg(
        DELETE_TOOL,
        {
          title: "Delete",
          description: "For the workspace host, as the installation: deletes everything the app keeps for it. Asking again answers the same.",
          inputSchema: z.object({}),
          annotations: { title: "Delete", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
          _meta: APP_ONLY_META,
        },
        guard(DELETE_TOOL, (_args, mctx) =>
          run(mctx, async (ctx) => {
            const out = await handler(ctx)
            // The later runs the SDK keeps for the tenant are its data too.
            const later = this.#store.later ? await this.#store.later.clear(caller.installation) : 0
            const counts = { ...(out && out.counts ? out.counts : {}), ...(later ? { later_runs: later } : {}) }
            return { content: text("Deleted."), structuredContent: { deleted: true, ...(Object.keys(counts).length ? { counts } : {}) } }
          }),
        ),
      )
    }
  }

  /** An export as the host takes it: the file's facts, and the file itself as one embedded resource (base64). */
  #exportResult(file: { name?: string; contentType: string; body: string | Uint8Array }): CallToolResult {
    const EXT: Record<string, string> = { "application/json": ".json", "text/csv": ".csv", "application/zip": ".zip", "text/plain": ".txt", "application/x-ndjson": ".ndjson" }
    if (typeof file.contentType !== "string" || !/^[\w.+-]+\/[\w.+-]+(\s*;.*)?$/.test(file.contentType)) throw new Error(`lifecycle.export: contentType "${String(file.contentType)}" is not a media type`)
    const name = file.name ?? `${this.name}-export${EXT[file.contentType.split(";")[0]!.trim()] ?? ""}`
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name)) throw new Error(`lifecycle.export: name "${name}": letters, digits, . _ -, at most 128`)
    const bytes = typeof file.body === "string" ? Buffer.from(file.body, "utf8") : Buffer.from(file.body.buffer, file.body.byteOffset, file.body.byteLength)
    if (bytes.byteLength > EXPORT_MAX_BYTES) throw new Error(`lifecycle.export: ${bytes.byteLength} bytes; an export is at most ${EXPORT_MAX_BYTES} bytes`)
    const sha256 = createHash("sha256").update(bytes).digest("hex")
    return {
      content: [
        { type: "text", text: `Export ${name}: ${bytes.byteLength} bytes.` },
        { type: "resource", resource: { uri: `${uriPrefix(this.name)}/export/${encodeURIComponent(name)}`, mimeType: file.contentType, blob: bytes.toString("base64") } },
      ],
      structuredContent: { name, contentType: file.contentType, bytes: bytes.byteLength, sha256 },
    }
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
      for (const [k, p] of Object.entries(raw.properties ?? {})) {
        const shown = plain.properties?.[k]
        if (!shown) continue
        if (isLabel(p.label)) shown.label = L(p.label)
        // What a host needs to draw the field and to show its value before a confirmation: the entity an id belongs to, a number's currency.
        if (typeof p.ref === "string") {
          if (!this.#entities.has(p.ref)) throw new Error(`an action's input "${k}": ref "${p.ref}" is not an entity`)
          shown.ref = p.ref
        }
        const kind = kindRef(p)
        if (kind !== undefined) {
          if (kindNameProblem(kind)) throw new Error(`an action's input "${k}": ref: ${kindNameProblem(kind)}`)
          shown.ref = { kind }
        }
        if (typeof p.currency === "string") shown.currency = p.currency
        if (p.labels && typeof p.labels === "object") shown.labels = Object.fromEntries(Object.entries(p.labels as Record<string, Label>).filter(([, l]) => isLabel(l)).map(([v, l]) => [v, L(l)!]))
      }
      return plain as Record<string, unknown>
    }
    const entities = [...this.#entities.values()].map((e) => {
      for (const f of e.fields) {
        if (localRef(f) && !this.#entities.has(localRef(f)!)) throw new Error(`entity "${e.name}", field "${f.name}": ref "${f.ref}" is not an entity`)
        perm(f.permission, `entity "${e.name}", field "${f.name}"`)
      }
      const fields: ManifestField[] = e.fields.map((f) => ({
        name: f.name,
        type: f.type,
        required: f.required,
        ...(f.enum ? { enum: f.enum } : {}),
        ...(f.role ? { role: f.role } : {}),
        label: L(f.label ?? f.name)!,
        ...(f.as !== undefined ? { as: f.as } : {}),
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
        ...(e.config.kind !== undefined ? { kind: e.config.kind } : {}),
        ...perm(e.config.permission, `entity "${e.name}"`),
        schema: plainSchema(jsonSchemaOf(e.config.schema)) as Record<string, unknown>,
        fields,
        tools: { list: e.tools.list, get: e.tools.get },
        searchable: e.fields.some((f) => f.search),
        ...(e.config.visibility === "app" ? { visibility: "app" as const } : {}),
        ...(e.config.record ? { record: { fields: [...e.config.record.fields], ...(e.config.record.actions?.length ? { actions: [...e.config.record.actions] } : {}) } } : {}),
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
      effect: !a.write ? ("read" as const) : a.confirm === "always" ? ("irreversible" as const) : ("write" as const),
      confirm: a.confirm,
      ...(a.config.public ? { public: true as const } : {}),
      ...perm(a.config.permission, `action "${a.name}"`),
      ...(a.config.visibility === "app" ? { visibility: "app" as const } : {}),
      ...(a.config.targets?.length ? { targets: a.config.targets.map((x) => ({ target: x.target, needs: [...x.needs], ...(x.input ? { input: JSON.parse(JSON.stringify(x.input)) as Record<string, unknown> } : {}), ...(x.label !== undefined ? { label: L(x.label)! } : {}) })) } : {}),
      ...(a.later ? { later: { at: a.later.at, window: a.later.window } } : {}),
    }))
    const everyone: Caller = { installation: "manifest", installationId: "manifest", person: null, permissions: new Set(this.#permissions.keys()), host: "workspace", issuer: "", subject: "" }
    const pages = this.#allPages().map((p) => {
      const c = p.config
      const { actions: pageActions, badge: pageBadge } = c as { actions?: ActionHandle[]; badge?: string }
      const base = {
        name: p.name,
        kind: c.kind,
        ...(c.kind !== "record" || c.title ? { title: L(c.kind === "record" ? (c.title ?? this.#entities.get(c.entity.name)!.config.label) : c.title)! } : { title: L(this.#entities.get(c.entity.name)!.config.label)! }),
        ...(c.icon ? { icon: c.icon } : c.kind === "record" || c.kind === "list" ? (this.#entities.get(c.entity.name)!.config.icon ? { icon: this.#entities.get(c.entity.name)!.config.icon } : {}) : {}),
        ...perm(c.permission, `page "${p.name}"`),
        params: plainSchema(jsonSchemaOf(this.#pageParams(p, everyone), "input")) as Record<string, unknown>,
        // Also on a record page, where the rules refuse them (a definition error, not a silent drop).
        ...(pageActions?.length ? { actions: pageActions.map((h) => this.#actions.get(h.tool)?.name ?? h.name) } : {}),
        ...(pageBadge !== undefined ? { badge: pageBadge } : {}),
      }
      const override = c.kind !== "custom" && c.view ? { view: this.#pageViewUri(p.name) } : {}
      if (c.kind === "list") return { ...base, entity: c.entity.name, columns: c.columns, tool: p.tool, ...override }
      if (c.kind === "record") {
        for (const s of c.sections ?? []) for (const f of s.fields) if (!c.entity.fields.some((x) => x.name === f)) throw new Error(`page "${p.name}": field "${f}" is not a field of ${c.entity.name}`)
        return { ...base, entity: c.entity.name, tool: p.tool, ...override, ...(c.sections ? { sections: c.sections.map((s) => ({ title: L(s.title)!, fields: s.fields })) } : {}), ...(p.derived ? { derived: true } : {}) }
      }
      if (c.kind === "dashboard") return { ...base, tool: p.tool, view: this.#pageViewUri(p.name) }
      return { ...base, tool: p.tool, view: this.#pageViewUri(p.name) }
    })
    const artifacts = [
      ...[...this.#entities.values()].map((e) => ({ type: e.name, title: L(e.config.label)!, entity: e.name, template: "record" as const, params: { type: "object", properties: { id: { type: "string" } }, required: ["id"] }, tool: e.tools.get, ...(e.config.view ? { view: this.#entityViewUri(e.name) } : {}), ...perm(e.config.permission, `entity "${e.name}"`), ...(e.config.create ? { create: { action: e.config.create.action, title: L(e.config.create.title ?? e.config.label)! } } : {}) })),
      ...[...this.#artifacts.values()].map((f) => {
        for (const h of f.config.actions ?? []) if (!this.#actions.has(h.tool)) throw new Error(`artifact "${f.type}": action ${h.tool} is not registered`)
        return {
          type: f.type,
          title: L(f.config.title)!,
          description: L(f.config.description),
          ...(f.config.icon ? { icon: f.config.icon } : {}),
          params: plainSchema(jsonSchemaOf(f.config.params, "input")) as Record<string, unknown>,
          ...(f.config.template ? { template: f.config.template } : {}),
          ...((f.config as { component?: string }).component ? { component: (f.config as { component?: string }).component } : {}),
          ...(f.config.view ? { view: this.#artifactViewUri(f.type) } : {}),
          tool: f.tool,
          ...perm(f.config.permission, `artifact "${f.type}"`),
          ...(f.config.actions?.length ? { actions: f.config.actions.map((h) => h.name) } : {}),
          ...(f.config.size ? { size: f.config.size } : {}),
          ...(f.config.untrusted ? { untrusted: true } : {}),
          ...(f.config.visibility === "app" ? { visibility: "app" as const } : {}),
          ...(f.config.create ? { create: { action: f.config.create.action, title: L(f.config.create.title ?? f.config.title)! } } : {}),
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
    const types: [string, NotificationTypeConfig][] = [...this.#notificationTypes.entries(), ...(this.#laterActions().length ? [[LATER_TOOL, LATER_NOTIFICATION] as [string, NotificationTypeConfig]] : [])]
    const notifications = types.map(([type, n]) => ({ type, label: L(n.label)!, ...(n.description !== undefined ? { description: L(n.description)! } : {}), default: n.default !== false, ...perm(n.permission, `notification "${type}"`) }))
    const lifecycle = {
      ...(this.#lifecycle.installation ? { installation: INSTALLATION_TOOL } : {}),
      ...(this.#lifecycle.export ? { export: EXPORT_TOOL } : {}),
      ...(this.#lifecycle.delete ? { delete: DELETE_TOOL } : {}),
    } as Manifest["lifecycle"] & object
    this.#manifest = {
      specVersion: SPEC_VERSION,
      name: this.name,
      title: L(this.options.title)!,
      version: this.options.version,
      ...(this.options.description ? { description: L(this.options.description) } : {}),
      ...(this.options.icons ? { icons: this.options.icons } : {}),
      ...(this.options.accent !== undefined ? { accent: this.options.accent } : {}),
      ...(this.options.publisher ? { publisher: { name: this.options.publisher.name, url: this.options.publisher.url } } : {}),
      locale: this.locale,
      mcp: { url: `${this.#path}/mcp` },
      // The server's own address is what its tokens are for (never a name an app could claim): a host installs the app from it or not at all.
      auth: { ...((auth.resource ?? auth.signIn?.resource) ? { resource: auth.resource ?? auth.signIn!.resource } : {}), authorizationServers: auth.signIn ? [...auth.signIn.authorizationServers] : (auth.authorizationServers ?? []) },
      view: this.#viewUri(),
      resolveTool: RESOLVE_TOOL,
      ...(this.#site ? { site: { start: this.#site.start } } : {}),
      ...(this.#components.size ? { components: Object.fromEntries(this.#componentEntries().map(({ name, ...c }) => [name, c])) } : {}),
      ...([...this.#entities.values()].some((e) => e.fields.some((f) => f.search)) ? { searchTool: "search" } : {}),
      ...(Object.keys(this.#kinds).length ? { kinds: Object.fromEntries(Object.entries(this.#kinds).map(([k, d]) => [k, { label: L(d.label)!, properties: d.properties }])) } : {}),
      entities,
      actions,
      pages,
      artifacts,
      ...(this.#widgets.size ? { widgets: [...this.#widgets].map(([artifact, w]) => ({ artifact, sizes: [...w.sizes], size: w.size })) } : {}),
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
      ...(this.#nav ? { nav: this.#nav.map((s) => ({ ...(s.section !== undefined ? { section: L(s.section)! } : {}), pages: [...s.pages] })) } : {}),
      ...(this.#allSchedules().length ? { schedules: this.#allSchedules().map((s) => ({ name: s.name, ...(s.name !== LATER_TOOL ? { action: s.action?.name ?? s.tool } : {}), tool: s.tool, every: s.every, maxSeconds: s.maxSeconds })) } : {}),
      ...(notifications.length ? { notifications } : {}),
      ...(Object.keys(lifecycle).length ? { lifecycle } : {}),
    }
    // The rules beyond the schema (spec/src/rules.ts, the same the conformance checks run): a wrong name fails here, at definition time.
    const problems = manifestRuleProblems(this.#manifest)
    if (problems.length) {
      this.#manifest = null
      throw new Error(problems.join("; "))
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

  /**
   * A dev access token (tests, local hosts). `host: "workspace"` makes the SDK ask for confirmation proofs.
   * `person: null` with `host: "workspace"`: the installation-level caller (schedules, later runs, lifecycle tools).
   */
  async devToken(input: { person?: string | Person | null; permissions?: string[] | "all"; host?: "workspace" | "plain"; installation?: string; locale?: string } = {}): Promise<string> {
    const dev = await this.#devStarted()
    return dev.token({ ...input, audience: DEV_ISSUER })
  }

  /**
   * A dev confirmation proof for one call (what a workspace host signs after «Confirm»). For an action with `later`
   * it carries the run's deadline (`until`, from the arguments' `at` and the action's window) unless `until` is given.
   */
  async devConfirmation(input: { tool: string; args: Record<string, unknown>; call: string; person?: string; installation?: string; until?: number }): Promise<string> {
    const dev = await this.#devStarted()
    const sub = input.person ?? dev.people[0]!.id
    const later = this.#actions.get(input.tool)?.later
    const until = input.until ?? (later && typeof input.args[later.at] === "string" ? laterDeadline(input.args[later.at] as string, later.window) : undefined)
    return signConfirmation(dev.key, { iss: DEV_ISSUER, aud: DEV_ISSUER, sub, installation: input.installation ?? dev.installation, tool: input.tool, args: input.args, call: input.call, ...(until !== undefined && Number.isFinite(until) ? { until } : {}) })
  }

  // ------------------------------------------------------------ HTTP

  #origin(request: Request): string {
    const url = new URL(request.url)
    const proto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() || url.protocol.replace(":", "")
    const host = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim() || request.headers.get("host") || url.host
    return `${proto}://${host}`
  }

  async #caller(request: Request, resource: string, trust: RequestTrust, cors: Record<string, string>): Promise<Caller | Response> {
    const auth = this.options.auth ?? {}
    const authorization = request.headers.get("authorization") ?? ""
    const bearer = /^Bearer\s+(.+)$/i.exec(authorization)?.[1]?.trim()
    const dpopToken = /^DPoP\s+(.+)$/i.exec(authorization)?.[1]?.trim()
    const metadata = `${new URL(resource).origin}/.well-known/oauth-protected-resource${new URL(resource).pathname}`
    const quote = (reason: string) => reason.replace(/["\\]/g, "'")
    const scheme = `Bearer resource_metadata="${metadata}"`
    const challenge = (reason: string, { credentials = true }: { credentials?: boolean } = {}) =>
      new Response(JSON.stringify({ error: "invalid_token", error_description: reason }), {
        status: 401,
        // RFC 6750 §3.1: a request without any credentials gets no error code.
        headers: { "content-type": "application/json", "www-authenticate": credentials ? `${scheme}, error="invalid_token", error_description="${quote(reason)}"` : `${scheme}, error_description="${quote(reason)}"`, ...cors },
      })
    if (auth.signIn && (bearer || dpopToken)) {
      // The app's own sign-in module (`@clegra/sdk/signin`): its access tokens (Bearer, or DPoP-bound) and personal keys.
      try {
        const resolved = await auth.signIn.resolve((dpopToken ?? bearer)!, request, { resource, scheme: dpopToken ? "DPoP" : "Bearer" })
        if (resolved) return this.#resolved(resolved)
      } catch (error) {
        if (!(error instanceof AuthError)) console.error(`[${PROTOCOL_ID}] auth`, error)
        const reason = error instanceof AuthError ? error.message : "invalid token"
        const nonce = error instanceof DpopError ? error.nonce : null
        const code = nonce ? "use_dpop_nonce" : error instanceof DpopError ? "invalid_dpop_proof" : "invalid_token"
        return new Response(JSON.stringify({ error: code, error_description: reason }), {
          status: 401,
          headers: { "content-type": "application/json", "www-authenticate": `${dpopToken ? `DPoP algs="${DPOP_ALGS}", ` : "Bearer "}resource_metadata="${metadata}", error="${code}", error_description="${quote(reason)}"`, ...(nonce ? { "dpop-nonce": nonce } : {}), "cache-control": "no-store", ...cors },
        })
      }
    }
    if (dpopToken) return challenge("a DPoP-bound token is accepted only from this app's own sign-in (auth.signIn)")
    if (!bearer) {
      if (auth.anonymous) {
        const a = auth.anonymous
        return { installation: tenantOf(a.installation, "anonymous"), installationId: a.installation, person: a.person ?? null, permissions: new Set(a.permissions === "all" ? this.#allPermissions() : a.permissions), ...(a.locale ? { locale: a.locale } : {}), host: "plain", issuer: "anonymous", subject: a.person?.id ?? "anonymous" }
      }
      if (auth.public) {
        const p = auth.public
        return { installation: tenantOf(p.installation, "public"), installationId: p.installation, person: null, permissions: new Set<string>(), ...(p.locale ? { locale: p.locale } : {}), host: "plain", issuer: "public", subject: "public", public: true }
      }
      return challenge("sign in first", { credentials: false })
    }
    if (trust.dev) await this.#devStarted()
    try {
      // A workspace host's token (or a dev token) is the SDK's to verify; any other is the app's own.
      if (auth.resolve && !this.#verifier.knows(bearer)) return this.#resolved(await auth.resolve(bearer, request, { resource }))
      return await this.#verifier.verify(bearer, trust)
    } catch (error) {
      if (!(error instanceof AuthError)) console.error(`[${PROTOCOL_ID}] auth`, error)
      return challenge(error instanceof AuthError ? error.message : "invalid token")
    }
  }

  /** A caller the app's own `auth.resolve` named, checked: its tenant is the app's, never one of a host's. */
  #resolved(r: Awaited<ReturnType<NonNullable<AuthOptions["resolve"]>>>): Caller {
    if (!r) throw new AuthError("not a token of this app")
    if (typeof r.installation !== "string" || !INSTALLATION.test(r.installation)) throw new AuthError("auth.resolve: installation must match [A-Za-z0-9._:-]{1,128}")
    const person = r.person && typeof r.person.id === "string" && r.person.id ? { id: r.person.id, name: String(r.person.name ?? "") } : null
    const known = new Set(this.#allPermissions())
    const permissions = r.permissions === "all" ? known : new Set([...(r.permissions ?? [])].filter((p) => known.has(p)))
    return { installation: r.installation, installationId: r.installation, person, permissions, ...(r.locale ? { locale: r.locale } : {}), host: "plain", issuer: OWN_ISSUER, subject: r.subject ?? person?.id ?? "anonymous", ...(r.admin === true ? { admin: true } : {}) }
  }

  /** The app's own path of a request (its `path` taken off), or null when the request is outside it. */
  #local(pathname: string): string | null {
    const base = this.#path
    if (pathname.startsWith("/.well-known/")) return pathname
    if (!base) return pathname
    if (pathname === base) return "/"
    return pathname.startsWith(`${base}/`) ? pathname.slice(base.length) : null
  }

  /**
   * Readiness for serving (`listen` in `@clegra/sdk/node`, a framework adapter): the manifest is built and
   * checked, the dev authority started. Returns the dev sign-in code when dev sign-in is on.
   */
  async start(): Promise<{ devCode: string | null }> {
    this.manifest()
    if (this.#dev) await this.#devStarted()
    const auth = this.options.auth ?? {}
    if (!this.#dev && !auth.signIn && !auth.resolve && !auth.anonymous && !auth.public) console.warn(`[${PROTOCOL_ID}] nobody can sign in: give auth.signIn (the app's own sign-in, @clegra/sdk/signin), auth.resolve (tokens of the app's own authorization server) or auth.public, or turn on auth.dev while developing`)
    return { devCode: this.#dev?.code ?? null }
  }

  /** What is wrong with this configuration for production, said on every request instead of guessed around (no fallback). */
  #productionProblem(): string | null {
    if (process.env.NODE_ENV !== "production") return null
    const auth = this.options.auth ?? {}
    if (auth.resolve && !auth.resource) return "auth.resource is required in production: this server's public MCP address (https://…/mcp), the only audience its tokens are accepted for"
    return null
  }

  /**
   * One HTTP request (Fetch API): MCP at `<path>/mcp`, the manifest, OAuth metadata, the dev authority, `<path>/health`.
   * `info.remoteAddress`: the address the request came from. Dev sign-in and dev tokens count only when it is
   * a loopback address, checked on every request (`listen` passes the socket's; without it dev mode stays shut).
   */
  async fetch(request: Request, info: { remoteAddress?: string | null } = {}): Promise<Response> {
    const url = new URL(request.url)
    const origin = this.#origin(request)
    const auth = this.options.auth ?? {}
    // Any origin, as an open MCP server: no cookie is ever read on these routes, the token says who calls.
    const cors = CORS
    const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...cors, ...headers } })
    const base = this.#path
    const path = this.#local(url.pathname)
    // What a core reads to register the app (spec §7, «Registration») is public and needs no configuration: the manifest, then the
    // registration document. It comes before the production check, since registering is what gives the app its
    // registration id; everything else (tokens, events, views, the site, MCP) keeps refusing until the app is configured.
    if (path === MANIFEST_PATH) return json(this.manifest(), 200, { "cache-control": "public, max-age=30" })
    const problem = this.#productionProblem()
    if (problem) return json({ error: "misconfigured", error_description: problem }, 500)
    const devHere = Boolean(this.#dev) && isLoopback(info.remoteAddress)
    // In dev the server is whatever address the caller reached it by (a tunnel); otherwise only its configured one.
    const requestResource = `${origin}${base}/mcp`
    const resource = devHere ? requestResource : (auth.resource ?? auth.signIn?.resource ?? requestResource)
    const trust: RequestTrust = { dev: devHere, requestResource: devHere ? requestResource : null }
    // Preflight: the headers the browser asks for are allowed as asked (MCP 2026-07-28 clients send mcp-method, mcp-name, Mcp-Param-*; no cookies are ever used).
    if (request.method === "OPTIONS") {
      const asked = request.headers.get("access-control-request-headers")
      return new Response(null, { status: 204, headers: { ...CORS, ...(asked && /^[\w\-, ]{1,2000}$/.test(asked) ? { "access-control-allow-headers": asked } : {}), "access-control-max-age": "600", vary: "access-control-request-headers" } })
    }
    const notHere = () => new Response(`${localize(this.options.title, this.locale, this.locale)}: MCP at ${base}/mcp, manifest at ${MANIFEST_PATH}`, { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } })
    if (path === null) return notHere()
    if (path === "/" && request.method === "GET" && (request.headers.get("accept") ?? "").includes("application/json")) return json({ name: this.name, manifest: MANIFEST_PATH, mcp: `${base}/mcp` })
    if (path === "/health") return json({ ok: true, name: this.name, version: this.options.version })
    if (path.startsWith(`${VIEWS_PATH}/`) && this.#viewTickets) return this.#serveView(request, path)
    if (path === SITE_BRIDGE_PATH && this.#site) return new Response(siteBridgeScript(this.#clientOrigins), { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "public, max-age=300", "x-content-type-options": "nosniff", "access-control-allow-origin": "*" } })
    if (path === "/.well-known/oauth-protected-resource" || path === `/.well-known/oauth-protected-resource${base}/mcp`) {
      // Where a client signs a person in: the app's own authorization server (with dev sign-in on, this server). Never Clegra's core: its tokens come from Clegra, not by OAuth (M3).
      const servers = auth.signIn ? auth.signIn.authorizationServers : (auth.authorizationServers ?? (devHere ? [`${origin}${base}`] : []))
      return json({ resource, authorization_servers: servers, bearer_methods_supported: ["header"], scopes_supported: [OAUTH_SCOPE], resource_name: localize(this.options.title, this.locale, this.locale) })
    }
    if (auth.signIn) {
      const answered = await auth.signIn.fetch(request)
      if (answered) return answered
    }
    if (auth.serve) {
      const answered = await auth.serve(request)
      if (answered) return answered
    }
    if (devHere) {
      const dev = await this.#devStarted()
      // The dev authority's paths are the app's own (under `path`), its metadata also at the RFC 8414 address for an issuer with a path.
      const devPath = base && path.startsWith("/.well-known/") && path.endsWith(base) ? path.slice(0, -base.length) : path
      const local = devPath === url.pathname ? request : new Request(new URL(devPath + url.search, url.origin), request)
      const answered = await dev.handle(local, `${origin}${base}`, resource)
      if (answered) return answered
    }
    if (path !== "/mcp") return notHere()
    const caller = await this.#caller(request, resource, trust, cors)
    if (caller instanceof Response) return caller
    if (!this.options.store && !this.#warnedStore && process.env.NODE_ENV === "production") {
      this.#warnedStore = true
      console.warn(`[${PROTOCOL_ID}] store: idempotency and one-time tokens are kept in memory; on serverless or several instances give a shared store (SqlStore)`)
    }
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
    const response = await this.#handler.fetch(request, { authInfo: { token: "verified", clientId: caller.issuer, scopes: [], extra: { caller, request: { trust, received, origin } satisfies RequestInfo } } })
    const headers = new Headers(response.headers)
    for (const [k, v] of Object.entries(cors)) headers.set(k, v)
    return new Response(response.body, { status: response.status, headers })
  }

  /**
   * `POST <path>/clegra/views/<view>` with a view ticket (spec §5.3): the view's document, at the app's own origin,
   * framed only by the client origin the ticket was for. Anything else: a plain refusal, framable by no one.
   */
  async #serveView(request: Request, path: string): Promise<Response> {
    const refuse = (status: number, reason: string) =>
      new Response(reason, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "content-security-policy": "default-src 'none'; frame-ancestors 'none'", "x-content-type-options": "nosniff", ...(status === 405 ? { allow: "POST" } : {}) } })
    const uri = `ui://${this.name}/${path.slice(VIEWS_PATH.length + 1)}`
    const view = viewPath(uri, this.name) === path ? this.#viewDocuments().get(uri) : undefined
    if (!view) return refuse(404, "no such view")
    let opened: Awaited<ReturnType<ViewTickets["redeem"]>>
    try {
      opened = await this.#viewTickets!.redeem(request, uri)
    } catch (error) {
      if (error instanceof ViewError) return refuse(error.status, error.message)
      throw error
    }
    return new Response(withHost(await view.html(), opened.origin), {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": viewPolicy(view.ui.csp, opened.origin),
        // same-origin: the view's own requests to the app keep their Origin (under no-referrer a form's is "null");
        // requests to other origins carry no referrer.
        "referrer-policy": "same-origin",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    })
  }

  /** Whether dev sign-in is on (it then answers loopback callers only). */
  get devMode(): boolean {
    return Boolean(this.#dev)
  }
}

const CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
  "access-control-allow-headers": "authorization, dpop, content-type, mcp-session-id, mcp-protocol-version, last-event-id",
  "access-control-expose-headers": "www-authenticate, dpop-nonce, mcp-session-id",
}
