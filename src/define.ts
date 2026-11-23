import type { Icon, McpServer } from "@modelcontextprotocol/server"
import type { z } from "zod"

import type { EntityKind } from "../spec/src/kinds"
import type { AppAccent } from "../spec/src/protocol"
import type { AuthOptions, Caller } from "./auth"
import type { SiteOptions } from "./site"
import type { Label } from "./labels"
import { AppServer, type PeopleResolver } from "./server"
import type { IdempotencyStore } from "./store"
import type { ActionHandle, ActionResult, Confirm, Context, EntityHandle, Exposure, ArtifactInstance, KindConfig, LaterConfig, LifecycleConfig, ListResult, PageConfig, PermissionConfig, Publisher, Query, SettingConfig, Target, TemplateData, ViewSource, Visibility } from "./types"

/**
 * defineApp: THE authoring API (spec §1). One typed object holds the whole
 * app — what it is (the manifest part: plain data) and what it does (the
 * handlers: get, list, run, data). The SDK splits the two, serves the
 * manifest, and generates a plain, conformant MCP server from it.
 */

type Schemas = Record<string, z.ZodObject>
type Awaitable<T> = T | Promise<T>

export type EntityDef<S extends z.ZodObject, P extends string = string> = {
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
  /** Who may see records of this entity at all. */
  permission?: P
  get: (id: string, ctx: Context) => Awaitable<z.infer<S> | null>
  /** `query.text` is searched only in `query.textFields` (the search fields the caller may see). */
  list: (query: Query, ctx: Context) => Awaitable<ListResult<z.infer<S>>>
  /** Plain MCP clients: `plain: false` hides the entity's tools; `list` / `get` rename them (default `<entity>_list`, `<entity>_get`). */
  expose?: { plain?: boolean; list?: string; get?: string }
  /** Your own ui:// view for one record, instead of the generated one. */
  view?: ViewSource
  /** `"app"`: its tools are for views and the host's own UI only, never for a model (search and fetch leave its records out). */
  visibility?: Visibility
}

type ActionBase<I extends z.ZodObject, P extends string> = {
  title: Label
  description?: Label
  icon?: string
  /** The input, a Zod object (`z.object({})` for none). On a record action the SDK adds `id`. */
  input: I
  /** A read: changes nothing. */
  readOnly?: boolean
  /** Writes ask the person first by default (`true` / "always"); "optional" lets the host decide; `false` / "never" never asks. */
  confirm?: boolean | Confirm
  permission?: P
  /** Plain MCP clients: reads are listed by default, writes only with `plain: true`; `tool` renames the tool (default `<entity>_<action>` or `<action>`). */
  expose?: Exposure
  /** `"app"`: for views and the host's own UI only, never for a model. */
  visibility?: Visibility
  /**
   * «Approve now, act later», on a write the person confirms: `at` names a required date-time input; the confirmed
   * call is kept (the store's `later` part) and runs at that time, at most `window` minutes late (10–10080, default 60).
   */
  later?: LaterConfig<z.infer<I>>
}

export type ActionDef<I extends z.ZodObject, E extends Schemas, P extends string = string> =
  | (ActionBase<I, P> & {
      on?: undefined
      /** Where a host offers the action on something else: an email (`mail.message`) or a record of a kind (`record:organization`), with its input filled from it. At most 4. */
      targets?: Target<z.infer<I>>[]
      run: (input: z.infer<I>, ctx: Context) => Awaitable<ActionResult | void>
    })
  | { [N in keyof E]: ActionBase<I, P> & { /** The entity whose record the action works on. */ on: N; targets?: never; run: (input: z.infer<I>, ctx: Context, record: z.infer<E[N]>) => Awaitable<ActionResult | void> } }[keyof E]

type ArtifactBase<Pm extends z.ZodObject, P extends string, A extends string> = {
  title: Label
  description: Label
  icon?: string
  /** The parameters, a Zod object (`z.object({})` for none). */
  params: Pm
  permission?: P
  /** Actions shown inside, by name (actions without `on`). */
  actions?: A[]
  size?: "small" | "medium" | "large"
  /** Plain MCP clients: `plain: false` hides its tool; `tool` renames it (default `show_<artifact>`). */
  expose?: Exposure
  /** Its texts are written by outsiders (records' names, notes): marked as data for models. */
  untrusted?: boolean
  /** `"app"`: its tool is for views and the host's own UI only, never for a model. */
  visibility?: Visibility
}

export type ArtifactDef<Pm extends z.ZodObject, P extends string = string, A extends string = string> =
  | { [T in keyof TemplateData]: ArtifactBase<Pm, P, A> & { /** Drawn by the host (and by the generated view). */ template: T; data: (params: z.infer<Pm>, ctx: Context) => Awaitable<TemplateData[T] | null>; /** Your own ui:// view instead of the generated one. */ view?: ViewSource } }[keyof TemplateData]
  | (ArtifactBase<Pm, P, A> & { template?: undefined; component?: undefined; /** Your own ui:// view (an MCP Apps document). */ view: ViewSource; data: (params: z.infer<Pm>, ctx: Context) => Awaitable<Record<string, unknown> | null> })
  | (ArtifactBase<Pm, P, A> & { template?: undefined; view?: undefined; /** One of the app's own components (`components`): its data are the component's props. */ component: string; data: (params: z.infer<Pm>, ctx: Context) => Awaitable<Record<string, unknown> | null> })

/** One of the app's own A2UI components (spec §5.4 rule 6): a page of the app drawing the props a host gives it, inside any A2UI surface. */
export type ComponentDef<A extends string = string> = {
  title: Label
  description?: Label
  /** The data it draws (a Zod object): an artifact with `component` returns them. */
  props: z.ZodObject
  /** Its page: an MCP Apps document (HTML that speaks MCP Apps with the host), served at `ui://<app>/components/<Name>`. */
  view: ViewSource
  /** The app's actions the page may call through the host (a write still waits for the person's confirmation). */
  actions?: A[]
}

type PageBase<P extends string, A extends string, F extends string> = {
  title: Label
  icon?: string
  description?: Label
  permission?: P
  /** Plain MCP clients: `plain: false` hides its tool; `tool` renames it (default `open_<page>`). */
  expose?: Exposure
  /** Global actions (without `on`) offered on the page, at most 8; the first is its primary. Page params prefill inputs of the same name. */
  actions?: A[]
  /** A `stat` artifact type without required params: its value is the page's count in the navigation. */
  badge?: F
}

/** A page is one of: `list`, `record`, `dashboard`, or a custom `view`. */
export type PageDef<E extends Schemas, P extends string = string, A extends string = string, F extends string = string> =
  | (PageBase<P, A, F> & {
      /** A list of this entity's records. */
      list: keyof E & string
      columns: string[]
      /** Parameters of the page (default: the entity's filter fields). With `params`, give `query`. */
      params?: z.ZodObject
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- annotate it with z.infer of your params
      query?: (params: any) => Partial<Pick<Query, "filters" | "text" | "sort">>
      /** Your own ui:// view instead of the generated one. */
      view?: ViewSource
    })
  | (Omit<PageBase<P, A, F>, "title" | "actions" | "badge"> & { /** The page of one record of this entity (every entity has a default one). */ record: keyof E & string; title?: Label; sections?: { title: Label; fields: string[] }[]; view?: ViewSource; actions?: never; badge?: never })
  | (PageBase<P, A, F> & {
      /** Artifacts on a grid. */
      dashboard: ArtifactInstance[] | ((params: any, ctx: Context) => Awaitable<ArtifactInstance[]>) // eslint-disable-line @typescript-eslint/no-explicit-any
      params?: z.ZodObject
      view?: ViewSource
    })
  | (PageBase<P, A, F> & { /** A custom page: your own MCP Apps document. */ view: ViewSource; params?: z.ZodObject })

export type AgentDef = {
  title: Label
  description: Label
  instructions: string
  /** What the agent may use: entity names (their reads), action names, or tool names. */
  uses: string[]
  tier?: "fast" | "standard" | "strong"
  starters?: Label[]
}

/** A schedule: a global action (readOnly, or a write whose confirm is `never` or `optional`) the workspace host runs as the installation. */
export type ScheduleDef<A extends string = string> = {
  action: A
  /** Minutes between runs, 5–1440. */
  every: number
  /** How long a run may take, 1–300 seconds (default 60). */
  maxSeconds?: number
}

/** A notification type: people mute it per app. */
export type NotificationDef<P extends string = string> = {
  label: Label
  description?: Label
  /** false: off until the person turns it on (default true). */
  default?: boolean
  /** Only holders of this permission receive it. */
  permission?: P
}

export type AppDefinition<E extends Schemas, A extends Schemas, F extends Schemas, P extends string, G extends string = string> = {
  /** The app id: lowercase letters, digits, `-`; 2–40 characters. */
  name: string
  title: Label
  version: string
  description?: Label
  icons?: Icon[]
  /**
   * The app's tint (spec §2), like an Apple app's: one name of the palette (`APP_ACCENTS`: blue, indigo, purple, pink,
   * red, orange, yellow, green, teal, gray), never a free colour. Clegra draws the app's primary buttons, selected
   * rows and filters, links, switches and focus ring in it. Default `blue`.
   */
  accent?: AppAccent
  /**
   * Who publishes the app (spec §2): a name and the publisher's web address (https). A claim, granting nothing: a
   * store or host may verify it against the address's domain and show it as verified.
   */
  publisher?: Publisher
  /** The locale of bare-string labels and of tool names and descriptions (default `en`). */
  locale?: string
  /** MCP `instructions` for models. */
  instructions?: string
  websiteUrl?: string
  /**
   * MCP authorization (spec §7): `resolve` for the app's own tokens (its users, from its auth library), `issuers`
   * for workspace hosts, with this server's public MCP address (`resource`); or `dev` locally.
   */
  auth?: AuthOptions
  /** Where the app's own routes live on its public address (default none: MCP at `/mcp`). */
  path?: string
  permissions?: Record<P, PermissionConfig>
  settings?: Record<string, SettingConfig>
  /** Namespaced kinds this app defines (spec §3.1), by name with a dot: `{ "com.example.shipment": { label, properties: { trackingNumber: { type: "string", key: true } } } }`. */
  kinds?: Record<string, KindConfig>
  entities: { [K in keyof E]: EntityDef<E[K], NoInfer<P>> }
  actions?: { [K in keyof A]: ActionDef<A[K], E, NoInfer<P>> }
  /** The app's own A2UI components, by name (`[A-Z][A-Za-z0-9]*`, spec §5.4 rule 6). */
  components?: Record<string, ComponentDef<NoInfer<keyof A & string>>>
  artifacts?: { [K in keyof F]: ArtifactDef<F[K], NoInfer<P>, keyof A & string> }
  pages?: Record<G, PageDef<E, NoInfer<P>, NoInfer<keyof A & string>, NoInfer<keyof F & string>>>
  /** The navigation: sections of pages, in order (no record pages; each page once). Without it a host shows every non-record page, ungrouped. */
  nav?: { section?: Label; pages: NoInfer<G>[] }[]
  agents?: Record<string, AgentDef>
  /** Actions the workspace host runs as the installation, with nobody at the screen: `{ digest: { action: "send_digest", every: 60 } }`. At most 10. */
  schedules?: Record<string, ScheduleDef<NoInfer<keyof A & string>>>
  /** The notification types the app sends (`ctx.notify({ type })`). Without them its notifications are untyped. */
  notifications?: Record<string, NotificationDef<NoInfer<P>>>
  /** Told by the workspace host of its installation's changes; the tenant's data exported and deleted on request. */
  lifecycle?: LifecycleConfig
  /** Escape hatch: the raw McpServer of each request (official MCP SDK), to add hand-written tools, resources and views. `caller` is null before sign-in. */
  mcp?: (server: McpServer, caller: Caller | null) => void
  /** Where write results are kept for idempotency (default: in memory). */
  store?: IdempotencyStore
  /**
   * The names of people of the installation by id: the values of `role: "person"` fields. With it (or the dev
   * sign-in) hosts show names, and a person nobody can name as an unknown person, never the id. Without it a
   * person field holds the name itself.
   */
  people?: PeopleResolver
  /**
   * The app's own website (spec §5.1): Clegra's clients show the app as that site, the person signed in with a
   * one-minute ticket. `start` (default `/`), the signing secret (default `CLEGRA_SITE_SECRET`), `sessionSeconds`.
   * Needs `auth.clegra`. The site's pages read the caller with `getClegraCaller` (`@clegra/sdk/next`).
   */
  site?: SiteOptions
}

/** What defineApp returns: the app, ready to serve. */
export type App = Pick<AppServer, "name" | "locale" | "manifest" | "fetch" | "start" | "devMode" | "uri" | "artifactUri" | "parseUri" | "createMcpServer" | "devToken" | "devConfirmation" | "site" | "runLater" | "roles">

const confirmOf = (c: boolean | Confirm | undefined): Confirm | undefined => (c === true ? "always" : c === false ? "never" : c)

export function defineApp<E extends Schemas, A extends Schemas = Schemas, F extends Schemas = Schemas, P extends string = string, G extends string = string>(def: AppDefinition<E, A, F, P, G>): App {
  const { permissions, settings, kinds, entities, actions, components, artifacts, pages, agents, nav, schedules, notifications, lifecycle, ...options } = def
  const app = new AppServer(options)
  if (kinds) app.defineKinds(kinds)
  for (const [id, p] of Object.entries(permissions ?? {})) app.registerPermission(id, p as PermissionConfig)
  for (const [id, s] of Object.entries(settings ?? {})) app.registerSetting(id, s)

  const entityHandles = new Map<string, EntityHandle>()
  for (const [name, e] of Object.entries(entities) as [string, EntityDef<z.ZodObject>][]) entityHandles.set(name, app.registerEntity(name, e) as unknown as EntityHandle)
  const entity = (name: string, where: string) => {
    const h = entityHandles.get(name)
    if (!h) throw new Error(`${where}: "${name}" is not an entity of this app`)
    return h
  }

  const actionHandles = new Map<string, ActionHandle>()
  type AnyAction = ActionBase<z.ZodObject, string> & { on?: string; run: (input: unknown, ctx: Context, record?: unknown) => Awaitable<ActionResult | void> }
  for (const [name, a] of Object.entries(actions ?? {}) as [string, AnyAction][]) {
    const { on, run, confirm, ...config } = a
    const c = confirmOf(confirm)
    actionHandles.set(name, app.registerAction(name, { ...config, ...(c ? { confirm: c } : {}), ...(on ? { entity: entity(on, `action "${name}"`) } : {}) }, (input, ctx, record) => run(input, ctx, record)))
  }

  for (const [name, c] of Object.entries(components ?? {})) {
    const { actions: names, ...config } = c
    app.registerComponent(name, {
      ...config,
      actions: (names ?? []).map((n) => {
        const h = actionHandles.get(n)
        if (!h) throw new Error(`component "${name}": "${n}" is not an action of this app`)
        return h
      }),
    })
  }

  type AnyArtifact = ArtifactBase<z.ZodObject, string, string> & { template?: keyof TemplateData; component?: string; view?: ViewSource; data: (params: unknown, ctx: Context) => Awaitable<Record<string, unknown> | null> }
  for (const [type, f] of Object.entries(artifacts ?? {}) as [string, AnyArtifact][]) {
    const { actions: names, ...config } = f
    const handles = (names ?? []).map((n) => {
      const h = actionHandles.get(n)
      if (!h) throw new Error(`artifact "${type}": "${n}" is not an action of this app`)
      return h
    })
    app.registerArtifact(type, { ...config, ...(handles.length ? { actions: handles } : {}) } as never)
  }

  const actionOf = (n: string, where: string) => {
    const h = actionHandles.get(n)
    if (!h) throw new Error(`${where}: "${n}" is not an action of this app`)
    return h
  }
  for (const [name, def] of Object.entries(pages ?? {}) as [string, PageDef<Schemas>][]) {
    const where = `page "${name}"`
    const { actions: names, ...p } = def as PageDef<Schemas> & { actions?: string[] }
    if (names?.length) Object.assign(p, { actions: names.map((n) => actionOf(n, where)) })
    let config: PageConfig
    if ("list" in p) {
      const { list, ...rest } = p
      config = { kind: "list", entity: entity(list, where), ...rest } as PageConfig
    } else if ("record" in p) {
      const { record, ...rest } = p
      config = { kind: "record", entity: entity(record, where), ...rest } as PageConfig
    } else if ("dashboard" in p) {
      const { dashboard, ...rest } = p
      config = { kind: "dashboard", artifacts: dashboard, ...rest } as PageConfig
    } else if ("view" in p) config = { kind: "custom", ...p } as PageConfig
    else throw new Error(`${where}: give one of list, record, dashboard or view (an app's own pages are its site: defineApp({ site }), spec §5.1)`)
    app.registerPage(name, config)
  }

  for (const [name, a] of Object.entries(agents ?? {})) {
    const { uses, ...config } = a
    app.registerAgent(name, { ...config, tools: uses })
  }
  if (nav) app.registerNav(nav)
  for (const [name, s] of Object.entries(schedules ?? {}) as [string, ScheduleDef][]) app.registerSchedule(name, { ...s, action: actionOf(s.action, `schedule "${name}"`) })
  for (const [type, n] of Object.entries(notifications ?? {}) as [string, NotificationDef][]) app.registerNotificationType(type, n)
  if (lifecycle) app.registerLifecycle(lifecycle)
  // The manifest is built (and its references checked) at definition time: a wrong name fails at start, not at the first call.
  app.manifest()
  return app
}
