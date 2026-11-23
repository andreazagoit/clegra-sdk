import type { z } from "zod"

import type { EntityKind, PropertyDef } from "../spec/src/kinds"
import type { Caller, Person } from "./auth"
import type { Actor } from "./clegra"
import type { Label } from "./labels"
import type { FieldInfo } from "./meaning"

/** What every handler gets: who is calling, for which installation, in which language. */
export type Context = {
  readonly app: string
  /** The tenant (spec §7): the installation bound to its issuer (`<installation>@<issuer>`). Scope every read and write by it. */
  readonly installation: string
  readonly person: Person | null
  readonly permissions: ReadonlySet<string>
  can(permission: string): boolean
  readonly locale: string
  readonly host: Caller["host"]
  /**
   * Who acts for the person (spec §7, «Clegra tokens»): Clegra's agent on a server (`{ kind: "server", id }`, a
   * delegated or automation call) or an agent on the person's device (`{ kind: "device-agent", id }`); null when the
   * person calls themselves.
   */
  readonly actor: Actor | null
  /** Whether the caller administers the app (a Clegra company administrator unless `companyAdmin: "member"`, or granted it): who may assign roles. */
  readonly admin: boolean
  /** The installation's settings (spec §2), as a dev workspace host sent them, defaults filled in. Clegra callers and plain clients get the defaults: an app's settings live in the app. */
  readonly settings: Readonly<Record<string, unknown>>
  /** The call id (`_meta.clegra.call`), when the host sent one. */
  readonly call: string | null
  /** The schedule this call is a run of (`_meta.clegra.schedule`; `clegra_later` for a later run), else null. Such a call has no person. */
  readonly schedule: string | null
  /** In a later run: the run (its id, when it was due, its deadline and when the person confirmed it, epoch seconds but `at`). Else null. */
  readonly later: LaterInfo | null
  /** Cancels a pending later run of this tenant: false when there is none with this id, or it already ran or started. */
  cancelLater(id: string): Promise<boolean>
  /**
   * Counts this call against a limit named `name`: at most `max` every `seconds`, per person (default) or per tenant
   * (`per: "tenant"`). Past it, throws an AppError `rate_limited` (the caller sees it, with `retryAfterSeconds`).
   */
  rateLimit(name: string, limit: { max: number; seconds: number; per?: "person" | "tenant" }): Promise<void>
  /** A label in the caller's language. */
  t(label: Label | undefined): string
  /**
   * A notification for the workspace host to deliver to people of the installation (spec §7). With declared
   * `notifications`, each names one of their types; without, none does. A call without a person says `to`.
   * Throws (a programming error) otherwise.
   */
  notify(notification: Notification): void
  /** The URI of a record of this app. */
  uri(entity: string | EntityHandle, id: string): string
}

/**
 * `to`: person ids, or `"admins"`: the company's administrators (default: the caller's person). Who holds what inside
 * the app is the app's to know: to reach the holders of a permission, the app names them.
 * `type`: one of the app's declared notification types (people mute a type per app).
 */
export type Notification = { type?: string; title: Label; body?: Label; uri?: string; to?: string[] | "admins" }

/** A later run, as its handler sees it (`ctx.later`): `at` as the person gave it, `until` and `confirmedAt` in epoch seconds. */
export type LaterInfo = { id: string; at: string; until: number; confirmedAt: number }

/** Who sees an entity, action or artifact: `"app"` keeps it from every model (only views and the host's own UI use it). */
export type Visibility = "app"

/** What a host offers a global action on: an email, or a record of a kind in any app of the workspace. */
export type TargetName = "mail.message" | `record:${string}`

/** A target of an action (`targets`): what it needs of the object, and its input as a template (`{from.address}`, `{uri}`, `{title}`). */
export type Target<In = Record<string, unknown>> = { target: TargetName; needs: string[]; input?: { [K in keyof In]?: unknown }; label?: Label }

/** «Approve now, act later»: the date-time input `at` says when the confirmed call runs, within `window` minutes (default 60). */
export type LaterConfig<In = Record<string, unknown>> = { at: keyof In & string; window?: number }

/** What an installation went to: the host tells the app (`lifecycle.installation`). */
export type InstallationState = "enabled" | "disabled" | "uninstalled"

/** The tenant's data as one file (`lifecycle.export`): `name` defaults to `<app>-export`. */
export type ExportFile = { name?: string; contentType: string; body: string | Uint8Array }

/**
 * The app's lifecycle, called only by the workspace host as the installation: told of each change of its
 * installation, the tenant's data exported, everything it keeps for the tenant deleted (also after `uninstalled`).
 */
export type LifecycleConfig = {
  installation?: (state: InstallationState, ctx: Context) => Promise<void> | void
  export?: (ctx: Context) => Promise<ExportFile | null> | ExportFile | null
  delete?: (ctx: Context) => Promise<{ counts?: Record<string, number> } | void> | { counts?: Record<string, number> } | void
}

/** A schedule (`schedules`): a global action the workspace host runs as the installation every `every` minutes, within `maxSeconds` (default 60). */
export type ScheduleConfig = { action: ActionHandle; every: number; maxSeconds?: number }

/** A notification type (`notifications`): people mute it per app; `default: false` keeps it off until they turn it on. */
/** Who publishes an app (manifest `publisher`, spec §2): a claim that grants nothing; a store may verify it by the url's domain. */
export type Publisher = { name: string; url: string }
export type NotificationTypeConfig = { label: Label; description?: Label; default?: boolean; permission?: string }

/** A navigation section (`nav`): its label and its pages, in order. */
export type NavSection = { section?: Label; pages: string[] }

export type Value = string | number | boolean
export type Filter = Value | { in: Value[] } | { gte?: Value; lte?: Value }

/** What `list` receives (spec §4), already checked against the fields' meaning and the caller's field permissions. */
export type Query = {
  filters: Record<string, Filter>
  /** Text to search for, only in `textFields`. */
  text?: string
  /** With `text`: the search fields this caller may see. Search in these and no other (a hidden field must not answer). */
  textFields?: string[]
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
  /** What the entity is (spec §3.1): a kind, or `{ by, map }` for one kind per record. */
  kind?: EntityKind
  schema: S
  /** Who may see records of this entity at all. */
  permission?: string
  get: (id: string, ctx: Context) => Promise<z.infer<S> | null> | z.infer<S> | null
  list: (query: Query, ctx: Context) => Promise<ListResult<z.infer<S>>> | ListResult<z.infer<S>>
  /** Plain MCP clients: listed (default true) and the tool names (default `<entity>_list`, `<entity>_get`). */
  expose?: { plain?: boolean; list?: string; get?: string }
  /** Your own ui:// view for a record, instead of the generated one. */
  view?: ViewSource
  visibility?: Visibility
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
  visibility?: Visibility
  targets?: Target<z.infer<I>>[]
  later?: LaterConfig<z.infer<I>>
}

export type ActionHandler<I extends z.ZodObject, E extends EntityHandle | undefined> = (
  input: z.infer<I>,
  ctx: Context,
  record: E extends EntityHandle<infer S> ? z.infer<S> : undefined,
) => Promise<ActionResult | void> | ActionResult | void

export type ActionHandle = { readonly kind: "action"; readonly name: string; readonly tool: string }

export type Exposure = { plain?: boolean; tool?: string }

export type ArtifactInstance = { type: string; params: Record<string, unknown>; size?: "small" | "medium" | "large" }

type PageBase<P extends z.ZodObject> = {
  title: Label
  icon?: string
  permission?: string
  description?: Label
  params?: P
  expose?: Exposure
  /** Global actions offered on the page; the first is its primary. Page params prefill inputs of the same name. */
  actions?: ActionHandle[]
  /** A `stat` artifact type without required params: its value is the page's count in the navigation. */
  badge?: string
}

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
  | (Omit<PageBase<P>, "params" | "title" | "actions" | "badge"> & { kind: "record"; entity: EntityHandle; title?: Label; sections?: { title: Label; fields: string[] }[]; view?: ViewSource })
  | (PageBase<P> & { kind: "dashboard"; artifacts: ArtifactInstance[] | ((params: z.infer<P>, ctx: Context) => ArtifactInstance[] | Promise<ArtifactInstance[]>); view?: ViewSource })
  | (PageBase<P> & { kind: "custom"; view: ViewSource })

/** An MCP Apps view's document, with the origins it may reach (MCP Apps CSP). */
export type ViewSource = { html: string | (() => string | Promise<string>); csp?: { connectDomains?: string[]; resourceDomains?: string[]; frameDomains?: string[] }; prefersBorder?: boolean }

export type Template = "card" | "stat" | "list" | "chart"

export type TemplateData = {
  card: { title: string; subtitle?: string; status?: string; fields: { label: string; value: string | number }[]; uri?: string }
  stat: { label: string; value: number | string; format?: "number" | "money" | "percent"; currency?: string; hint?: string }
  list: { items: { title: string; subtitle?: string; status?: string; uri?: string }[] }
  chart: { kind: "bar" | "line" | "pie"; points: { label: string; value: number }[]; format?: "number" | "money"; currency?: string }
}

export type ArtifactConfig<P extends z.ZodObject, T extends Template> = {
  title: Label
  description: Label
  icon?: string
  params: P
  permission?: string
  /** Actions shown inside (global actions). */
  actions?: ActionHandle[]
  size?: "small" | "medium" | "large"
  expose?: Exposure
  /** Its texts are written by outsiders (records' names, notes): data for a model, never instructions. */
  untrusted?: boolean
  visibility?: Visibility
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

/** A namespaced kind an app defines (spec §3.1): `com.example.shipment`. */
export type KindConfig = { label: Label; properties: Record<string, PropertyDef> }

export type PermissionConfig = { label: Label; description?: Label; default?: boolean }

/** A value an administrator sets per installation; the workspace host sends it with every call. Never a secret (those stay in the app's own configuration). */
export type SettingConfig = {
  label: Label
  description?: Label
  type: "text" | "number" | "boolean"
  required?: boolean
  default?: string | number | boolean
}
