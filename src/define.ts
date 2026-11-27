import type { z } from "zod"

import type { Label } from "./labels"

// ------------------------------------------------------------------ who is calling

/** A person, as the app's own sign-in knows them. `tenant`: their organization or workspace in the app, when it has them. */
export type Person = { id: string; name: string; email?: string; tenant?: string }

/**
 * A grant (access profile): one client acting for one person with the scopes the person consented to, until revoked.
 * What `auth.verify` returns for a valid access token.
 */
export type Grant = {
  /** The grant's id: revoking it refuses its tokens, ends its transferred sessions and cancels its confirmations. */
  id: string
  /** The OAuth client (a Client ID Metadata Document URL, usually). */
  clientId: string
  /** The client's display name, when known. */
  clientName?: string
  person: Person
  scopes: readonly string[]
}

/** What every handler gets. */
export type Context = {
  readonly person: Person
  readonly grant: Grant
  /** The person's language for this call (`io.modelcontextprotocol/acceptLanguage`), else the app's. */
  readonly locale: string
  /** A label in the caller's language. */
  t(label: Label | undefined): string
  /** Whether the grant holds `scope` (access profile §1; a grant with none of the `web.*` scopes reads only). */
  has(scope: string): boolean
  /** The app's public origin (web-map `origin`). */
  readonly origin: string
  /** The web URL of a record of the app (its MCP resource URI, web-map REC-1). */
  url(entity: EntityHandle, record: Record<string, unknown>): string
  /** Says what this call changed (record URLs, badge or widget handles): clients redraw them (web-map REC-2, PAGE-7). */
  changed(...what: (string | BadgeHandle | WidgetHandle)[]): void
  /** A notification (event type `com.clegra.app.notification`) to people of the app (default the caller). */
  notify(notification: NotificationInput): Promise<void>
  /** Something happening now (event type `com.clegra.app.activity`). */
  activity(activity: ActivityInput): Promise<void>
  /** Where a call came from when it is a share (app-share SHR-5): its text is a third party's. */
  readonly source: { origin?: string; builtin?: string } | null
}

/** EVT-2: `title` generic by default, `body` absent unless the person turned it on; `url` a page or record of the app. */
export type NotificationInput = { type: string; title: Label; body?: Label; url: string; id?: string; dedupe?: string; to?: string[] }
export type ActivityInput = { id: string; type: string; title: Label; status?: Label; progress?: number; state: "running" | "waiting" | "done" | "failed" | "cancelled"; url?: string; tools?: ToolHandle[]; to?: string[] }

// ------------------------------------------------------------------ entities: records at their web URLs

/** The card roles (web-map REC-4): which fields of the record play them. */
export type Card<Fields extends string = string> = { title: Fields; subtitle?: Fields; status?: Fields; amount?: Fields; date?: Fields }

/** app-share: what a record can be shared as (`shareAs`): standard field ← JSON Pointer into the record. */
export type ShareAs = { type: ShareType; fields: Record<string, string> }
export type ShareType = "text" | "link" | "file" | "message" | "contact" | "event" | "document" | "record"

export type ListQuery = { text?: string; cursor?: string; limit: number }

export type EntityConfig<S extends z.ZodObject> = {
  name: string
  title: Label
  plural?: Label
  description?: Label
  /** The record's web URL relative to the app's origin, a URI Template (`/jobs/{id}`): every variable is a field of the record. */
  path: string
  schema: S
  card: Card<Extract<keyof z.infer<S>, string>>
  /** One record by its template's variables, as the caller may see it: null when there is none or they may not see it. */
  get(vars: Record<string, string>, ctx: Context): Promise<z.infer<S> | null> | z.infer<S> | null
  /** The records the caller may see (the generated list page; tools you write may use it too). */
  list?(query: ListQuery, ctx: Context): Promise<{ rows: z.infer<S>[]; next?: string }> | { rows: z.infer<S>[]; next?: string }
  shareAs?: ShareAs[]
  /** How long a client may show a read record before reading it again (REC-3), default 30 000 ms. */
  ttlMs?: number
}

export type EntityHandle<S extends z.ZodObject = z.ZodObject> = { readonly kind: "entity"; readonly name: string; readonly config: EntityConfig<S> }

export function defineEntity<S extends z.ZodObject>(config: EntityConfig<S>): EntityHandle<S> {
  return Object.freeze({ kind: "entity" as const, name: config.name, config })
}

// ------------------------------------------------------------------ tools

/** The core tool annotations, kept truthful (confirmation guide ACT-1). Writes say whether they destroy. */
export type ToolAnnotations = { readOnly: true; openWorld?: boolean } | { readOnly: false; destructive: boolean; idempotent?: boolean; openWorld?: boolean }

/** app-share part A: a standard content type the tool accepts, and which standard field goes to which input. */
export type Accept = { type: ShareType; title: Label; icon?: string; mimeTypes?: string[]; map: Record<string, string> }
/** app-share part B: the tool's action on another app's records (`url`: its MCP endpoint) or on a built-in part. */
export type Plugin = { target: { url: string } | { builtin: string }; recordType: string; title: Label; icon?: string; map: Record<string, string>; urlArg?: string }

/**
 * The app's own confirmation (confirmation guide ACT-2): for a tool that sends, pays, shares, deletes for good or
 * changes recipients. `message` is the summary the person approves, from the app's own data; `values` the resolved
 * values it is bound to (CNF-4: if they differ when the tool runs, the call is refused as stale).
 */
export type ConfirmConfig<I, R> = {
  message(input: I, ctx: Context, record: R): string | Promise<string>
  values?(input: I, ctx: Context, record: R): Record<string, unknown> | Promise<Record<string, unknown>>
}

/** What a tool returns: data for clients (`structuredContent`), a text for models, the records it made or touched. */
export type ToolResult = {
  data?: Record<string, unknown>
  text?: string
  /** Records returned or changed, as `resource_link`s at their web URLs (REC-2). */
  records?: { entity: EntityHandle; record: Record<string, unknown> }[]
  /** Pages or other URLs to offer the person (PAGE-3). */
  links?: { url: string; name: string }[]
}

export type RecordOf<E> = E extends EntityHandle<infer S> ? z.infer<S> : undefined

export type ToolConfig<I extends z.ZodObject, E extends EntityHandle | undefined> = {
  name: string
  title: Label
  description: Label
  input: I
  output?: z.ZodObject
  annotations: ToolAnnotations
  /** The record type the tool works on (web-map §3). */
  entity?: E
  /** One `record` (its URL, or a bare id, is in `recordArg`) or the `collection`. Default `collection`. */
  on?: "record" | "collection"
  /** With `on: "record"`: the input holding the record's URL, default `id`. */
  recordArg?: string
  /** The page where a person does or sees the same thing. */
  page?: PageHandle
  confirm?: ConfirmConfig<z.infer<I>, RecordOf<E>>
  accepts?: Accept[]
  plugins?: Plugin[]
  /** `"app"`: hidden from models (`_meta.ui.visibility`), for the client's own UI. */
  visibility?: "app"
  /** Whether this person may use the tool now; a tool they may not use is not listed (ORG-4). */
  allow?(ctx: Context): boolean | Promise<boolean>
  run(input: z.infer<I>, ctx: Context, record: RecordOf<E>): Promise<ToolResult | void> | ToolResult | void
}

export type ToolHandle = { readonly kind: "tool"; readonly name: string; readonly config: ToolConfig<z.ZodObject, EntityHandle | undefined> }

export function defineTool<I extends z.ZodObject, E extends EntityHandle | undefined = undefined>(config: ToolConfig<I, E>): ToolHandle {
  return Object.freeze({ kind: "tool" as const, name: config.name, config: config as unknown as ToolHandle["config"] })
}

// ------------------------------------------------------------------ pages, badges, widgets

export type PageRole = "list" | "record" | "create" | "dashboard" | "settings" | "other"

export type PageConfig = {
  name: string
  title: Label
  /** The page's URL relative to the app's origin, a URI Template (`/jobs{?status}`). */
  path: string
  role: PageRole
  entity?: EntityHandle
  nav?: { section?: Label; order: number }
  /** Tool names to order or pick among the page's tools (MAP-1: the tools' `page` is authoritative). */
  tools?: string[]
  badge?: BadgeHandle
  /** Whether the app allows this page in a client's frame (default false). */
  frame?: boolean
  allow?(ctx: Context): boolean | Promise<boolean>
}

export type PageHandle = { readonly kind: "page"; readonly name: string; readonly config: PageConfig }

export function definePage(config: PageConfig): PageHandle {
  return Object.freeze({ kind: "page" as const, name: config.name, config })
}

/** A counter on a page's navigation entry (PAGE-5): the resource `webmap://badges/<name>`, `{ value }`. */
export type BadgeConfig = { name: string; title?: Label; value(ctx: Context): number | Promise<number>; allow?(ctx: Context): boolean | Promise<boolean> }
export type BadgeHandle = { readonly kind: "badge"; readonly name: string; readonly config: BadgeConfig }

export function defineBadge(config: BadgeConfig): BadgeHandle {
  return Object.freeze({ kind: "badge" as const, name: config.name, config })
}

/** The minimal tile payload (PAGE-6) any client can draw. */
export type Tile = {
  title: string
  value?: number | string
  unit?: string
  trend?: "up" | "down" | "flat"
  rows?: { title: string; subtitle?: string; status?: string; amount?: string; date?: string; url?: string }[]
  url?: string
}

export type WidgetSize = "small" | "medium" | "large"
export type WidgetConfig = { name: string; title: Label; description?: Label; sizes: WidgetSize[]; data(ctx: Context): Tile | Promise<Tile>; allow?(ctx: Context): boolean | Promise<boolean> }
export type WidgetHandle = { readonly kind: "widget"; readonly name: string; readonly config: WidgetConfig }

export function defineWidget(config: WidgetConfig): WidgetHandle {
  return Object.freeze({ kind: "widget" as const, name: config.name, config })
}

// ------------------------------------------------------------------ agents (app-agents profile)

export type AgentSchedule = { name: string; title?: string; cron: string; timezone?: string; starter: number }

export type AgentConfig = {
  /** The skill's name: lowercase letters, digits and hyphens. */
  name: string
  description: string
  /** The instructions (the body of `SKILL.md`), Markdown. */
  instructions: string
  /** The only tools it may call (`allowed-tools`). */
  tools: ToolHandle[]
  tier?: "fast" | "standard" | "strong"
  maxSteps?: number
  approval?: { change: "ask" | "always" }
  starters?: string[]
  schedules?: AgentSchedule[]
}

export type AgentHandle = { readonly kind: "agent"; readonly name: string; readonly config: AgentConfig }

export function defineAgent(config: AgentConfig): AgentHandle {
  return Object.freeze({ kind: "agent" as const, name: config.name, config })
}

// ------------------------------------------------------------------ the app

export type Icon = { src: string; mimeType?: string; sizes?: string[]; theme?: "light" | "dark" }

export type AppConfig = {
  /** The app's id: lowercase letters, digits and `-`. */
  name: string
  title: Label
  description: Label
  version: string
  /** The app's own locale (tool names stay stable; titles follow the caller), default `en`. */
  locale?: string
  icons?: Icon[]
  /** Instructions for models (`server/discover`). */
  instructions?: string
  entities?: EntityHandle[]
  tools?: ToolHandle[]
  pages?: PageHandle[]
  badges?: BadgeHandle[]
  widgets?: WidgetHandle[]
  agents?: AgentHandle[]
  /** The app's notification types (event type note): the `type`s `ctx.notify` may use. */
  notifications?: Record<string, { title: Label }>
  /** Session transfer (profile): the strong mode is on whenever `serve` has `sessions`; `link: true` also offers the Clerk-compatible mode (SES-12). */
  sessionTransfer?: { link?: boolean }
}
