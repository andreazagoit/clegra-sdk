import type { Icon, McpServer } from "@modelcontextprotocol/server"
import type { z } from "zod"

import type { EntityKind } from "../spec/src/kinds"
import type { AppAccent } from "../spec/src/protocol"
import type { AuthOptions, Caller } from "./auth"
import type { Label } from "./labels"
import type { Manifest } from "./manifest"
import { AppServer, type PeopleResolver } from "./server"
import type { SiteOptions } from "./site"
import type { IdempotencyStore } from "./store"
import type { ActionHandle, ActionResult, ArtifactInstance, Confirm, Context, EntityHandle, Exposure, KindConfig, LaterConfig, LifecycleConfig, ListResult, PageConfig, PermissionConfig, Publisher, Query, SettingConfig, Target, TemplateData, ViewSource, Visibility, WidgetConfig } from "./types"

/**
 * THE AUTHORING API (spec §1). An app is its definition, one thing per file:
 *
 * - `defineEntity`, `defineAction`, `defineArtifact`, `defineComponent`, `definePage`, `defineAgent` each return a
 *   handle; one thing names another by its imported handle (an action `on: deal`, a page `list: deal`), never by a
 *   string;
 * - `defineApp({ entities: [deal], actions: [markWon], pages: [deals], … })` assembles them (`clegra/app.ts`): pure,
 *   checked at once, its manifest computable, nothing served;
 * - `serve(app, { auth, store, people, site, clientOrigins, path, mcp })` is the runtime: a `fetch(request)` handler
 *   on Web APIs, which the adapters (`@clegra/sdk/node`, `/next`, `/express`) mount.
 */

type Awaitable<T> = T | Promise<T>
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a handle of any schema
type AnyObject = z.ZodObject<any>

// ------------------------------------------------------------------ entities

export type EntityDef<S extends AnyObject> = {
  /** The entity's name: lowercase letters, digits and `_`, starting with a letter (`deal`). Its tools are `<name>_list`, `<name>_get`. */
  name: string
  label: Label
  plural?: Label
  description?: Label
  /** A lucide icon name. */
  icon?: string
  /**
   * What the entity is, the same in every app (spec §3.1): `"person"`, `"organization"`, `"event"`, `"task"`,
   * `"document"`, `"product"`, `"order"`, or a namespaced kind (`"com.example.shipment"`). Or one kind per record:
   * `{ by: "type", map: { company: "organization", private: "person" } }` over a required enum field. Fields say
   * which property of the kind they hold with `.meta({ as: "email" })`. Leave it out for the app's own entities (a deal).
   */
  kind?: EntityKind
  /** A Zod object; fields carry their meaning with `.meta({ role, label, filter, as, … })`. Needs a string `id` and one `role: "title"`. */
  schema: S
  /** Who may see records of this entity at all (a permission id of `defineApp`'s `permissions`). */
  permission?: string
  get: (id: string, ctx: Context) => Awaitable<z.infer<S> | null>
  /** `query.text` is searched only in `query.textFields` (the search fields the caller may see). */
  list: (query: Query, ctx: Context) => Awaitable<ListResult<z.infer<S>>>
  /** Plain MCP clients: `plain: false` hides the entity's tools; `list` / `get` rename them (default `<entity>_list`, `<entity>_get`). */
  expose?: { plain?: boolean; list?: string; get?: string }
  /** Your own ui:// view for one record, instead of the generated one. */
  view?: ViewSource
  /** `"app"`: its tools are for views and the host's own UI only, never for a model (search and fetch leave its records out). */
  visibility?: Visibility
  /**
   * The record template (spec §5.4 rule 4 `record`): up to 6 key fields, in order. Hosts draw every record of the
   * entity from it (in answers, documents, Home), with the record actions marked `featured`. Default: the first four
   * fields a list would show, no actions.
   */
  record?: { fields: (keyof z.infer<S> & string)[] }
}

/** An entity, as `defineEntity` returns it: what actions, pages and agents name it by. */
export type Entity<S extends AnyObject = AnyObject> = { readonly kind: "entity"; readonly name: string; readonly schema: S; readonly definition: EntityDef<S> }

/** An entity (spec §4): its records, their meaning, and how the app reads them. */
export function defineEntity<S extends AnyObject>(def: EntityDef<S>): Entity<S> {
  return Object.freeze({ kind: "entity" as const, name: def.name, schema: def.schema, definition: def })
}

// ------------------------------------------------------------------ actions

type ActionBase<I extends AnyObject> = {
  /** The action's name: lowercase letters, digits and `_`. Its tool is `<entity>_<name>` on a record, else `<name>`. */
  name: string
  title: Label
  description?: Label
  icon?: string
  /** The input, a Zod object (`z.object({})` for none). On a record action the SDK adds `id`. */
  input: I
  /** A read: changes nothing (index effect `read`). */
  readOnly?: boolean
  /** Writes ask the person first by default (`true` / "always", index effect `irreversible`); "optional" lets the host decide; `false` / "never" never asks. */
  confirm?: boolean | Confirm
  /** The permission it needs (an id of `defineApp`'s `permissions`). */
  permission?: string
  /** Callable without signing in (`auth.public`): global, no permission; a public write is always confirmed by the host. */
  public?: boolean
  /** Plain MCP clients: `plain: false` keeps it for the app's own views; `tool` renames the tool. */
  expose?: Exposure
  /** `"app"`: for views and the host's own UI only, never for a model. */
  visibility?: Visibility
  /**
   * «Approve now, act later», on a write the person confirms: `at` names a required date-time input; the confirmed
   * call is kept (the store's `later` part) and runs at that time, at most `window` minutes late (10–10080, default 60).
   */
  later?: LaterConfig<z.infer<I>>
}

/** What a «+ Nuovo» makes (spec §5 `create`): an entity's empty record or an artifact, with the menu's words (default its label). */
export type Creates = Entity | Artifact | { of: Entity | Artifact; title: Label }

export type GlobalActionDef<I extends AnyObject> = ActionBase<I> & {
  on?: undefined
  /** Where a host offers the action on something else: an email (`mail.message`) or a record of a kind (`record:organization`), with its input filled from it. At most 4. */
  targets?: Target<z.infer<I>>[]
  /**
   * People create a new one from a workspace host's «+ Nuovo» and a document's «/» menu with this action (spec §5
   * `create`): a write with no required input and no confirmation that makes an empty one and returns
   * `{ record: ctx.uri(entity, id) }` (or the new artifact's URI).
   */
  creates?: Creates
  featured?: undefined
  run: (input: z.infer<I>, ctx: Context) => Awaitable<ActionResult | void>
}

export type RecordActionDef<I extends AnyObject, S extends AnyObject> = ActionBase<I> & {
  /** The entity whose record the action works on. */
  on: Entity<S>
  /** Shown on the entity's record template (spec §5.4 rule 4), up to 3, in the app's order of actions. */
  featured?: boolean
  targets?: never
  creates?: never
  run: (input: z.infer<I>, ctx: Context, record: z.infer<S>) => Awaitable<ActionResult | void>
}

/** An action, as `defineAction` returns it. */
export type Action<I extends AnyObject = AnyObject> = { readonly kind: "action"; readonly name: string; readonly input: I; readonly definition: GlobalActionDef<I> | RecordActionDef<I, AnyObject> }

/** An action (spec §5): on one record of an entity (`on`), or global. */
export function defineAction<I extends AnyObject, S extends AnyObject>(def: RecordActionDef<I, S>): Action<I>
export function defineAction<I extends AnyObject>(def: GlobalActionDef<I>): Action<I>
export function defineAction(def: GlobalActionDef<AnyObject> | RecordActionDef<AnyObject, AnyObject>): Action {
  return Object.freeze({ kind: "action" as const, name: def.name, input: def.input, definition: def as GlobalActionDef<AnyObject> })
}

// ------------------------------------------------------------------ components

/** One of the app's own A2UI components (spec §5.4 rule 6): a page of the app drawing the props a host gives it, inside any A2UI surface. */
export type ComponentDef<Pr extends AnyObject = AnyObject> = {
  /** `[A-Z][A-Za-z0-9]*` (`StageFunnel`). */
  name: string
  title: Label
  description?: Label
  /** The data it draws (a Zod object): an artifact with `component` returns them. */
  props: Pr
  /** Its page: an MCP Apps document (HTML that speaks MCP Apps with the host), served at `ui://<app>/components/<Name>`. */
  view: ViewSource
  /** Global actions the page may call through the host (a write still waits for the person's confirmation). */
  actions?: Action[]
}

export type Component<Pr extends AnyObject = AnyObject> = { readonly kind: "component"; readonly name: string; readonly props: Pr; readonly definition: ComponentDef<Pr> }

export function defineComponent<Pr extends AnyObject>(def: ComponentDef<Pr>): Component<Pr> {
  return Object.freeze({ kind: "component" as const, name: def.name, props: def.props, definition: def })
}

// ------------------------------------------------------------------ artifacts

type ArtifactBase<Pm extends AnyObject> = {
  /** The artifact type: lowercase letters, digits and `_`. Its tool is `show_<name>`. */
  name: string
  title: Label
  description: Label
  icon?: string
  /** The parameters, a Zod object (`z.object({})` for none). */
  params: Pm
  permission?: string
  /** Global actions shown inside. */
  actions?: Action[]
  size?: "small" | "medium" | "large"
  /** Plain MCP clients: `plain: false` hides its tool; `tool` renames it (default `show_<artifact>`). */
  expose?: Exposure
  /** Its texts are written by outsiders (records' names, notes): marked as data for models. */
  untrusted?: boolean
  /** `"app"`: its tool is for views and the host's own UI only, never for a model. */
  visibility?: Visibility
  /**
   * Offered as a Home widget (spec §5.5), in the app's order of artifacts: a template or component artifact without
   * required params, with its sizes (default medium and large) and the one it is added at (default the first).
   */
  widget?: true | WidgetConfig
}

export type TemplateArtifactDef<Pm extends AnyObject, T extends keyof TemplateData> = ArtifactBase<Pm> & {
  /** Drawn by the host (and by the generated view). */
  template: T
  data: (params: z.infer<Pm>, ctx: Context) => Awaitable<TemplateData[T] | null>
  /** Your own ui:// view instead of the generated one. */
  view?: ViewSource
  component?: undefined
}
export type ViewArtifactDef<Pm extends AnyObject> = ArtifactBase<Pm> & { template?: undefined; component?: undefined; /** Your own ui:// view (an MCP Apps document). */ view: ViewSource; data: (params: z.infer<Pm>, ctx: Context) => Awaitable<Record<string, unknown> | null> }
export type ComponentArtifactDef<Pm extends AnyObject, Pr extends AnyObject> = ArtifactBase<Pm> & {
  template?: undefined
  view?: undefined
  /** One of the app's own components: its data are the component's props. */
  component: Component<Pr>
  data: (params: z.infer<Pm>, ctx: Context) => Awaitable<z.input<Pr> | null>
}

export type Artifact<Pm extends AnyObject = AnyObject> = {
  readonly kind: "artifact"
  readonly name: string
  readonly params: Pm
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- any template, view or component
  readonly definition: TemplateArtifactDef<Pm, keyof TemplateData> | ViewArtifactDef<Pm> | ComponentArtifactDef<Pm, any>
}

/** An artifact type (spec §5.4): live data drawn by a template, a component or the app's own view. */
export function defineArtifact<Pm extends AnyObject, T extends keyof TemplateData>(def: TemplateArtifactDef<Pm, T>): Artifact<Pm>
export function defineArtifact<Pm extends AnyObject, Pr extends AnyObject>(def: ComponentArtifactDef<Pm, Pr>): Artifact<Pm>
export function defineArtifact<Pm extends AnyObject>(def: ViewArtifactDef<Pm>): Artifact<Pm>
export function defineArtifact(def: Artifact["definition"]): Artifact {
  return Object.freeze({ kind: "artifact" as const, name: def.name, params: def.params, definition: def })
}

// ------------------------------------------------------------------ pages

type PageBase = {
  /** The page's name: lowercase letters, digits and `_`. Its tool is `open_<name>`. */
  name: string
  title: Label
  icon?: string
  description?: Label
  permission?: string
  /** Plain MCP clients: `plain: false` hides its tool; `tool` renames it (default `open_<page>`). */
  expose?: Exposure
  /** Global actions offered on the page, at most 8; the first is its primary. Page params prefill inputs of the same name. */
  actions?: Action[]
  /** A `stat` artifact without required params: its value is the page's count in the navigation. */
  badge?: Artifact
}

/** An artifact on a dashboard: which one (an entity: its record card, `params: { id }`), its params, its size. */
export type DashboardItem = { artifact: Artifact | Entity; params?: Record<string, unknown>; size?: "small" | "medium" | "large" }

export type ListPageDef<S extends AnyObject, P extends AnyObject> = PageBase & {
  /** A list of this entity's records. */
  list: Entity<S>
  columns: (keyof z.infer<S> & string)[]
  /** Parameters of the page (default: the entity's filter fields). With `params`, give `query`. */
  params?: P
  query?: (params: z.infer<P>) => Partial<Pick<Query, "filters" | "text" | "sort">>
  /** Your own ui:// view instead of the generated one. */
  view?: ViewSource
  record?: undefined
  dashboard?: undefined
}
export type RecordPageDef<S extends AnyObject> = Omit<PageBase, "title" | "actions" | "badge"> & {
  /** The page of one record of this entity (every entity has a default one, named after it). */
  record: Entity<S>
  title?: Label
  sections?: { title: Label; fields: (keyof z.infer<S> & string)[] }[]
  view?: ViewSource
  list?: undefined
  dashboard?: undefined
}
export type DashboardPageDef<P extends AnyObject> = PageBase & {
  /** Artifacts on a grid. */
  dashboard: DashboardItem[] | ((params: z.infer<P>, ctx: Context) => Awaitable<DashboardItem[]>)
  params?: P
  view?: ViewSource
  list?: undefined
  record?: undefined
}
export type CustomPageDef<P extends AnyObject> = PageBase & { /** A custom page: your own MCP Apps document. */ view: ViewSource; params?: P; list?: undefined; record?: undefined; dashboard?: undefined }

export type Page = { readonly kind: "page"; readonly name: string; readonly definition: ListPageDef<AnyObject, AnyObject> | RecordPageDef<AnyObject> | DashboardPageDef<AnyObject> | CustomPageDef<AnyObject> }

/** A page (spec §6): a list of an entity, one record, a dashboard of artifacts, or a custom view. */
export function definePage<S extends AnyObject, P extends AnyObject = z.ZodObject<{}>>(def: ListPageDef<S, P>): Page
export function definePage<S extends AnyObject>(def: RecordPageDef<S>): Page
export function definePage<P extends AnyObject = z.ZodObject<{}>>(def: DashboardPageDef<P>): Page
export function definePage<P extends AnyObject = z.ZodObject<{}>>(def: CustomPageDef<P>): Page
export function definePage(def: Page["definition"]): Page {
  return Object.freeze({ kind: "page" as const, name: def.name, definition: def })
}

// ------------------------------------------------------------------ agents

export type AgentDef = {
  name: string
  title: Label
  description: Label
  instructions: string
  /** What the agent may use: entities (their reads), actions, or tool names (`search`, `fetch`). */
  uses: (Entity | Action | string)[]
  tier?: "fast" | "standard" | "strong"
  starters?: Label[]
}

export type Agent = { readonly kind: "agent"; readonly name: string; readonly definition: AgentDef }

/** An agent (spec §8): instructions and the tools the host's model runs it with. */
export function defineAgent(def: AgentDef): Agent {
  return Object.freeze({ kind: "agent" as const, name: def.name, definition: def })
}

// ------------------------------------------------------------------ the app

/** A schedule: a global action (readOnly, or a write whose confirm is `never` or `optional`) the workspace host runs as the installation. */
export type ScheduleDef = {
  name: string
  action: Action
  /** Minutes between runs, 5–1440. */
  every: number
  /** How long a run may take, 1–300 seconds (default 60). */
  maxSeconds?: number
}

/** A notification type: people mute it per app. */
export type NotificationDef = {
  label: Label
  description?: Label
  /** false: off until the person turns it on (default true). */
  default?: boolean
  /** Only holders of this permission receive it. */
  permission?: string
}

export type AppDefinition = {
  /** The app id: lowercase letters, digits, `-`; 2–40 characters. */
  name: string
  title: Label
  version: string
  description?: Label
  icons?: Icon[]
  /**
   * The app's tint (spec §2), like an Apple app's: one name of the palette (`APP_ACCENTS`: blue, indigo, purple, pink,
   * red, orange, yellow, green, teal, gray), never a free colour. Default `blue`.
   */
  accent?: AppAccent
  /** Who publishes the app (spec §2): a name and the publisher's web address (https). A claim, granting nothing. */
  publisher?: Publisher
  /** The locale of bare-string labels and of tool names and descriptions (default `en`). */
  locale?: string
  /** MCP `instructions` for models. */
  instructions?: string
  websiteUrl?: string
  /** The app's permissions, by id (`group.verb`): what its sign-in's scopes and its people's roles are made of. */
  permissions?: Record<string, PermissionConfig>
  /** Values an administrator sets per installation, by id. Never a secret. */
  settings?: Record<string, SettingConfig>
  /** Namespaced kinds this app defines (spec §3.1), by name with a dot. */
  kinds?: Record<string, KindConfig>
  /** The notification types the app sends (`ctx.notify({ type })`), by type. Without them its notifications are untyped. */
  notifications?: Record<string, NotificationDef>
  entities: Entity[]
  actions?: Action[]
  components?: Component[]
  artifacts?: Artifact[]
  pages?: Page[]
  /** The navigation: sections of pages, in order (no record pages; each page once). Without it a host shows every non-record page, ungrouped. */
  nav?: { section?: Label; pages: Page[] }[]
  agents?: Agent[]
  /** Actions the workspace host runs as the installation, with nobody at the screen. At most 10. */
  schedules?: ScheduleDef[]
  /** Told by the workspace host of its installation's changes; the tenant's data exported and deleted on request. */
  lifecycle?: LifecycleConfig
}

/** What `defineApp` returns: the app's definition, checked. Nothing in it is served: `serve(app, …)` does that. */
export type App = {
  readonly kind: "app"
  readonly name: string
  readonly locale: string
  readonly definition: AppDefinition
  /** The manifest as defined (spec §2), before it is served: MCP at `/mcp`, no authorization server, no site. */
  manifest(): Manifest
  /** The URI of a record of this app. */
  uri(entity: string | Entity, id: string): string
  /** The URI of an artifact instance. */
  artifactUri(instance: ArtifactInstance): string
  parseUri(uri: string): { type: string; key: string; params: Record<string, unknown> } | null
}

/** How the app runs (`serve`): who may call, where it keeps state, its site. */
export type ServeOptions = {
  /**
   * MCP authorization (spec §7): `signIn` for the app's own sign-in (`@clegra/sdk/signin`), `resolve` for tokens of
   * the app's own authorization server, `public` for calls without a token.
   */
  auth?: AuthOptions
  /** Where write results, one-time tokens and later runs are kept (default: in memory; several instances share one). */
  store?: IdempotencyStore
  /**
   * The names of people of the installation by id: the values of `role: "person"` fields. With it (or the dev
   * sign-in) hosts show names, and a person nobody can name as an unknown person, never the id.
   */
  people?: PeopleResolver
  /** The app's own website (spec §5.1): a workspace client shows the app as that site, in a frame. `start` (default `/`). */
  site?: SiteOptions
  /** The origins of the workspace clients that frame the app's site and views (Clegra's web and desktop clients). */
  clientOrigins?: string[]
  /** Where the app's own routes live on its public address (default none: MCP at `/mcp`). */
  path?: string
  /** Escape hatch: the raw McpServer of each request (official MCP SDK), to add hand-written tools, resources and views. `caller` is null before sign-in. */
  mcp?: (server: McpServer, caller: Caller | null) => void
}

/** What `serve` returns: the app at work, one `fetch(request)` for every route it answers. */
export type ServedApp = Pick<AppServer, "name" | "locale" | "manifest" | "openapi" | "fetch" | "start" | "devMode" | "dev" | "uri" | "artifactUri" | "parseUri" | "createMcpServer" | "site" | "runLater"> & {
  /** The definition it serves. */
  readonly app: App
}

const confirmOf = (c: boolean | Confirm | undefined): Confirm | undefined => (c === true ? "always" : c === false ? "never" : c)

const PLURAL: Record<string, string> = { entity: "entities" }

/** Checks that a handle is one of the app's own (the same object `defineApp` was given), by kind. */
function known<T extends { kind: string; name: string }>(list: readonly T[], what: T | undefined, where: string, kind: string): T {
  if (!what || typeof what !== "object" || what.kind !== kind) throw new Error(`${where}: give a ${kind} (what define${kind[0]!.toUpperCase()}${kind.slice(1)} returned)`)
  if (!list.includes(what)) throw new Error(`${where}: ${kind} "${what.name}" is not one of defineApp's ${PLURAL[kind] ?? `${kind}s`}`)
  return what
}

/** The app's definition as the server registers it, with this runtime. */
function build(def: AppDefinition, runtime: ServeOptions): AppServer {
  const { permissions, settings, kinds, notifications, entities, actions = [], components = [], artifacts = [], pages = [], nav, agents = [], schedules = [], lifecycle, ...meta } = def
  if (!Array.isArray(entities)) throw new Error("defineApp: entities is a list of defineEntity handles")
  const server = new AppServer({ ...meta, ...runtime })
  if (kinds) server.defineKinds(kinds)
  for (const [id, p] of Object.entries(permissions ?? {})) server.registerPermission(id, p)
  for (const [id, s] of Object.entries(settings ?? {})) server.registerSetting(id, s)

  // What actions say about entities and artifacts: the record template's featured actions, «+ Nuovo».
  const featured = new Map<Entity, string[]>()
  const creators = new Map<Entity | Artifact, { action: string; title?: Label }>()
  for (const a of actions) {
    if (!a || a.kind !== "action") throw new Error("defineApp: every action is a defineAction handle")
    const d = a.definition as GlobalActionDef<AnyObject> & { on?: Entity; featured?: boolean }
    if (d.on && d.featured) featured.set(d.on, [...(featured.get(d.on) ?? []), a.name])
    if (d.featured && !d.on) throw new Error(`action "${a.name}": only a record action (on) is featured on a record template`)
    if (d.creates) {
      const of = "of" in d.creates ? d.creates.of : d.creates
      if (creators.has(of)) throw new Error(`action "${a.name}": ${of.kind} "${of.name}" already has a creating action (${creators.get(of)!.action})`)
      creators.set(of, { action: a.name, ...("of" in d.creates ? { title: d.creates.title } : {}) })
    }
  }

  const entityHandles = new Map<Entity, EntityHandle>()
  for (const e of entities) {
    if (!e || e.kind !== "entity") throw new Error("defineApp: every entity is a defineEntity handle")
    const { name, record, ...config } = e.definition
    const shown = featured.get(e) ?? []
    if (shown.length && !record) throw new Error(`entity "${name}": its featured actions (${shown.join(", ")}) are drawn on its record template: give it record: { fields }`)
    const create = creators.get(e)
    entityHandles.set(e, server.registerEntity(name, { ...config, ...(record ? { record: { fields: [...record.fields], ...(shown.length ? { actions: shown } : {}) } } : {}), ...(create ? { create } : {}) }) as unknown as EntityHandle)
  }
  const entityOf = (e: Entity | undefined, where: string) => entityHandles.get(known(entities, e, where, "entity"))!
  for (const [of, c] of creators) known(of.kind === "entity" ? (entities as (Entity | Artifact)[]) : artifacts, of, `action "${c.action}" (creates)`, of.kind)

  const actionHandles = new Map<Action, ActionHandle>()
  for (const a of actions) {
    const { name, on, run, confirm, featured: _f, creates: _c, ...config } = a.definition as RecordActionDef<AnyObject, AnyObject>
    const c = confirmOf(confirm)
    const handler = (input: unknown, ctx: Context, record: unknown) => run(input as never, ctx, record as never)
    actionHandles.set(a, server.registerAction(name, { ...config, ...(c ? { confirm: c } : {}), ...(on ? { entity: entityOf(on, `action "${name}"`) } : {}) } as never, handler as never))
  }
  const actionOf = (a: Action, where: string) => actionHandles.get(known(actions, a, where, "action"))!

  for (const c of components) {
    if (!c || c.kind !== "component") throw new Error("defineApp: every component is a defineComponent handle")
    const { name, actions: list, ...config } = c.definition
    server.registerComponent(name, { ...config, actions: (list ?? []).map((a) => actionOf(a, `component "${name}"`)) })
  }

  for (const f of artifacts) {
    if (!f || f.kind !== "artifact") throw new Error("defineApp: every artifact is a defineArtifact handle")
    const { name, actions: list, widget: _w, component, ...config } = f.definition as Artifact["definition"] & { component?: Component }
    const handles = (list ?? []).map((a) => actionOf(a, `artifact "${name}"`))
    const create = creators.get(f)
    server.registerArtifact(name, { ...config, ...(component ? { component: known(components, component, `artifact "${name}"`, "component").name } : {}), ...(handles.length ? { actions: handles } : {}), ...(create ? { create } : {}) } as never)
  }
  for (const f of artifacts) if (f.definition.widget) server.registerWidget(f.name, f.definition.widget === true ? {} : f.definition.widget)

  const artifactName = (f: Artifact, where: string) => known(artifacts, f, where, "artifact").name
  const itemName = (f: Artifact | Entity, where: string) => (f && f.kind === "entity" ? known(entities, f, where, "entity").name : artifactName(f as Artifact, where))
  const instances = (items: DashboardItem[], where: string): ArtifactInstance[] => items.map((i) => ({ type: itemName(i.artifact, where), params: i.params ?? {}, ...(i.size ? { size: i.size } : {}) }))
  for (const p of pages) {
    if (!p || p.kind !== "page") throw new Error("defineApp: every page is a definePage handle")
    const where = `page "${p.name}"`
    type Loose = Omit<ListPageDef<AnyObject, AnyObject>, "list" | "record" | "dashboard"> & { list?: Entity; record?: Entity; dashboard?: DashboardPageDef<AnyObject>["dashboard"] }
    const { name, actions: list, badge, ...rest } = p.definition as Loose
    const extra = { ...(list?.length ? { actions: list.map((a) => actionOf(a, where)) } : {}), ...(badge ? { badge: artifactName(badge, where) } : {}) }
    let config: PageConfig
    if (rest.list) {
      const { list: entity, ...more } = rest
      config = { kind: "list", entity: entityOf(entity, where), ...more, ...extra } as PageConfig
    } else if (rest.record) {
      const { record: entity, ...more } = rest
      config = { kind: "record", entity: entityOf(entity, where), ...more, ...extra } as PageConfig
    } else if (rest.dashboard) {
      const { dashboard, ...more } = rest
      // Checked now for a fixed grid; a grid made per call is checked when it is made.
      const grid = typeof dashboard === "function" ? async (params: unknown, ctx: Context) => instances(await dashboard(params as never, ctx), where) : instances(dashboard, where)
      config = { kind: "dashboard", artifacts: grid, ...more, ...extra } as PageConfig
    } else if (rest.view) config = { kind: "custom", ...rest, ...extra } as PageConfig
    else throw new Error(`${where}: give one of list, record, dashboard or view (an app's own pages are its site: serve(app, { site }), spec §5.1)`)
    server.registerPage(name, config)
  }
  const pageName = (p: Page, where: string) => known(pages, p, where, "page").name

  for (const g of agents) {
    if (!g || g.kind !== "agent") throw new Error("defineApp: every agent is a defineAgent handle")
    const { name, uses, ...config } = g.definition
    const where = `agent "${name}"`
    server.registerAgent(name, { ...config, tools: uses.map((u) => (typeof u === "string" ? u : u.kind === "entity" ? entityOf(u as Entity, where) : actionOf(u as Action, where))) })
  }
  if (nav) server.registerNav(nav.map((s) => ({ ...(s.section !== undefined ? { section: s.section } : {}), pages: s.pages.map((p) => pageName(p, "nav")) })))
  for (const s of schedules) server.registerSchedule(s.name, { action: actionOf(s.action, `schedule "${s.name}"`), every: s.every, ...(s.maxSeconds !== undefined ? { maxSeconds: s.maxSeconds } : {}) })
  for (const [type, n] of Object.entries(notifications ?? {})) server.registerNotificationType(type, n)
  if (lifecycle) server.registerLifecycle(lifecycle)
  // The manifest is built (and its references checked) now: a wrong name fails at definition, not at the first call.
  server.manifest()
  return server
}

/** The app (spec §1): its entities, actions, pages, artifacts and agents, assembled and checked. Pure: nothing is served. */
export function defineApp(def: AppDefinition): App {
  const checked = build(def, {})
  return Object.freeze({
    kind: "app" as const,
    name: checked.name,
    locale: checked.locale,
    definition: def,
    manifest: () => checked.manifest(),
    uri: (entity: string | Entity, id: string) => checked.uri(typeof entity === "string" ? entity : entity.name, id),
    artifactUri: (instance: ArtifactInstance) => checked.artifactUri(instance),
    parseUri: (uri: string) => checked.parseUri(uri),
  })
}

/**
 * The app at work (spec §7): its definition with how it runs, as one `fetch(request)` on Web APIs (MCP at
 * `<path>/mcp`, the manifest, the OpenAPI index, the sign-in module's routes, views, the site's bridge). Mount it with
 * an adapter: `listen` (`@clegra/sdk/node`), `toNextHandlers` (`@clegra/sdk/next`), `clegraMiddleware`
 * (`@clegra/sdk/express`), or any runtime's own `fetch` handler.
 */
export function serve(app: App, options: ServeOptions = {}): ServedApp {
  if (!app || app.kind !== "app") throw new Error("serve: give the app defineApp returned")
  return Object.assign(build(app.definition, options), { app }) as unknown as ServedApp
}
