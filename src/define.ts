import type { Icon, McpServer } from "@modelcontextprotocol/server"
import type { z } from "zod"

import type { AuthOptions, Caller } from "./auth"
import type { Label } from "./labels"
import { AppServer } from "./server"
import type { IdempotencyStore } from "./store"
import type { ActionHandle, ActionResult, Confirm, Context, EntityHandle, Exposure, FragmentInstance, ListResult, PageConfig, PermissionConfig, Query, SettingConfig, TemplateData, ViewSource } from "./types"

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
  /** A Zod object; fields carry their meaning with `.meta({ role, label, filter, … })`. Needs a string `id` and one `role: "title"`. */
  schema: S
  /** Who may see records of this entity at all. */
  permission?: P
  get: (id: string, ctx: Context) => Awaitable<z.infer<S> | null>
  list: (query: Query, ctx: Context) => Awaitable<ListResult<z.infer<S>>>
  /** Plain MCP clients: `plain: false` hides the entity's tools; `list` / `get` rename them (default `<entity>_list`, `<entity>_get`). */
  expose?: { plain?: boolean; list?: string; get?: string }
  /** Your own ui:// view for one record, instead of the generated one. */
  view?: ViewSource
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
}

export type ActionDef<I extends z.ZodObject, E extends Schemas, P extends string = string> =
  | (ActionBase<I, P> & { on?: undefined; run: (input: z.infer<I>, ctx: Context) => Awaitable<ActionResult | void> })
  | { [N in keyof E]: ActionBase<I, P> & { /** The entity whose record the action works on. */ on: N; run: (input: z.infer<I>, ctx: Context, record: z.infer<E[N]>) => Awaitable<ActionResult | void> } }[keyof E]

type FragmentBase<Pm extends z.ZodObject, P extends string, A extends string> = {
  title: Label
  description: Label
  icon?: string
  /** The parameters, a Zod object (`z.object({})` for none). */
  params: Pm
  permission?: P
  /** Actions shown inside, by name (actions without `on`). */
  actions?: A[]
  size?: "small" | "medium" | "large"
  /** Plain MCP clients: `plain: false` hides its tool; `tool` renames it (default `show_<fragment>`). */
  expose?: Exposure
}

export type FragmentDef<Pm extends z.ZodObject, P extends string = string, A extends string = string> =
  | { [T in keyof TemplateData]: FragmentBase<Pm, P, A> & { /** Drawn by the host (and by the generated view). */ template: T; data: (params: z.infer<Pm>, ctx: Context) => Awaitable<TemplateData[T] | null>; /** Your own ui:// view instead of the generated one. */ view?: ViewSource } }[keyof TemplateData]
  | (FragmentBase<Pm, P, A> & { template?: undefined; /** Your own ui:// view (an MCP Apps document). */ view: ViewSource; data: (params: z.infer<Pm>, ctx: Context) => Awaitable<Record<string, unknown> | null> })

type PageBase<P extends string> = {
  title: Label
  icon?: string
  description?: Label
  permission?: P
  /** Plain MCP clients: `plain: false` hides its tool; `tool` renames it (default `open_<page>`). */
  expose?: Exposure
}

/** A page is one of: `list`, `record`, `dashboard`, a custom `view`, or a custom `url`. */
export type PageDef<E extends Schemas, P extends string = string> =
  | (PageBase<P> & {
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
  | (Omit<PageBase<P>, "title"> & { /** The page of one record of this entity (every entity has a default one). */ record: keyof E & string; title?: Label; sections?: { title: Label; fields: string[] }[]; view?: ViewSource })
  | (PageBase<P> & {
      /** Fragments on a grid. */
      dashboard: FragmentInstance[] | ((params: any, ctx: Context) => Awaitable<FragmentInstance[]>) // eslint-disable-line @typescript-eslint/no-explicit-any
      params?: z.ZodObject
      view?: ViewSource
    })
  | (PageBase<P> & { /** A custom page: your own MCP Apps document. */ view: ViewSource; params?: z.ZodObject })
  | (PageBase<P> & { /** A custom page: your own site, in an isolated frame. */ url: string; params?: z.ZodObject })

export type AgentDef = {
  title: Label
  description: Label
  instructions: string
  /** What the agent may use: entity names (their reads), action names, or tool names. */
  uses: string[]
  tier?: "fast" | "standard" | "strong"
  starters?: Label[]
}

export type AppDefinition<E extends Schemas, A extends Schemas, F extends Schemas, P extends string> = {
  /** The app id: lowercase letters, digits, `-`; 2–40 characters. */
  name: string
  title: Label
  version: string
  description?: Label
  icons?: Icon[]
  /** The locale of bare-string labels and of tool names and descriptions (default `en`). */
  locale?: string
  /** MCP `instructions` for models. */
  instructions?: string
  websiteUrl?: string
  /** MCP authorization: trusted token issuers, or `dev: true` locally. */
  auth?: AuthOptions
  permissions?: Record<P, PermissionConfig>
  settings?: Record<string, SettingConfig>
  entities: { [K in keyof E]: EntityDef<E[K], NoInfer<P>> }
  actions?: { [K in keyof A]: ActionDef<A[K], E, NoInfer<P>> }
  fragments?: { [K in keyof F]: FragmentDef<F[K], NoInfer<P>, keyof A & string> }
  pages?: Record<string, PageDef<E, NoInfer<P>>>
  agents?: Record<string, AgentDef>
  /** Escape hatch: the raw McpServer of each request (official MCP SDK), to add hand-written tools, resources and views. `caller` is null before sign-in. */
  mcp?: (server: McpServer, caller: Caller | null) => void
  /** Where write results are kept for idempotency (default: in memory). */
  store?: IdempotencyStore
}

/** What defineApp returns: the app, ready to serve. */
export type App = Pick<AppServer, "name" | "locale" | "manifest" | "fetch" | "listen" | "uri" | "fragmentUri" | "parseUri" | "createMcpServer" | "devToken" | "devConfirmation">

const confirmOf = (c: boolean | Confirm | undefined): Confirm | undefined => (c === true ? "always" : c === false ? "never" : c)

export function defineApp<E extends Schemas, A extends Schemas = Schemas, F extends Schemas = Schemas, P extends string = string>(def: AppDefinition<E, A, F, P>): App {
  const { permissions, settings, entities, actions, fragments, pages, agents, ...options } = def
  const app = new AppServer(options)
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

  type AnyFragment = FragmentBase<z.ZodObject, string, string> & { template?: keyof TemplateData; view?: ViewSource; data: (params: unknown, ctx: Context) => Awaitable<Record<string, unknown> | null> }
  for (const [type, f] of Object.entries(fragments ?? {}) as [string, AnyFragment][]) {
    const { actions: names, ...config } = f
    const handles = (names ?? []).map((n) => {
      const h = actionHandles.get(n)
      if (!h) throw new Error(`fragment "${type}": "${n}" is not an action of this app`)
      return h
    })
    app.registerFragment(type, { ...config, ...(handles.length ? { actions: handles } : {}) } as never)
  }

  for (const [name, p] of Object.entries(pages ?? {}) as [string, PageDef<Schemas>][]) {
    const where = `page "${name}"`
    let config: PageConfig
    if ("list" in p) {
      const { list, ...rest } = p
      config = { kind: "list", entity: entity(list, where), ...rest } as PageConfig
    } else if ("record" in p) {
      const { record, ...rest } = p
      config = { kind: "record", entity: entity(record, where), ...rest } as PageConfig
    } else if ("dashboard" in p) {
      const { dashboard, ...rest } = p
      config = { kind: "dashboard", fragments: dashboard, ...rest } as PageConfig
    } else if ("url" in p || "view" in p) config = { kind: "custom", ...p } as PageConfig
    else throw new Error(`${where}: give one of list, record, dashboard, view or url`)
    app.registerPage(name, config)
  }

  for (const [name, a] of Object.entries(agents ?? {})) {
    const { uses, ...config } = a
    app.registerAgent(name, { ...config, tools: uses })
  }
  // The manifest is built (and its references checked) at definition time: a wrong name fails at start, not at the first call.
  app.manifest()
  return app
}
