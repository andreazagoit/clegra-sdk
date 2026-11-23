/**
 * THE MANIFEST'S RULES BEYOND ITS SCHEMA, IN ONE PLACE: the publisher, navigation, page actions and badges, app-only items, schedules,
 * notification types, targets, later runs and the reserved tools. The SDK runs them at definition time (a wrong name
 * fails when the app starts) and the conformance checks run them from outside (`manifest.references`), so the two
 * never disagree. Each problem names its place: `page "x": …`. No dependencies.
 */

import { KINDS, kindNameProblem, NAMESPACED_KIND, PROPERTY_NAME, propertyOf, type KindDef } from "./kinds"
import { APP_ACCENTS, INSTALLATION_TOOLS, LATER_TOOL, ROLES_TOOL } from "./protocol"

/** The bounds of the rules below (the JSON Schema carries the same ones). */
export const LIMITS = {
  pageActions: 8,
  schedules: 10,
  scheduleEvery: { min: 5, max: 1440 },
  scheduleSeconds: { min: 1, max: 300, default: 60 },
  targetsPerAction: 4,
  targetsPerApp: 12,
  targetLabel: 40,
  laterWindow: { min: 10, max: 10080, default: 60 },
  /** How often the SDK's own later schedule runs, in minutes. */
  laterEvery: 5,
  publisherName: 100,
  publisherUrl: 300,
} as const

/** The fields of an email a target may need (`mail.message`). */
export const MAIL_FIELDS = ["subject", "from", "to", "date", "text", "attachments"] as const

const IDENT = /^[a-z][a-z0-9_]{0,39}$/
/** A placeholder in a target's input template: `{field}` or `{field.sub}`. */
export const PLACEHOLDER = /\{([A-Za-z][A-Za-z0-9_]*)(?:\.([A-Za-z][A-Za-z0-9_]*))?\}/g

type Label = Record<string, string>
type ToolRef = { name: string; plain: boolean }
type InputSchema = { properties?: Record<string, { type?: unknown; format?: unknown }>; required?: unknown }

/** What the rules read of a manifest (a subset of its shape). */
export type RulesManifest = {
  accent?: string
  publisher?: { name: string; url: string }
  kinds?: Record<string, KindDef>
  entities: { name: string; tools: { list: ToolRef; get: ToolRef }; visibility?: string }[]
  actions: {
    name: string
    entity?: string
    input: InputSchema
    readOnly: boolean
    confirm: string
    tool: ToolRef
    visibility?: string
    targets?: { target: string; needs: string[]; input?: Record<string, unknown>; label?: Label }[]
    later?: { at: string; window: number }
  }[]
  pages: { name: string; kind: string; tool: ToolRef; actions?: string[]; badge?: string }[]
  artifacts: { type: string; entity?: string; template?: string; params: InputSchema; tool: ToolRef; visibility?: string }[]
  agents: { name: string; tools: string[] }[]
  permissions: { id: string }[]
  nav?: { section?: Label; pages: string[] }[]
  schedules?: { name: string; action?: string; tool: string; every: number; maxSeconds: number }[]
  notifications?: { type: string; label: Label; permission?: string }[]
}

const requiredOf = (schema: InputSchema | undefined): string[] => (Array.isArray(schema?.required) ? (schema!.required as unknown[]).filter((r): r is string => typeof r === "string") : [])
const isInt = (n: unknown, min: number, max: number) => typeof n === "number" && Number.isInteger(n) && n >= min && n <= max

/** The tools of the app-only items (entities' list and get, actions, artifacts): what no model is ever given. */
export function appOnlyTools(m: Pick<RulesManifest, "entities" | "actions" | "artifacts">): Map<string, string> {
  const out = new Map<string, string>()
  for (const e of m.entities) if (e.visibility === "app") for (const t of [e.tools.list, e.tools.get]) out.set(t.name, `entity "${e.name}"`)
  for (const a of m.actions) if (a.visibility === "app") out.set(a.tool.name, `action "${a.name}"`)
  for (const f of m.artifacts) if (f.visibility === "app" && !f.entity) out.set(f.tool.name, `artifact "${f.type}"`)
  return out
}

/** What a target may name in its input template: `uri`, a record's `title`, and the fields it needs. */
function targetProblems(where: string, t: NonNullable<RulesManifest["actions"][number]["targets"]>[number], input: InputSchema, own: Record<string, KindDef> | undefined): string[] {
  const p: string[] = []
  let fields: readonly string[] | null = null
  if (t.target === "mail.message") fields = MAIL_FIELDS
  else if (t.target.startsWith("record:")) {
    const kind = t.target.slice("record:".length)
    const why = kindNameProblem(kind)
    if (why) return [`${where}: ${why}`]
    // A kind this app defines or a published one: its properties are known. A namespaced kind of another app: only the names' form is.
    const known = Object.hasOwn(KINDS, kind) || Boolean(own && Object.hasOwn(own, kind))
    for (const n of t.needs) {
      if (known ? !propertyOf(n, [kind], own) : !NAMESPACED_KIND.test(kind) || !PROPERTY_NAME.test(n)) p.push(known ? `${where}: "${n}" is not a property of kind ${kind}` : `${where}: "${n}" is not a property name`)
    }
  } else return [`${where}: target is mail.message or record:<kind>`]
  if (fields) for (const n of t.needs) if (!fields.includes(n)) p.push(`${where}: "${n}" is not a field of ${t.target} (${fields.join(", ")})`)
  if (new Set(t.needs).size !== t.needs.length) p.push(`${where}: needs names a field twice`)
  const record = t.target.startsWith("record:")
  const available = new Set([...t.needs, "uri", ...(record ? ["title"] : [])])
  const props = input.properties ?? {}
  const walk = (value: unknown, at: string) => {
    if (typeof value === "string") {
      for (const m of value.matchAll(PLACEHOLDER)) if (!available.has(m[1]!)) p.push(`${where}: input ${at}: {${m[0].slice(1, -1)}} names "${m[1]}", which is not uri${record ? ", title" : ""} or a needed field`)
    } else if (Array.isArray(value)) value.forEach((v, i) => walk(v, `${at}[${i}]`))
    else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) walk(v, `${at}.${k}`)
  }
  for (const [k, v] of Object.entries(t.input ?? {})) {
    if (!Object.hasOwn(props, k)) p.push(`${where}: input "${k}" is not an input of the action`)
    walk(v, `"${k}"`)
  }
  for (const [locale, text] of Object.entries(t.label ?? {})) if (text.length > LIMITS.targetLabel) p.push(`${where}: label (${locale}) is longer than ${LIMITS.targetLabel} characters`)
  return p
}

/** The publisher's problems: a name (trimmed, no control characters) and an absolute https URL with a host. */
export function publisherProblems(publisher: { name: string; url: string }): string[] {
  const p: string[] = []
  const name = publisher.name
  if (name.trim() !== name || !name.length) p.push("publisher: the name is empty or has spaces around it")
  if (/[\u0000-\u001f\u007f]/.test(name)) p.push("publisher: the name has control characters")
  if (name.length > LIMITS.publisherName) p.push(`publisher: the name is longer than ${LIMITS.publisherName} characters`)
  let url: URL | null = null
  try {
    url = new URL(publisher.url)
  } catch {}
  if (!url || url.protocol !== "https:" || !url.hostname) p.push(`publisher: url "${publisher.url}" is not an absolute https address`)
  else if (url.username || url.password) p.push("publisher: url carries credentials")
  if (publisher.url.length > LIMITS.publisherUrl) p.push(`publisher: url is longer than ${LIMITS.publisherUrl} characters`)
  return p
}

/** Every rule of the list above that doesn't hold, each naming its place. Empty: they all hold. */
export function manifestRuleProblems(m: RulesManifest): string[] {
  const p: string[] = []
  const pages = new Map(m.pages.map((x) => [x.name, x]))
  const actions = new Map(m.actions.map((a) => [a.name, a]))
  const artifacts = new Map(m.artifacts.map((f) => [f.type, f]))
  const permissions = new Set(m.permissions.map((x) => x.id))

  // Reserved tools: the installation-level caller's, never an app's own.
  const tools = [...m.entities.flatMap((e) => [e.tools.list.name, e.tools.get.name]), ...m.actions.map((a) => a.tool.name), ...m.pages.filter((x) => x.kind !== "record").map((x) => x.tool.name), ...m.artifacts.filter((f) => !f.entity).map((f) => f.tool.name)]
  for (const t of tools) if ((INSTALLATION_TOOLS as readonly string[]).includes(t)) p.push(`tool "${t}" is reserved (the installation's own tools)`)
  for (const t of tools) if (t === ROLES_TOOL) p.push(`tool "${t}" is reserved (the app administrators' «who has what»)`)

  // The publisher: a claim, well-formed (spec §2).
  if (m.publisher) p.push(...publisherProblems(m.publisher))
  // The accent: a name of the palette, never a colour (spec §2).
  if (m.accent !== undefined && !(APP_ACCENTS as readonly string[]).includes(m.accent)) p.push(`accent: "${m.accent}" is not one of ${APP_ACCENTS.join(", ")}`)

  // Navigation.
  const seen = new Set<string>()
  for (const [i, s] of (m.nav ?? []).entries()) {
    const where = `nav section ${i + 1}`
    if (!s.pages.length) p.push(`${where}: no pages`)
    for (const name of s.pages) {
      const page = pages.get(name)
      if (!page) p.push(`${where}: "${name}" is not a page of this app`)
      else if (page.kind === "record") p.push(`${where}: "${name}" is a record page (records open from lists and links)`)
      if (seen.has(name)) p.push(`${where}: page "${name}" is in the navigation twice`)
      seen.add(name)
    }
  }

  // Page actions and badges.
  for (const page of m.pages) {
    const where = `page "${page.name}"`
    if (page.actions?.length) {
      if (page.kind === "record") p.push(`${where}: a record page has no page actions (its record's actions are there)`)
      if (page.actions.length > LIMITS.pageActions) p.push(`${where}: at most ${LIMITS.pageActions} actions`)
      if (new Set(page.actions).size !== page.actions.length) p.push(`${where}: an action is named twice`)
      for (const name of page.actions) {
        const a = actions.get(name)
        if (!a) p.push(`${where}: "${name}" is not an action of this app`)
        else if (a.entity) p.push(`${where}: "${name}" works on one ${a.entity}: a page offers global actions`)
      }
    }
    if (page.badge !== undefined) {
      const f = artifacts.get(page.badge)
      if (page.kind === "record") p.push(`${where}: a record page has no badge`)
      if (!f || f.entity) p.push(`${where}: badge "${page.badge}" is not an artifact type of this app`)
      else {
        if (f.template !== "stat") p.push(`${where}: badge "${page.badge}" is not a stat artifact (its data.value is the count)`)
        if (requiredOf(f.params).length) p.push(`${where}: badge "${page.badge}" has required params (${requiredOf(f.params).join(", ")}); a badge is shown with none`)
      }
    }
  }

  // App-only items: no model gets them, the app's own agents included.
  const appOnly = appOnlyTools(m)
  for (const a of m.agents) for (const t of a.tools) if (appOnly.has(t)) p.push(`agent "${a.name}": ${t} is the tool of ${appOnly.get(t)}, which is app-only (visibility: "app"): no model gets it`)

  // Targets.
  let targets = 0
  for (const a of m.actions) {
    const list = a.targets ?? []
    targets += list.length
    if (!list.length) continue
    if (a.entity) p.push(`action "${a.name}": targets are for global actions (a record action has its record already)`)
    if (list.length > LIMITS.targetsPerAction) p.push(`action "${a.name}": at most ${LIMITS.targetsPerAction} targets`)
    for (const [i, t] of list.entries()) p.push(...targetProblems(`action "${a.name}", target ${i + 1} (${t.target})`, t, a.input, m.kinds))
  }
  if (targets > LIMITS.targetsPerApp) p.push(`targets: at most ${LIMITS.targetsPerApp} in an app (${targets})`)

  // Later runs.
  const later = m.actions.filter((a) => a.later)
  for (const a of later) {
    const where = `action "${a.name}": later`
    if (a.readOnly || a.confirm !== "always") p.push(`${where} is for a write the person confirms (confirm "always")`)
    const at = a.input.properties?.[a.later!.at]
    if (!at) p.push(`${where}: "${a.later!.at}" is not an input of the action`)
    else {
      if (!requiredOf(a.input).includes(a.later!.at)) p.push(`${where}: "${a.later!.at}" must be a required input`)
      if (at.type !== "string" || at.format !== "date-time") p.push(`${where}: "${a.later!.at}" must be a date-time string (z.iso.datetime())`)
    }
    if (!isInt(a.later!.window, LIMITS.laterWindow.min, LIMITS.laterWindow.max)) p.push(`${where}: window is whole minutes from ${LIMITS.laterWindow.min} to ${LIMITS.laterWindow.max}`)
  }

  // Schedules.
  const schedules = m.schedules ?? []
  const own = schedules.filter((s) => s.name !== LATER_TOOL)
  if (own.length > LIMITS.schedules) p.push(`schedules: at most ${LIMITS.schedules}`)
  const names = new Set<string>()
  for (const s of schedules) {
    const where = `schedule "${s.name}"`
    if (!IDENT.test(s.name)) p.push(`${where}: lowercase letters, digits and _, starting with a letter`)
    if (names.has(s.name)) p.push(`${where} is declared twice`)
    names.add(s.name)
    if (!isInt(s.every, LIMITS.scheduleEvery.min, LIMITS.scheduleEvery.max)) p.push(`${where}: every is whole minutes from ${LIMITS.scheduleEvery.min} to ${LIMITS.scheduleEvery.max}`)
    if (!isInt(s.maxSeconds, LIMITS.scheduleSeconds.min, LIMITS.scheduleSeconds.max)) p.push(`${where}: maxSeconds is whole seconds from ${LIMITS.scheduleSeconds.min} to ${LIMITS.scheduleSeconds.max}`)
    if (s.name === LATER_TOOL) {
      if (s.action !== undefined || s.tool !== LATER_TOOL || s.every !== LIMITS.laterEvery) p.push(`${where} is reserved: the SDK's own, { tool: "${LATER_TOOL}", every: ${LIMITS.laterEvery} }, with no action`)
      continue
    }
    const a = s.action === undefined ? undefined : actions.get(s.action)
    if (!a) {
      p.push(`${where}: "${s.action ?? ""}" is not an action of this app`)
      continue
    }
    if (a.entity) p.push(`${where}: "${a.name}" works on one ${a.entity}; a schedule runs a global action`)
    if (requiredOf(a.input).length) p.push(`${where}: "${a.name}" has required inputs (${requiredOf(a.input).join(", ")}); a schedule calls it with {}`)
    if (!a.readOnly && a.confirm === "always") p.push(`${where}: "${a.name}" is a write the person confirms (confirm "always"): nobody is there to confirm a scheduled run; use later for an approved write that runs afterwards`)
    if (s.tool !== a.tool.name) p.push(`${where}: tool ${s.tool} is not the tool of "${a.name}" (${a.tool.name})`)
  }
  if (later.length && !names.has(LATER_TOOL)) p.push(`schedules: actions with later need the schedule "${LATER_TOOL}"`)
  if (!later.length && names.has(LATER_TOOL)) p.push(`schedule "${LATER_TOOL}": no action has later`)

  // Notification types (the SDK's own `clegra_later` is there exactly when an action has later).
  const types = new Set<string>()
  for (const n of m.notifications ?? []) {
    const where = `notification "${n.type}"`
    if (n.type === LATER_TOOL && !later.length) p.push(`${where} is reserved: the SDK's own, for later runs that did not run`)
    if (!IDENT.test(n.type)) p.push(`${where}: lowercase letters, digits and _, starting with a letter`)
    if (types.has(n.type)) p.push(`${where} is declared twice`)
    types.add(n.type)
    if (n.permission !== undefined && !permissions.has(n.permission)) p.push(`${where}: permission "${n.permission}" is not declared`)
  }
  if (later.length && !types.has(LATER_TOOL)) p.push(`notifications: actions with later need the type "${LATER_TOOL}" (their author is told when a run did not run)`)
  return p
}
