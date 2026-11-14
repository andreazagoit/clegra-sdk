import type { z } from "zod"

import type { Caller, Person } from "./auth"
import type { Label } from "./labels"
import type { FieldInfo } from "./meaning"

/** What every handler gets: who is calling, for which installation, in which language. */
export type Context = {
  readonly app: string
  /** The tenant (spec §9): scope every read and write by it. */
  readonly installation: string
  readonly person: Person | null
  readonly permissions: ReadonlySet<string>
  can(permission: string): boolean
  readonly locale: string
  readonly host: Caller["host"]
  /** The installation's settings (spec §8), defaults filled in. */
  readonly settings: Readonly<Record<string, unknown>>
  /** The call id (`_meta.modelapp.call`), when the host sent one. */
  readonly call: string | null
  /** A label in the caller's language. */
  t(label: Label | undefined): string
  /** A notification for the host to deliver (spec §8). */
  notify(notification: Notification): void
  /** The URI of a record of this app. */
  uri(entity: string | EntityHandle, id: string): string
}

export type Notification = { title: Label; body?: Label; uri?: string; to?: string[] }

export type Value = string | number | boolean
export type Filter = Value | { in: Value[] } | { gte?: Value; lte?: Value }

/** What `list` receives (spec §4), already checked against the fields' meaning and the caller's field permissions. */
export type Query = {
  filters: Record<string, Filter>
  text?: string
  sort?: { field: string; dir: "asc" | "desc" }
  cursor?: string
  limit: number
}

export type ListResult<Row> = { rows: Row[]; next?: string; total?: number }

export type EntityConfig<S extends z.ZodObject> = {
  label: Label
  plural?: Label
  description?: Label
  /** A lucide icon name. */
  icon?: string
  schema: S
  /** Who may see records of this entity at all. */
  permission?: string
  get: (id: string, ctx: Context) => Promise<z.infer<S> | null> | z.infer<S> | null
  list: (query: Query, ctx: Context) => Promise<ListResult<z.infer<S>>> | ListResult<z.infer<S>>
  /** Plain MCP clients: listed (default true) and the tool names (default `<entity>_list`, `<entity>_get`). */
  expose?: { plain?: boolean; list?: string; get?: string }
  /** Your own ui:// view for a record, instead of the generated one. */
  view?: ViewSource
}

/** An entity, as the SDK knows it once defined. */
export type EntityHandle<S extends z.ZodObject = z.ZodObject> = {
  readonly kind: "entity"
  readonly name: string
  readonly schema: S
  readonly fields: readonly FieldInfo[]
  uri(id: string): string
}

export type Confirm = "always" | "optional" | "never"

export type ActionResult = { message?: string; record?: string; data?: Record<string, unknown> }

export type ActionConfig<I extends z.ZodObject, E extends EntityHandle | undefined> = {
  entity?: E
  title: Label
  description?: Label
  icon?: string
  input?: I
  /** A read: changes nothing (its confirm is `never`). */
  readOnly?: boolean
  /** Default `always` for writes. */
  confirm?: Confirm
  permission?: string
  /** Plain MCP clients: reads are listed by default, writes only with `plain: true`; `tool` renames the tool. */
  expose?: { plain?: boolean; tool?: string }
}

export type ActionHandler<I extends z.ZodObject, E extends EntityHandle | undefined> = (
  input: z.infer<I>,
  ctx: Context,
  record: E extends EntityHandle<infer S> ? z.infer<S> : undefined,
) => Promise<ActionResult | void> | ActionResult | void

export type ActionHandle = { readonly kind: "action"; readonly name: string; readonly tool: string }

export type Exposure = { plain?: boolean; tool?: string }

export type FragmentInstance = { type: string; params: Record<string, unknown>; size?: "small" | "medium" | "large" }

type PageBase<P extends z.ZodObject> = { title: Label; icon?: string; permission?: string; description?: Label; params?: P; expose?: Exposure }

export type PageConfig<P extends z.ZodObject = z.ZodObject> =
  | (PageBase<P> & {
      kind: "list"
      entity: EntityHandle
      columns: string[]
      /** From the page's params to the list query (default: params are the filter fields and `text`). */
      query?: (params: z.infer<P>) => Partial<Pick<Query, "filters" | "text" | "sort">>
      /** Your own ui:// view instead of the generated one (hosts may still draw the list natively). */
      view?: ViewSource
    })
  | (Omit<PageBase<P>, "params" | "title"> & { kind: "record"; entity: EntityHandle; title?: Label; sections?: { title: Label; fields: string[] }[]; view?: ViewSource })
  | (PageBase<P> & { kind: "dashboard"; fragments: FragmentInstance[] | ((params: z.infer<P>, ctx: Context) => FragmentInstance[] | Promise<FragmentInstance[]>); view?: ViewSource })
  | (PageBase<P> & { kind: "custom"; view: ViewSource })
  | (PageBase<P> & { kind: "custom"; url: string })

/** An MCP Apps view's document, with the origins it may reach (MCP Apps CSP). */
export type ViewSource = { html: string | (() => string | Promise<string>); csp?: { connectDomains?: string[]; resourceDomains?: string[]; frameDomains?: string[] }; prefersBorder?: boolean }

export type Template = "card" | "stat" | "list" | "chart"

export type TemplateData = {
  card: { title: string; subtitle?: string; status?: string; fields: { label: string; value: string | number }[]; uri?: string }
  stat: { label: string; value: number | string; format?: "number" | "money" | "percent"; currency?: string; hint?: string }
  list: { items: { title: string; subtitle?: string; status?: string; uri?: string }[] }
  chart: { kind: "bar" | "line" | "pie"; points: { label: string; value: number }[]; format?: "number" | "money"; currency?: string }
}

export type FragmentConfig<P extends z.ZodObject, T extends Template> = {
  title: Label
  description: Label
  icon?: string
  params: P
  permission?: string
  /** Actions shown inside (global actions). */
  actions?: ActionHandle[]
  size?: "small" | "medium" | "large"
  expose?: Exposure
} & (
  | { template: T; data: (params: z.infer<P>, ctx: Context) => Promise<TemplateData[T] | null> | TemplateData[T] | null; view?: ViewSource }
  | { view: ViewSource; data: (params: z.infer<P>, ctx: Context) => Promise<Record<string, unknown> | null> | Record<string, unknown> | null; template?: never }
)

export type AgentConfig = {
  title: Label
  description: Label
  instructions: string
  tools: (EntityHandle | ActionHandle | string)[]
  tier?: "fast" | "standard" | "strong"
  starters?: Label[]
}

export type PermissionConfig = { label: Label; description?: Label; default?: boolean }

export type SettingConfig = {
  label: Label
  description?: Label
  type: "text" | "secret" | "number" | "boolean" | "choice"
  required?: boolean
  default?: string | number | boolean
  options?: { value: string; label: Label }[]
}
