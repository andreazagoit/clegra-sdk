import { z } from "zod"

import type { AgentHandle, AppConfig, BadgeHandle, EntityHandle, PageHandle, ToolHandle, WidgetHandle } from "./define"
import { pathVars, templateProblem, templateVars } from "./template"

/** An app, checked and ready to serve. Pure: nothing is served until `serve(app, …)`. */
export type App = {
  readonly kind: "app"
  readonly name: string
  readonly locale: string
  readonly config: AppConfig
  readonly entities: ReadonlyMap<string, EntityHandle>
  readonly tools: ReadonlyMap<string, ToolHandle>
  readonly pages: ReadonlyMap<string, PageHandle>
  readonly badges: ReadonlyMap<string, BadgeHandle>
  readonly widgets: ReadonlyMap<string, WidgetHandle>
  readonly agents: ReadonlyMap<string, AgentHandle>
}

export const APP_NAME = /^[a-z][a-z0-9-]{1,39}$/
export const TOOL_NAME = /^[A-Za-z0-9_.-]{1,64}$/
export const SKILL_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/
const THING_NAME = /^[a-z][a-z0-9_-]{0,63}$/

/** Names reserved by the session-transfer profile. */
export const SESSION_TOOLS = ["create_bound_browser_session", "create_browser_session"] as const

const SHARE_FIELDS: Record<string, string[]> = {
  text: ["text"],
  link: ["url", "name"],
  file: ["file"],
  message: ["headline", "text", "sender", "sender.name", "sender.email", "recipient", "dateSent", "url"],
  contact: ["name", "email", "telephone", "vatID", "address", "url"],
  event: ["name", "startDate", "endDate", "location", "description", "attendee", "url"],
  document: ["name", "text", "file", "url"],
  record: ["url", "name", "recordType", "origin"],
}

/** The JSON Schema of a zod object as the tool lists it. */
export function jsonSchemaOf(schema: z.ZodObject): Record<string, unknown> {
  return z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as Record<string, unknown>
}

function unique<T extends { name: string }>(what: string, items: readonly T[] | undefined, pattern: RegExp): Map<string, T> {
  const map = new Map<string, T>()
  for (const item of items ?? []) {
    if (!pattern.test(item.name)) throw new Error(`defineApp: ${what} "${item.name}": the name must match ${pattern}`)
    if (map.has(item.name)) throw new Error(`defineApp: two ${what}s are named "${item.name}"`)
    map.set(item.name, item)
  }
  return map
}

/** Checks the whole app at once (every problem names its place) and returns it. */
export function defineApp(config: AppConfig): App {
  if (!APP_NAME.test(config.name)) throw new Error(`defineApp: name "${config.name}": lowercase letters, digits and -, 2 to 40 characters`)
  if (!config.version) throw new Error("defineApp: version is required")
  const entities = unique("entity", config.entities, THING_NAME)
  const tools = unique("tool", config.tools, TOOL_NAME)
  const pages = unique("page", config.pages, THING_NAME)
  const badges = unique("badge", config.badges, THING_NAME)
  const widgets = unique("widget", config.widgets, THING_NAME)
  const agents = unique("agent", config.agents, SKILL_NAME)
  for (const reserved of SESSION_TOOLS) if (tools.has(reserved)) throw new Error(`defineApp: "${reserved}" is the session-transfer profile's tool: the SDK serves it`)

  for (const e of entities.values()) {
    const c = e.config
    const where = `entity "${e.name}"`
    if (!c.path.startsWith("/")) throw new Error(`${where}: path "${c.path}" must start with /`)
    const problem = templateProblem(c.path)
    if (problem) throw new Error(`${where}: path "${c.path}": ${problem}`)
    const keys = Object.keys(c.schema.shape)
    const vars = pathVars(c.path)
    if (!vars.length) throw new Error(`${where}: path "${c.path}" names no record variable ({id})`)
    if (templateVars(c.path).length !== vars.length) throw new Error(`${where}: path "${c.path}": a record's URL has no query expressions`)
    for (const v of vars) if (!keys.includes(v)) throw new Error(`${where}: path variable {${v}} is not a field of the schema`)
    for (const [role, field] of Object.entries(c.card)) if (field !== undefined && !keys.includes(field)) throw new Error(`${where}: card.${role} "${field}" is not a field of the schema`)
    for (const s of c.shareAs ?? []) {
      if (!SHARE_FIELDS[s.type]) throw new Error(`${where}: shareAs type "${s.type}" is not a standard content type`)
      for (const [field, pointer] of Object.entries(s.fields)) {
        if (!SHARE_FIELDS[s.type]!.includes(field)) throw new Error(`${where}: shareAs ${s.type}: "${field}" is not a standard field of ${s.type}`)
        if (!pointer.startsWith("/")) throw new Error(`${where}: shareAs ${s.type}.${field}: "${pointer}" must be a JSON Pointer (/a/b)`)
      }
    }
  }

  for (const p of pages.values()) {
    const c = p.config
    const where = `page "${p.name}"`
    if (!c.path.startsWith("/")) throw new Error(`${where}: path "${c.path}" must start with /`)
    const problem = templateProblem(c.path)
    if (problem) throw new Error(`${where}: path "${c.path}": ${problem}`)
    if (c.entity && entities.get(c.entity.name) !== c.entity) throw new Error(`${where}: its entity "${c.entity.name}" is not one of the app's entities`)
    if (c.badge && badges.get(c.badge.name) !== c.badge) throw new Error(`${where}: its badge "${c.badge.name}" is not one of the app's badges`)
    for (const t of c.tools ?? []) if (!tools.has(t)) throw new Error(`${where}: tools: "${t}" is not one of the app's tools`)
  }

  for (const t of tools.values()) {
    const c = t.config
    const where = `tool "${t.name}"`
    const schema = jsonSchemaOf(c.input)
    const props = Object.keys((schema.properties as Record<string, unknown> | undefined) ?? {})
    if (c.entity && entities.get(c.entity.name) !== c.entity) throw new Error(`${where}: its entity "${c.entity.name}" is not one of the app's entities`)
    if (c.on === "record") {
      if (!c.entity) throw new Error(`${where}: on "record" needs its entity`)
      const arg = c.recordArg ?? "id"
      if (!props.includes(arg)) throw new Error(`${where}: recordArg "${arg}" is not an input of the tool`)
    }
    if (c.annotations.readOnly && c.confirm) throw new Error(`${where}: a read-only tool is never confirmed (ACT-2 tools change something for good)`)
    if (c.page) {
      if (pages.get(c.page.name) !== c.page) throw new Error(`${where}: its page "${c.page.name}" is not one of the app's pages`)
      const recordVars = c.on === "record" && c.entity ? pathVars(c.entity.config.path) : []
      for (const v of pathVars(c.page.config.path)) {
        if (!props.includes(v) && !recordVars.includes(v)) throw new Error(`${where}: its page's variable {${v}} is neither an input nor a variable of the record's URL (web-map MAP-2)`)
      }
    }
    if (c.accepts?.length || c.plugins?.length) {
      if (schema.additionalProperties !== false) throw new Error(`${where}: a tool that accepts shared content has a closed input (z.strictObject: app-share SHR-3)`)
      for (const a of c.accepts ?? []) {
        if (!SHARE_FIELDS[a.type]) throw new Error(`${where}: accepts type "${a.type}" is not a standard content type`)
        for (const [input, field] of Object.entries(a.map)) {
          if (!props.includes(input)) throw new Error(`${where}: accepts ${a.type}: "${input}" is not an input of the tool (SHR-3)`)
          if (!SHARE_FIELDS[a.type]!.includes(field)) throw new Error(`${where}: accepts ${a.type}: "${field}" is not a standard field of ${a.type}`)
        }
      }
      for (const pl of c.plugins ?? []) {
        if ("url" in pl.target && !/^https:\/\//.test(pl.target.url) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(pl.target.url)) throw new Error(`${where}: plugin target "${pl.target.url}" must be an https MCP endpoint URL`)
        for (const [input, pointer] of Object.entries(pl.map)) {
          if (!props.includes(input)) throw new Error(`${where}: plugin on ${pl.recordType}: "${input}" is not an input of the tool (SHR-3)`)
          if (!pointer.startsWith("/")) throw new Error(`${where}: plugin on ${pl.recordType}: "${pointer}" must be a JSON Pointer`)
        }
        if (pl.urlArg && !props.includes(pl.urlArg)) throw new Error(`${where}: plugin urlArg "${pl.urlArg}" is not an input of the tool`)
      }
    }
  }

  for (const a of agents.values()) {
    const c = a.config
    const where = `agent "${a.name}"`
    if (!c.tools.length) throw new Error(`${where}: it needs at least one tool`)
    for (const t of c.tools) if (tools.get(t.name) !== t) throw new Error(`${where}: tool "${t.name}" is not one of the app's tools`)
    if (c.maxSteps !== undefined && (!Number.isInteger(c.maxSteps) || c.maxSteps < 1 || c.maxSteps > 200)) throw new Error(`${where}: maxSteps is 1 to 200`)
    if ((c.starters?.length ?? 0) > 6) throw new Error(`${where}: at most 6 starters`)
    for (const s of c.schedules ?? []) {
      const fields = s.cron.trim().split(/\s+/)
      if (fields.length !== 5) throw new Error(`${where}: schedule "${s.name}": cron has five fields`)
      if (!/^\d{1,2}$/.test(fields[0]!)) throw new Error(`${where}: schedule "${s.name}": no more often than once an hour (a fixed minute: AGT-8)`)
      if (!c.starters?.[s.starter]) throw new Error(`${where}: schedule "${s.name}": starter ${s.starter} is not one of its starters`)
    }
  }

  return Object.freeze({ kind: "app" as const, name: config.name, locale: config.locale ?? "en", config, entities, tools, pages, badges, widgets, agents })
}
