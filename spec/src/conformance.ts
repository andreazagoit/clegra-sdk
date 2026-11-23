import { Ajv2020 } from "ajv/dist/2020.js"

import schemaJson from "../schema/clegra.schema.json" with { type: "json" }

import { entityKindProblems, keyOf, RECORD_URI, kindDefinitionProblems, kindNameProblem, kindOfRecord, kindSentence, kindsOf, normaliseKey, propertyOf, valueProblem, type EntityKind, type KindDef, type KindField } from "./kinds"
import { INSTALLATION_TOOLS, SITE_COOKIE, SITE_MARKER_COOKIE, SITE_PATH, SITE_TICKET_SECONDS, SITE_TICKET_TYPE, LATER_TOOL, MANIFEST_PATH, META_KEY, PROTOCOL_ID, URI_SCHEME } from "./protocol"
import { appOnlyTools, manifestRuleProblems, type RulesManifest } from "./rules"

/**
 * CONFORMANCE (spec §8): what any app must do, checked from outside over
 * HTTP. It knows nothing of the SDK: it reads the manifest, validates it
 * against the published JSON Schema, and talks plain MCP to the endpoint.
 *
 *   const report = await checkApp({ url: "http://127.0.0.1:3920", token })
 *
 * For an app in the trusted-issuer mode (it trusts Clegra's core, spec §7 «Clegra tokens») the caller is a Clegra
 * caller instead: `clegra: { token, proof }`, its token sent as `Authorization: DPoP` with a proof per request.
 */

export { MANIFEST_PATH }
export const MCP_APP_MIME_TYPE = "text/html;profile=mcp-app"

// A JSON import, not a file read by path: bundlers (Next.js, Turbopack) then ship the schema with the module.
export const manifestSchema = schemaJson as Record<string, unknown>

export type Check = { id: string; title: string; ok: boolean; detail?: string; skipped?: boolean }
/** `ok`: no check failed. `complete`: every check ran (false when the MCP checks were skipped for lack of a caller). Conformant = both. */
export type Report = { ok: boolean; complete: boolean; checks: Check[] }

export type Options = {
  /** The app's origin, e.g. `https://crm.example.com`. */
  url: string
  /** A bearer token of a plain MCP caller (not a workspace host). Without it (or `clegra`) only the public checks run. */
  token?: string
  /** A Clegra caller, in place of `token`: a person of a company (or an agent for them) with a token of Clegra's core. */
  clegra?: ClegraCaller
  /** `fetch` to use (tests pass the app's own handler). */
  fetch?: (request: Request) => Promise<Response>
}

/**
 * A caller with a token of Clegra's core (spec §7, «Clegra tokens»): `@clegra/sdk/testing`'s `testCore` and
 * `deviceKey` make one for tests, Clegra's store review its own.
 */
export type ClegraCaller = {
  /** The app token (`clegra-app+jwt`, `aud` the app's resource), or a function giving one per request. */
  token: string | (() => string | Promise<string>)
  /** A DPoP proof (RFC 9449) by the key the token is bound to, for one request: `htu` is the app's resource. */
  proof(input: { htm: string; htu: string; token: string; nonce?: string }): string | Promise<string>
  /**
   * For an agent's token (`act`): the core's confirmation token for one call and the person's device's proof over it
   * (`_meta.clegra.confirmation`). With it the `mcp.confirm` check also calls each sensitive write once with a right
   * confirmation, so it runs: give it only against a test installation.
   */
  confirmation?(input: { tool: string; args: Record<string, unknown> }): Promise<{ token: string; proof: string }>
  /** One of the app's Clegra client origins (`CLEGRA_CLIENT_ORIGINS`): with it the `site.ticket` check frames the site from there. */
  clientOrigin?: string
}

type Tool = { name: string; title?: string; description?: string; inputSchema?: Record<string, unknown>; annotations?: Record<string, unknown>; _meta?: Record<string, unknown> }
type ToolRef = { name: string; plain: boolean }
type ManifestField = { name: string; type: string; required: boolean; enum?: string[]; ref?: string | { kind: string }; permission?: string; role?: string; sort?: boolean; filter?: boolean; search?: boolean; as?: string; currency?: string }
type Manifest = {
  specVersion: string
  name: string
  mcp: { url: string }
  auth: { resource?: string; authorizationServers: string[] }
  /** Where Clegra's core posts its events: declared only by an app that trusts the core (the trusted-issuer mode). */
  events?: { url: string }
  resolveTool: string
  searchTool?: string
  site?: { start: string; tool: ToolRef }
  kinds?: Record<string, KindDef>
  entities: { name: string; kind?: EntityKind; permission?: string; schema: { properties?: Record<string, { items?: { type?: unknown } }> }; fields: ManifestField[]; tools: { list: ToolRef; get: ToolRef }; searchable: boolean; visibility?: string }[]
  actions: (RulesManifest["actions"][number] & { input: { properties?: Record<string, { ref?: unknown; type?: unknown; format?: unknown }> }; permission?: string })[]
  pages: { name: string; kind: string; entity?: string; columns?: string[]; permission?: string; tool: ToolRef; view?: string; actions?: string[]; badge?: string }[]
  artifacts: { type: string; entity?: string; template?: string; view?: string; permission?: string; tool: ToolRef; actions?: string[]; params: { properties?: Record<string, unknown>; required?: unknown }; visibility?: string }[]
  agents: { name: string; tools: string[] }[]
  permissions: { id: string }[]
  nav?: RulesManifest["nav"]
  schedules?: RulesManifest["schedules"]
  notifications?: RulesManifest["notifications"]
  lifecycle?: Record<string, string>
}

const TOOL_NAME = /^[a-zA-Z0-9_.-]{1,64}$/

/** A field as the kind rules read it, from the manifest (an array's item type from the entity's JSON Schema). */
const kindField = (f: ManifestField, schema: Manifest["entities"][number]["schema"]): KindField => {
  const items = schema?.properties?.[f.name]?.items?.type
  return { name: f.name, type: f.type, required: f.required, ...(f.enum ? { enum: f.enum } : {}), ...(f.permission ? { permission: f.permission } : {}), ...(f.as !== undefined ? { as: f.as } : {}), ...(f.filter ? { filter: true } : {}), ...(f.currency ? { currency: f.currency } : {}), ...(f.type === "array" && typeof items === "string" ? { itemType: items } : {}) }
}

/** JSON with keys sorted at every depth: two values compared whatever their key order. */
const canonical = (v: unknown): string => JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : x))

const UNTRUSTED = /^<untrusted>([\s\S]*)<\/untrusted>$/
/** A value of a result's text as the app sent it: outsiders' text unwrapped (spec §7 says exactly how it is wrapped). */
function unwrap(value: unknown): unknown {
  if (typeof value === "string") {
    const m = UNTRUSTED.exec(value)
    return m ? m[1]!.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&") : value
  }
  if (Array.isArray(value)) return value.map(unwrap)
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, unwrap(v)]))
  return value
}

/** A sample value for a JSON Schema: each required property, an enum's first value, a format's typical form. */
function sampleOf(schema: unknown): unknown {
  if (!schema || typeof schema !== "object") return undefined
  const s = schema as { type?: unknown; enum?: unknown[]; const?: unknown; default?: unknown; format?: string; pattern?: string; minLength?: number; maxLength?: number; minimum?: number; exclusiveMinimum?: number; maximum?: number; items?: unknown; minItems?: number; properties?: Record<string, unknown>; required?: string[]; anyOf?: unknown[]; oneOf?: unknown[] }
  if (Array.isArray(s.enum) && s.enum.length) return s.enum[0]
  if ("const" in s) return s.const
  if (s.default !== undefined) return s.default
  const alternatives = s.anyOf ?? s.oneOf
  if (Array.isArray(alternatives) && alternatives.length) return sampleOf(alternatives.find((x) => (x as { type?: unknown })?.type !== "null") ?? alternatives[0])
  const type = Array.isArray(s.type) ? s.type.find((t) => t !== "null") : s.type
  if (type === "string") {
    const byFormat: Record<string, string> = { date: "2030-01-15", "date-time": "2030-01-15T09:00:00Z", time: "09:00:00", email: "conformance@example.com", uri: "https://example.com/", uuid: "00000000-0000-4000-8000-000000000000" }
    const fit = (v: string) => (s.maxLength !== undefined ? v.slice(0, s.maxLength) : v).padEnd(s.minLength ?? 0, "x")
    if (s.format && byFormat[s.format]) return byFormat[s.format]
    if (!s.pattern) return fit("conformance")
    // A pattern: the first of the usual forms it takes.
    let re: RegExp
    try {
      re = new RegExp(s.pattern, "u")
    } catch {
      return undefined
    }
    return ["conformance", ...Object.values(byFormat), "09:00", "CONF1", "1", "A"].map(fit).find((v) => re.test(v))
  }
  if (type === "integer" || type === "number") {
    const low = s.minimum ?? (s.exclusiveMinimum !== undefined ? s.exclusiveMinimum + 1 : 1)
    return s.maximum !== undefined && s.maximum < low ? s.maximum : low
  }
  if (type === "boolean") return false
  if (type === "array") return Array.from({ length: s.minItems ?? 0 }, () => sampleOf(s.items))
  if (type === "object" || s.properties) return Object.fromEntries((s.required ?? []).map((k) => [k, sampleOf(s.properties?.[k])]).filter(([, v]) => v !== undefined))
  return undefined
}

export async function checkApp(options: Options): Promise<Report> {
  const doFetch = options.fetch ?? ((r: Request) => fetch(r))
  const origin = options.url.replace(/\/+$/, "")
  const checks: Check[] = []
  const check = (id: string, title: string, problems: string[] | string | null) => {
    const list = problems === null ? [] : typeof problems === "string" ? [problems] : problems
    checks.push({ id, title, ok: list.length === 0, ...(list.length ? { detail: list.slice(0, 8).join("; ") } : {}) })
    return list.length === 0
  }
  let complete = true
  /** `partial`: the check was not run, so the report is not a conformance result. */
  const skip = (id: string, title: string, why: string, partial = false) => {
    checks.push({ id, title, ok: true, skipped: true, detail: why })
    if (partial) complete = false
  }
  const done = () => ({ ok: checks.every((c) => c.ok), complete, checks })

  // 1. The manifest: one fetch, pure JSON, valid against the schema.
  let manifest: Manifest
  try {
    const response = await doFetch(new Request(`${origin}${MANIFEST_PATH}`, { headers: { accept: "application/json" } }))
    if (response.status !== 200) return check("manifest.served", `GET ${MANIFEST_PATH} answers 200 with JSON`, `status ${response.status}`), done()
    manifest = (await response.json()) as Manifest
    check("manifest.served", `GET ${MANIFEST_PATH} answers 200 with JSON`, null)
  } catch (error) {
    return check("manifest.served", `GET ${MANIFEST_PATH} answers 200 with JSON`, String(error)), done()
  }
  const validate = new Ajv2020({ allErrors: true, strict: false }).compile(manifestSchema)
  if (!check("manifest.schema", "the manifest validates against the JSON Schema", validate(manifest) ? null : (validate.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message}`))) return done()

  // 2. Its references hold.
  const problems: string[] = []
  const entities = new Set(manifest.entities.map((e) => e.name))
  const permissions = new Set(manifest.permissions.map((p) => p.id))
  const actions = new Set(manifest.actions.map((a) => a.name))
  const perm = (p: string | undefined, where: string) => void (p && !permissions.has(p) && problems.push(`${where}: unknown permission ${p}`))
  for (const e of manifest.entities) {
    perm(e.permission, `entity ${e.name}`)
    if (!e.fields.some((f) => f.name === "id")) problems.push(`entity ${e.name}: no id field`)
    if (e.fields.filter((f) => f.role === "title").length !== 1) problems.push(`entity ${e.name}: exactly one field has role title`)
    for (const f of e.fields) {
      perm(f.permission, `${e.name}.${f.name}`)
      if (typeof f.ref === "string" && !entities.has(f.ref)) problems.push(`${e.name}.${f.name}: unknown entity ${f.ref}`)
      else if (f.ref !== undefined && typeof f.ref !== "string" && typeof (f.ref as { kind?: unknown })?.kind !== "string") problems.push(`${e.name}.${f.name}: ref is an entity or { kind }`)
    }
  }
  for (const a of manifest.actions) {
    perm(a.permission, `action ${a.name}`)
    if (a.entity && !entities.has(a.entity)) problems.push(`action ${a.name}: unknown entity ${a.entity}`)
    if (a.readOnly && a.confirm !== "never") problems.push(`action ${a.name}: a read never asks for confirmation`)
  }
  for (const p of manifest.pages) {
    perm(p.permission, `page ${p.name}`)
    if ((p.kind === "list" || p.kind === "record") && (!p.entity || !entities.has(p.entity))) problems.push(`page ${p.name}: unknown entity ${p.entity}`)
    if ((p.kind === "dashboard" || p.kind === "custom") && !p.view) problems.push(`page ${p.name}: a ${p.kind} page names its view`)
    const fields = new Set(manifest.entities.find((e) => e.name === p.entity)?.fields.map((f) => f.name))
    for (const c of p.columns ?? []) if (!fields.has(c)) problems.push(`page ${p.name}: unknown column ${c}`)
  }
  for (const f of manifest.artifacts) {
    perm(f.permission, `artifact ${f.type}`)
    if (!f.template && !f.view) problems.push(`artifact ${f.type}: neither a template nor a view`)
    for (const a of f.actions ?? []) if (!actions.has(a)) problems.push(`artifact ${f.type}: unknown action ${a}`)
  }
  const refs: { where: string; tool: ToolRef; kind: "read" | "write"; destructive?: boolean; view?: string }[] = [
    ...manifest.entities.flatMap((e) => [
      { where: `entity ${e.name}`, tool: e.tools.list, kind: "read" as const },
      { where: `entity ${e.name}`, tool: e.tools.get, kind: "read" as const },
    ]),
    ...manifest.actions.map((a) => ({ where: `action ${a.name}`, tool: a.tool, kind: a.readOnly ? ("read" as const) : ("write" as const), destructive: !a.readOnly && a.confirm === "always" })),
    ...manifest.pages.filter((p) => p.kind !== "record").map((p) => ({ where: `page ${p.name}`, tool: p.tool, kind: "read" as const, ...(p.view ? { view: p.view } : {}) })),
    ...manifest.artifacts.filter((f) => !f.entity).map((f) => ({ where: `artifact ${f.type}`, tool: f.tool, kind: "read" as const, ...(f.view ? { view: f.view } : {}) })),
  ]
  const names = new Map<string, string>()
  for (const r of refs) {
    if (!TOOL_NAME.test(r.tool.name)) problems.push(`${r.where}: tool name ${r.tool.name}`)
    const other = names.get(r.tool.name)
    if (other && other !== r.where) problems.push(`tool ${r.tool.name} is named by ${other} and ${r.where}`)
    names.set(r.tool.name, r.where)
  }
  const known = new Set([...names.keys(), manifest.resolveTool, ...(manifest.searchTool ? [manifest.searchTool, "fetch"] : [])])
  for (const a of manifest.agents) for (const t of a.tools) if (!known.has(t)) problems.push(`agent ${a.name}: unknown tool ${t}`)
  for (const r of refs) if (r.kind === "write" && r.tool.plain && !manifest.actions.find((a) => a.tool.name === r.tool.name)) problems.push(`${r.where}: only actions write`)
  // Navigation, page actions and badges, app-only items, targets, later runs, schedules, notification types, reserved tools: the SDK's own rules.
  problems.push(...manifestRuleProblems(manifest as unknown as RulesManifest))
  check("manifest.references", "names in the manifest refer to things it declares; tool names are unique and valid; navigation, page actions, schedules, notifications, targets and later runs hold", problems)

  // 2b. Kinds (spec §3.1): neutral for an app that declares none.
  const kinded = manifest.entities.filter((e) => e.kind !== undefined || e.fields.some((f) => f.as !== undefined))
  /** Cross-app references (spec §3.2): fields and action inputs with `ref: { kind }`. */
  const kindOfRef = (r: unknown) => (r && typeof r === "object" && typeof (r as { kind?: unknown }).kind === "string" ? (r as { kind: string }).kind : undefined)
  const crossFields = manifest.entities.flatMap((e) => e.fields.filter((f) => kindOfRef(f.ref) !== undefined).map((f) => ({ e, f, kind: kindOfRef(f.ref)! })))
  const crossInputs = manifest.actions.flatMap((a) => Object.entries(a.input?.properties ?? {}).filter(([, p]) => kindOfRef(p?.ref) !== undefined).map(([k, p]) => ({ a, k, kind: kindOfRef(p.ref)! })))
  const noKinds = !kinded.length && !Object.keys(manifest.kinds ?? {}).length && !crossFields.length && !crossInputs.length
  if (noKinds) {
    skip("kinds.known", "every kind is one of this specification's or a well-formed namespaced kind", "the app declares no kinds")
    skip("kinds.properties", "every `as` is a property of the entity's kind with a matching type; single-valued ones appear once; required ones exist", "the app declares no kinds")
  } else {
    const known: string[] = kindDefinitionProblems(manifest.kinds).filter((p) => p.includes("not a namespaced kind"))
    for (const e of manifest.entities) for (const k of e.kind === undefined ? [] : typeof e.kind === "string" ? [e.kind] : Object.values(e.kind.map ?? {})) {
      const p = kindNameProblem(k)
      if (p) known.push(`entity ${e.name}: ${p}`)
    }
    for (const { e, f, kind } of crossFields) if (kindNameProblem(kind)) known.push(`${e.name}.${f.name}: ref: ${kindNameProblem(kind)}`)
    for (const { a, k, kind } of crossInputs) if (kindNameProblem(kind)) known.push(`action ${a.name}, input ${k}: ref: ${kindNameProblem(kind)}`)
    check("kinds.known", "every kind is one of this specification's or a well-formed namespaced kind", [...new Set(known)])
    const props: string[] = kindDefinitionProblems(manifest.kinds).filter((p) => !p.includes("not a namespaced kind"))
    for (const e of manifest.entities) props.push(...entityKindProblems(`entity ${e.name}`, e.kind, e.fields.map((f) => kindField(f, e.schema)), manifest.kinds, { names: false }))
    check("kinds.properties", "every `as` is a property of the entity's kind with a matching type; single-valued ones appear once; required ones exist", props)
  }

  // 3. MCP authorization: no parallel sign-in.
  const mcpUrl = new URL(manifest.mcp.url, `${origin}/`).toString()
  const clegra = options.clegra
  if (clegra && options.token !== undefined) throw new Error("checkApp: give a plain caller's token or a Clegra caller, not both")
  /** A Clegra caller's DPoP `htu`: the app's configured resource (spec §7), never the address it was reached at. */
  const htu = manifest.auth.resource ?? mcpUrl
  let nonce: string | undefined
  /** `token`: a plain caller's bearer; `true`: the Clegra caller (DPoP, once more with the app's nonce). */
  const rpc = async (method: string, params: Record<string, unknown>, token?: string | true) => {
    const payload = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
    const send = async () => {
      let auth: Record<string, string> = {}
      if (token === true && clegra) {
        const t = typeof clegra.token === "function" ? await clegra.token() : clegra.token
        auth = { authorization: `DPoP ${t}`, dpop: await clegra.proof({ htm: "POST", htu, token: t, ...(nonce ? { nonce } : {}) }) }
      } else if (typeof token === "string") auth = { authorization: `Bearer ${token}` }
      return doFetch(new Request(mcpUrl, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18", ...auth }, body: payload }))
    }
    let response = await send()
    if (token === true && response.status === 401 && response.headers.get("dpop-nonce")) {
      nonce = response.headers.get("dpop-nonce")!
      response = await send()
    }
    const raw = await response.text()
    let body: { result?: Record<string, unknown>; error?: { message: string } } = {}
    try {
      body = response.headers.get("content-type")?.includes("text/event-stream") ? JSON.parse(raw.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).filter(Boolean).pop() ?? "{}") : JSON.parse(raw || "{}")
    } catch {}
    return { status: response.status, headers: response.headers, ...body }
  }
  const init = { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: `${PROTOCOL_ID}-conformance`, version: "1.0.0" } }
  const anonymous = await rpc("initialize", init)
  if (anonymous.status === 401) {
    const challenge = anonymous.headers.get("www-authenticate") ?? ""
    const metadataUrl = /resource_metadata="([^"]+)"/.exec(challenge)?.[1]
    const authProblems: string[] = []
    if (!metadataUrl) authProblems.push("the 401 has no WWW-Authenticate resource_metadata (RFC 9728)")
    else {
      const meta = await doFetch(new Request(metadataUrl))
      const body = meta.status === 200 ? ((await meta.json()) as { resource?: string; authorization_servers?: string[] }) : null
      if (!body) authProblems.push(`${metadataUrl} answers ${meta.status}`)
      else {
        if (!body.resource) authProblems.push("protected-resource metadata has no resource")
        // RFC 9728 §3.3: the metadata's resource is the address the client used; the manifest's, when it says one, is that same address (the token audience).
        else if (manifest.auth.resource ? manifest.auth.resource !== mcpUrl && body.resource !== mcpUrl : body.resource !== mcpUrl) authProblems.push(`the app says its address is ${manifest.auth.resource ?? body.resource}, but it was reached at ${mcpUrl}`)
        // An app in the trusted-issuer mode alone (it declares Clegra's events and no authorization server) signs nobody in by
        // OAuth: Clegra's core is never an authorization server (its tokens come from Clegra, spec §7), so the list may be empty.
        const trustedIssuerOnly = manifest.events !== undefined && !manifest.auth.authorizationServers.length
        if (!Array.isArray(body.authorization_servers)) authProblems.push("protected-resource metadata has no authorization_servers list")
        else if (!body.authorization_servers.length && !trustedIssuerOnly) authProblems.push("protected-resource metadata names no authorization server")
      }
    }
    check("auth.mcp", "without a token the endpoint answers 401 and points to OAuth protected-resource metadata", authProblems)
  } else if (anonymous.status === 200) skip("auth.mcp", "without a token the endpoint answers 401 and points to OAuth protected-resource metadata", "the app accepts anonymous callers")
  else check("auth.mcp", "without a token the endpoint answers 401 and points to OAuth protected-resource metadata", `status ${anonymous.status}`)

  // 3b. The app's own site (spec §5.1): the exchange is only ever posted, and nobody frames its refusals.
  const FA_TITLE = "the site's ticket exchange refuses anything but a framed POST, framable by no one, never X-Frame-Options"
  if (!manifest.site) skip("site.frame-ancestors", FA_TITLE, "the app has no site")
  else {
    const fa: string[] = []
    const r = await doFetch(new Request(`${origin}${SITE_PATH}`, { headers: { "sec-fetch-dest": "iframe" }, redirect: "manual" }))
    const directive = (r.headers.get("content-security-policy") ?? "").split(";").map((d) => d.trim()).find((d) => d.startsWith("frame-ancestors"))
    if (r.status < 400) fa.push(`GET ${SITE_PATH} answers ${r.status}: a ticket is only ever posted`)
    if (directive !== "frame-ancestors 'none'") fa.push(`GET ${SITE_PATH}: ${directive ?? "no frame-ancestors"}, not frame-ancestors 'none'`)
    if (r.headers.get("x-frame-options")) fa.push(`GET ${SITE_PATH}: X-Frame-Options ${r.headers.get("x-frame-options")} (it conflicts with frame-ancestors)`)
    if (r.headers.get("set-cookie")) fa.push(`GET ${SITE_PATH} sets a cookie`)
    check("site.frame-ancestors", FA_TITLE, fa)
  }

  const token: string | true | undefined | null = clegra ? true : (options.token ?? (anonymous.status === 200 ? undefined : null))
  if (token === null) {
    skip("mcp", "the MCP endpoint (tools, annotations, views)", "no token given", true)
    return done()
  }

  // 4. A plain MCP server: nothing a client must know beyond MCP.
  const started = await rpc("initialize", init, token)
  if (!check("mcp.initialize", "initialize succeeds; no extension is required", started.status !== 200 || !started.result ? `status ${started.status} ${started.error?.message ?? ""}` : null)) return done()
  const listed = ((await rpc("tools/list", {}, token)).result?.tools ?? []) as Tool[]
  const byName = new Map(listed.map((t) => [t.name, t]))
  const toolProblems: string[] = []
  for (const t of listed) {
    if (!TOOL_NAME.test(t.name)) toolProblems.push(`${t.name}: name`)
    if (!t.description) toolProblems.push(`${t.name}: no description`)
    if (t.inputSchema?.type !== "object") toolProblems.push(`${t.name}: inputSchema is not an object schema`)
  }
  for (const r of refs) {
    const tool = byName.get(r.tool.name)
    // A Clegra caller is a workspace host's person: what is hidden from plain clients is theirs to see.
    if (!r.tool.plain && !clegra) {
      if (tool) toolProblems.push(`${r.tool.name} (${r.where}) is not for plain clients but is listed to one`)
      continue
    }
    if (!tool) continue // not listed: this caller lacks a permission
    const a = tool.annotations ?? {}
    if (r.kind === "read" && a.readOnlyHint !== true) toolProblems.push(`${tool.name}: a read needs readOnlyHint: true`)
    if (r.kind === "write" && a.readOnlyHint !== false) toolProblems.push(`${tool.name}: a write needs readOnlyHint: false`)
    if (r.kind === "write" && a.destructiveHint !== Boolean(r.destructive)) toolProblems.push(`${tool.name}: destructiveHint must be ${Boolean(r.destructive)} (confirm)`)
  }
  check("mcp.tools", "tools match the manifest: names, annotations (readOnlyHint, destructiveHint), nothing hidden is listed", toolProblems)

  // 4h. App-only items (visibility "app"): their tools are for views and the host's UI, never a model's.
  const VIS_TITLE = 'the tools of app-only entities, actions and artifacts carry _meta.ui.visibility ["app"]: callable by views, never given to a model'
  const appOnly = appOnlyTools(manifest as unknown as RulesManifest)
  if (!appOnly.size) skip("mcp.visibility", VIS_TITLE, "the app has no app-only entities, actions or artifacts")
  else {
    const p: string[] = []
    for (const [name, where] of appOnly) {
      const t = byName.get(name)
      if (!t) continue // not listed to this caller
      const visibility = (t._meta?.ui as { visibility?: unknown } | undefined)?.visibility
      if (!Array.isArray(visibility) || !visibility.includes("app") || visibility.includes("model")) p.push(`${name} (${where}): _meta.ui.visibility is ${JSON.stringify(visibility)}, not ["app"]`)
    }
    if (manifest.searchTool && byName.has(manifest.searchTool)) for (const e of manifest.entities.filter((x) => x.visibility === "app" && x.searchable)) {
      const title = e.fields.find((f) => f.role === "title")
      const rows = byName.has(e.tools.list.name) ? ((await rpc("tools/call", { name: e.tools.list.name, arguments: { limit: 5 } }, token)).result?.structuredContent as { rows?: Record<string, unknown>[] } | undefined)?.rows ?? [] : []
      const row = rows.find((r) => typeof r[title?.name ?? ""] === "string" && (r[title!.name] as string).trim())
      if (!row) continue
      const found = await rpc("tools/call", { name: manifest.searchTool, arguments: { query: String(row[title!.name]).trim().slice(0, 200) } }, token)
      const results = ((found.result?.structuredContent as { results?: { id?: string }[] } | undefined)?.results ?? []) as { id?: string }[]
      if (results.some((r) => typeof r.id === "string" && r.id.startsWith(`${URI_SCHEME}://${manifest.name}/${e.name}/`))) p.push(`${manifest.searchTool}: answers with records of ${e.name}, which is app-only`)
    }
    check("mcp.visibility", VIS_TITLE, p)
  }

  // 4i. The installation's own tools (later runs, lifecycle) are listed only to the installation itself (a workspace host, no person).
  const HIDDEN_TITLE = "the installation's tools (clegra_later, clegra_installation, clegra_export, clegra_delete) are not listed to a plain caller or a person"
  const declared = [...Object.values(manifest.lifecycle ?? {}), ...((manifest.schedules ?? []).some((x) => x.name === LATER_TOOL) ? [LATER_TOOL] : [])]
  const shown = INSTALLATION_TOOLS.filter((n) => byName.has(n))
  if (!declared.length && !shown.length) skip("lifecycle.hidden", HIDDEN_TITLE, "the app has no lifecycle tools and no later runs")
  else check("lifecycle.hidden", HIDDEN_TITLE, shown.map((n) => `${n} is listed to ${clegra ? "a person" : "a plain caller"}`))
  const again = ((await rpc("tools/list", {}, token)).result?.tools ?? []) as Tool[]
  check("mcp.deterministic", "tools/list is the same on every call", JSON.stringify(again) === JSON.stringify(listed) ? null : "two calls differ")

  // 4b. Sorting (spec §3): a list orders only by a field the manifest declares sortable; any other key is refused.
  const sortProblems: string[] = []
  for (const e of manifest.entities) {
    const tool = byName.get(e.tools.list.name)
    if (!tool) continue
    const declared = new Set(e.fields.filter((f) => f.sort).map((f) => f.name))
    const offered = ((tool.inputSchema?.properties as Record<string, { enum?: unknown }> | undefined)?.sort?.enum ?? []) as unknown[]
    for (const f of offered) if (!declared.has(String(f))) sortProblems.push(`${tool.name}: offers to sort by ${String(f)}, which the manifest doesn't declare sortable`)
    const refused = await rpc("tools/call", { name: tool.name, arguments: { sort: "not_a_sortable_field" } }, token)
    if (!refused.error && refused.result?.isError !== true) sortProblems.push(`${tool.name}: accepted a sort key that is not a sortable field`)
  }
  check("mcp.sort", "a list sorts only by the fields the manifest declares sortable", sortProblems)

  // 4c. Kinds over MCP (spec §3.1, §6): neutral for an app without kinds.
  /** A tool call's text, parsed, outsiders' text unwrapped (what a model reads, as the app meant it). */
  const call = async (name: string, args: Record<string, unknown>): Promise<{ error?: string; data?: Record<string, unknown>; result?: Record<string, unknown> }> => {
    const r = await rpc("tools/call", { name, arguments: args }, token)
    if (r.error) return { error: r.error.message }
    const result = r.result ?? {}
    const content = (result.content as { type: string; text?: string }[] | undefined)?.[0]?.text ?? ""
    if (result.isError) return { error: content || "isError", result }
    try {
      return { data: unwrap(JSON.parse(content)) as Record<string, unknown>, result }
    } catch {
      return { error: `${name}: the result's text is not JSON`, result }
    }
  }
  const rowsOf = async (e: Manifest["entities"][number], args: Record<string, unknown> = {}) => {
    const r = await call(e.tools.list.name, { limit: 25, ...args })
    return { error: r.error, rows: ((r.data?.rows ?? []) as Record<string, unknown>[]).filter((x) => x && typeof x === "object") }
  }
  const kindTools = manifest.entities.filter((e) => e.kind !== undefined)
  if (!kindTools.length) skip("kinds.tools", "entity tools name their kind (description, _meta); search takes `kind` and filters by it", "no entity has a kind")
  else {
    const p: string[] = []
    for (const e of kindTools) {
      for (const ref of [e.tools.list, e.tools.get]) {
        const t = byName.get(ref.name)
        if (!t) continue
        if (!(t.description ?? "").endsWith(kindSentence(e.kind!))) p.push(`${t.name}: the description doesn't end with «${kindSentence(e.kind!)}»`)
        if (canonical(t._meta?.[META_KEY]) !== canonical({ entity: e.name, kind: e.kind })) p.push(`${t.name}: _meta.${META_KEY} is not { entity: "${e.name}", kind }`)
      }
    }
    const search = manifest.searchTool ? byName.get(manifest.searchTool) : undefined
    const searchable = kindTools.filter((e) => e.searchable && byName.has(e.tools.list.name))
    if (search && searchable.length) {
      const offered = ((search.inputSchema?.properties as Record<string, { enum?: unknown[] }> | undefined)?.kind?.enum ?? []).map(String)
      for (const k of new Set(searchable.flatMap((e) => kindsOf(e.kind)))) if (!offered.includes(k)) p.push(`${search.name}: \`kind\` doesn't offer ${k}`)
      for (const e of searchable) {
        const title = e.fields.find((f) => f.role === "title")
        const { rows } = await rowsOf(e, { limit: 5 })
        const row = rows.find((r) => typeof r[title?.name ?? ""] === "string" && (r[title!.name] as string).trim())
        const kind = row ? kindOfRecord(e.kind, row) : null
        if (!row || !kind) continue
        const query = String(row[title!.name]).trim().slice(0, 200)
        const found = await call(search.name, { query, kind })
        if (found.error) {
          p.push(`${search.name} with kind ${kind}: ${found.error}`)
          continue
        }
        const results = (found.data?.results ?? []) as { id?: string; kind?: string }[]
        for (const r of results) if (r.kind !== kind) p.push(`${search.name} with kind ${kind}: result ${r.id} has kind ${String(r.kind)}`)
        if (title?.search && !results.some((r) => r.id === row.uri)) p.push(`${search.name} with kind ${kind}: «${query}» doesn't find ${String(row.uri)}`)
        const all = await call(search.name, { query })
        for (const r of (all.data?.results ?? []) as { id?: string; kind?: string }[]) {
          const owner = manifest.entities.find((x) => typeof r.id === "string" && r.id.startsWith(`${URI_SCHEME}://${manifest.name}/${x.name}/`))
          if (owner?.kind !== undefined && !kindsOf(owner.kind).includes(String(r.kind))) p.push(`${search.name}: result ${r.id} doesn't say its kind`)
        }
      }
    }
    check("kinds.tools", "entity tools name their kind (description, _meta); search takes `kind` and filters by it", p)
  }

  const keyed = manifest.entities.flatMap((e) => e.fields.flatMap((f) => {
    const how = f.as ? keyOf(f.as, kindsOf(e.kind), manifest.kinds) : null
    return how ? [{ e, f, how }] : []
  }))
  if (!keyed.length) skip("kinds.keys", "a key is an exact list filter, compared normalised", "no field holds a key of its kind")
  else {
    const p: string[] = []
    let tried = 0
    for (const { e, f, how } of keyed) {
      if (!f.filter) {
        p.push(`${e.name}.${f.name}: a key (${f.as}) that is not a list filter`)
        continue
      }
      const tool = byName.get(e.tools.list.name)
      if (!tool) continue
      if (!(tool.inputSchema?.properties as Record<string, unknown> | undefined)?.[f.name]) continue // a field this caller can't see
      const { rows, error } = await rowsOf(e)
      if (error) {
        p.push(`${tool.name}: ${error}`)
        continue
      }
      const values = (r: Record<string, unknown>) => (Array.isArray(r[f.name]) ? (r[f.name] as unknown[]) : [r[f.name]]).filter((v): v is string => typeof v === "string" && v !== "")
      const row = rows.find((r) => values(r).some((v) => normaliseKey(v, how) !== null))
      if (!row) continue
      const value = values(row).find((v) => normaliseKey(v, how) !== null)!
      const wanted = normaliseKey(value, how)!
      // In another letter case where case doesn't count (email, vatID): the app must still find it.
      const asked = how === "lowercase" ? value.toUpperCase() : how === "uppercase-no-spaces" ? value.toLowerCase() : value
      tried++
      const found = await rowsOf(e, { [f.name]: asked })
      if (found.error) {
        p.push(`${tool.name} { ${f.name}: ${JSON.stringify(asked)} }: ${found.error}`)
        continue
      }
      if (!found.rows.some((r) => r.uri === row.uri)) p.push(`${tool.name} { ${f.name}: ${JSON.stringify(asked)} }: ${String(row.uri)} is not found by its own ${f.as}`)
      for (const r of found.rows) if (!values(r).some((v) => normaliseKey(v, how) === wanted)) p.push(`${tool.name} { ${f.name}: ${JSON.stringify(asked)} }: ${String(r.uri)} holds another ${f.as}`)
    }
    if (!tried && !p.length) skip("kinds.keys", "a key is an exact list filter, compared normalised", "no listed record holds a key value to try")
    else check("kinds.keys", "a key is an exact list filter, compared normalised", p)
  }

  const described = manifest.entities.filter((e) => e.fields.some((f) => f.as !== undefined))
  if (!described.length) skip("kinds.values", "sampled records hold values of the stated form (email, vatID, gtin, dates, address, numbers)", "no field says which property it holds")
  else {
    const p: string[] = []
    for (const e of described) {
      if (!byName.has(e.tools.list.name)) continue
      const { rows, error } = await rowsOf(e)
      if (error) {
        p.push(`${e.tools.list.name}: ${error}`)
        continue
      }
      for (const f of e.fields) {
        const def = f.as ? propertyOf(f.as, kindsOf(e.kind), manifest.kinds) : undefined
        if (!def) continue
        for (const r of rows) for (const raw of Array.isArray(r[f.name]) && f.type === "array" ? (r[f.name] as unknown[]) : [r[f.name]]) {
          // A reference reads as { id, title } (a person as { id, name }): its value is the id.
          const v = f.type !== "object" && raw && typeof raw === "object" && !Array.isArray(raw) && "id" in raw ? (raw as { id: unknown }).id : raw
          const why = valueProblem(f.as!, def, v)
          if (why) p.push(`${String(r.uri)} ${f.name} (${f.as}): ${JSON.stringify(v)} is ${why}`)
        }
      }
    }
    check("kinds.values", "sampled records hold values of the stated form (email, vatID, gtin, dates, address, numbers)", p)
  }

  // 5. Views: every ui:// a tool names is an MCP Apps document.
  const viewProblems: string[] = []
  const uris = new Set<string>()
  for (const t of listed) {
    const uri = (t._meta?.ui as { resourceUri?: string } | undefined)?.resourceUri
    if (uri) uris.add(uri)
  }
  for (const uri of uris) {
    const contents = ((await rpc("resources/read", { uri }, token)).result?.contents ?? []) as { mimeType?: string; text?: string }[]
    if (!uri.startsWith("ui://")) viewProblems.push(`${uri}: not a ui:// URI`)
    else if (contents[0]?.mimeType !== MCP_APP_MIME_TYPE || !contents[0]?.text) viewProblems.push(`${uri}: not served as ${MCP_APP_MIME_TYPE}`)
  }
  // 4d. References across apps (spec §3.2): URIs, as { uri, kind } in text, never a title beside them.
  if (!crossFields.length && !crossInputs.length) skip("refs.cross", "a reference to another app's record holds a record URI, reads as { uri, kind }, and has no refs title", "no field or input refers to records of other apps")
  else {
    const p: string[] = []
    for (const { e, f, kind } of crossFields) {
      if (!byName.has(e.tools.list.name)) continue
      const r = await call(e.tools.list.name, { limit: 25 })
      if (r.error) {
        p.push(`${e.tools.list.name}: ${r.error}`)
        continue
      }
      const refs = (r.result?.structuredContent as { refs?: Record<string, unknown> } | undefined)?.refs
      if (refs && Object.hasOwn(refs, f.name)) p.push(`${e.tools.list.name}: sends refs titles for ${f.name}, a record of another app (the host resolves it for each viewer)`)
      for (const row of (r.data?.rows ?? []) as Record<string, unknown>[]) {
        const v = row[f.name]
        if (v === undefined || v === null) continue
        const ok = v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).sort().join() === "kind,uri" && (v as { kind: unknown }).kind === kind && typeof (v as { uri: unknown }).uri === "string" && RECORD_URI.test((v as { uri: string }).uri)
        if (!ok) p.push(`${String(row.uri)} ${f.name}: ${JSON.stringify(v)} is not { uri: <a record URI>, kind: "${kind}" }`)
      }
    }
    for (const { a, k } of crossInputs) {
      const t = byName.get(a.tool.name)
      const prop = (t?.inputSchema?.properties as Record<string, { type?: unknown }> | undefined)?.[k]
      if (t && prop && prop.type !== "string") p.push(`${t.name}: input ${k} holds a record URI, a string`)
    }
    check("refs.cross", "a reference to another app's record holds a record URI, reads as { uri, kind }, and has no refs title", p)
  }

  // 4e. The resolver answers only for its own app (spec §6).
  {
    const other = manifest.name === "conformance-other" ? "conformance-another" : "conformance-other"
    const foreign = `${URI_SCHEME}://${other}/record/1`
    const r = await rpc("tools/call", { name: manifest.resolveTool, arguments: { uris: [foreign] } }, token)
    const results = ((r.result?.structuredContent as { results?: { uri?: string; state?: string }[] } | undefined)?.results ?? []) as { uri?: string; state?: string }[]
    check("resolve.foreign", "the resolver answers not_found for another app's URI", r.error ? r.error.message : r.result?.isError ? "the resolver failed" : results[0]?.state === "not_found" ? null : `state ${String(results[0]?.state)} for ${foreign}`)
  }

  check("mcp.views", "every view a tool names is served as an MCP Apps document", viewProblems)

  // 4f. Records are named by their title (spec §6 rule 10): beside each URI in what a model reads, and in what an action
  // on a record takes, so a client's own approval prompt can say which record (the app never trusts that hint).
  {
    const p: string[] = []
    for (const e of manifest.entities) {
      if (!byName.has(e.tools.list.name)) continue
      const { error, rows } = await rowsOf(e)
      if (error) p.push(`${e.tools.list.name}: ${error}`)
      for (const row of rows) if (typeof row.uri !== "string" || typeof row.title !== "string") p.push(`${e.tools.list.name}: a row without its uri and title (${JSON.stringify(row).slice(0, 80)})`)
      const first = rows[0]
      if (first && typeof first.uri === "string" && byName.has(e.tools.get.name)) {
        const id = first.uri.split("/").pop() ?? ""
        const one = await call(e.tools.get.name, { id: decodeURIComponent(id) })
        // Whether the listed record is found again is not this check's question; its text's title is.
        if (!one.error && (typeof one.data?.title !== "string" || one.data.title !== first.title)) p.push(`${e.tools.get.name}: the record's text doesn't carry the title its list gave`)
      }
    }
    for (const a of manifest.actions) {
      const t = a.entity ? byName.get(a.tool.name) : undefined
      if (!t) continue
      const props = (t.inputSchema?.properties ?? {}) as Record<string, { type?: unknown; description?: unknown }>
      const required = new Set((t.inputSchema?.required ?? []) as string[])
      if (props.id?.type !== "string" || !required.has("id")) p.push(`${t.name}: the record's id is a required string`)
      if (props.record_title?.type !== "string" || required.has("record_title")) p.push(`${t.name}: record_title is an optional string (the record's title, a display hint)`)
    }
    check("mcp.titles", "a model reads each record's title beside its URI; an action on a record takes id and an optional record_title", p)
  }

  // 4g. What the generated view calls is callable from a view (MCP Apps `_meta.ui.visibility` with "app", or omitted).
  {
    const p: string[] = []
    const viewCalls = [...manifest.entities.flatMap((e) => [e.tools.list, e.tools.get]), ...manifest.actions.map((a) => a.tool), ...manifest.pages.filter((x) => x.kind !== "record").map((x) => x.tool)]
    for (const ref of viewCalls) {
      const t = byName.get(ref.name)
      const visibility = (t?._meta?.ui as { visibility?: unknown } | undefined)?.visibility
      if (t && visibility !== undefined && !(Array.isArray(visibility) && visibility.includes("app"))) p.push(`${t.name}: _meta.ui.visibility ${JSON.stringify(visibility)} leaves out "app": a view's call to it is refused`)
    }
    check("mcp.app-callable", "the tools a view calls (lists, records, actions, pages) are callable from views", p)
  }

  // 5c. The site ticket (spec §5.1): one minute, for one path and one client origin, single use, exchanged only by a
  // frame posting it from that origin, for a partitioned, HttpOnly session cookie of the whole site and a 303 to the path.
  const TICKET_TITLE = "a site ticket is short, single-use, bound to its client origin, and opens a partitioned session cookie for the site"
  const site = manifest.site
  if (!site) skip("site.ticket", TICKET_TITLE, "the app has no site")
  else if (!clegra) skip("site.ticket", TICKET_TITLE, "only a person's own Clegra app token gets site tickets")
  else if (!clegra.clientOrigin) skip("site.ticket", TICKET_TITLE, "no client origin given (clegra.clientOrigin)")
  else if (!byName.has(site.tool.name)) check("site.ticket", TICKET_TITLE, `${site.tool.name} is not listed to a person`)
  else {
    const tp: string[] = []
    const appOrigin = manifest.auth.resource ? new URL(manifest.auth.resource).origin : origin
    const frameOrigin = clegra.clientOrigin
    const ask = async (o: string, path?: string) => {
      const r = await rpc("tools/call", { name: site.tool.name, arguments: { origin: o, ...(path ? { path } : {}) } }, token)
      const result = r.result as { isError?: boolean; structuredContent?: { action?: string; field?: string; ticket?: string; path?: string } } | undefined
      return result?.isError || !result?.structuredContent?.ticket ? null : result.structuredContent
    }
    const post = (t: { action?: string; field?: string; ticket?: string }, o: string, dest = "iframe") =>
      doFetch(new Request(t.action!, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", origin: o, "sec-fetch-dest": dest }, body: new URLSearchParams({ [t.field ?? "ticket"]: t.ticket! }) }))
    const first = await ask(frameOrigin)
    if (!first) tp.push(`${site.tool.name} gave no ticket for origin ${frameOrigin}`)
    else {
      if (first.action !== `${appOrigin}${SITE_PATH}`) tp.push(`the ticket is posted to ${first.action}, not ${appOrigin}${SITE_PATH}`)
      if (first.path !== site.start) tp.push(`without a path the ticket opens ${first.path}, not the site's start ${site.start}`)
      try {
        const [h, p] = first.ticket!.split(".")
        const header = JSON.parse(Buffer.from(h!, "base64url").toString()) as { alg?: string; typ?: string }
        const claims = JSON.parse(Buffer.from(p!, "base64url").toString()) as { exp?: number; iat?: number; jti?: string; origin?: unknown }
        if (header.typ !== SITE_TICKET_TYPE || !header.alg || header.alg === "none") tp.push(`ticket header ${JSON.stringify(header)}`)
        if (typeof claims.exp !== "number" || typeof claims.iat !== "number" || claims.exp - claims.iat > SITE_TICKET_SECONDS) tp.push("the ticket lives longer than a minute (or has no exp/iat)")
        if (!claims.jti) tp.push("the ticket has no jti (single use)")
        if (claims.origin !== frameOrigin) tp.push("the ticket does not name the framing origin")
      } catch {
        tp.push("the ticket is not a JWT")
      }
      if (await ask(`https://${PROTOCOL_ID}-check.invalid`)) tp.push("a ticket was issued for an origin that is not a client origin")
      if (await ask(frameOrigin, "//elsewhere.invalid/")) tp.push("a ticket was issued for a path that leaves the site (//…)")
      const elsewhere = await post(first, `https://${PROTOCOL_ID}-check.invalid`)
      if (elsewhere.status < 400 || elsewhere.headers.get("set-cookie")) tp.push(`a ticket posted from another origin answers ${elsewhere.status}`)
      const ok = await post(first, frameOrigin)
      const cookies = (ok.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() ?? [ok.headers.get("set-cookie") ?? ""]
      if (ok.status !== 303) tp.push(`the exchange answers ${ok.status}, not 303`)
      const location = ok.headers.get("location") ?? ""
      if (new URL(location, `${appOrigin}/`).href !== new URL(site.start, appOrigin).href) tp.push(`the exchange redirects to ${location || "nowhere"}, not to ${site.start}`)
      for (const name of [SITE_COOKIE, SITE_MARKER_COOKIE]) {
        const cookie = cookies.find((c) => c.startsWith(`${name}=`))
        if (!cookie) {
          tp.push(`the exchange sets no ${name} cookie`)
          continue
        }
        const attributes = cookie.split(";").map((a) => a.trim().toLowerCase())
        for (const a of ["secure", "httponly", "samesite=none", "partitioned", "path=/"]) if (!attributes.includes(a)) tp.push(`${name} lacks ${a}`)
        if (attributes.some((a) => a.startsWith("domain="))) tp.push(`${name} sets Domain`)
      }
      if (ok.headers.get("referrer-policy") !== "no-referrer") tp.push("the exchange has no Referrer-Policy: no-referrer")
      const again = await post(first, frameOrigin)
      if (again.status < 400 || again.headers.get("set-cookie")) tp.push(`a used ticket answers ${again.status} (single use)`)
      const top = await ask(frameOrigin)
      if (top) {
        const r = await post(top, frameOrigin, "document")
        if (r.status < 400 || r.headers.get("set-cookie")) tp.push(`a ticket posted by a top-level page answers ${r.status} (frames only)`)
      }
    }
    check("site.ticket", TICKET_TITLE, tp)
  }

  // 4j. Sensitive writes (spec §7, «Confirmation»): a Clegra caller's call of a write whose `confirm` is "always" never
  // runs without the person's confirmation; for an agent, a core confirmation of other arguments is refused and the
  // confirmation of its own arguments, with the device's proof, is taken. Called with sample arguments (each required
  // input from its schema, the record of an action on one from its list): a call they don't fit is not counted.
  const CONFIRM_TITLE = "a Clegra caller's write that asks for confirmation runs only with it (for an agent: the core's confirmation of exactly these arguments, with the device's proof)"
  const sensitive = manifest.actions.filter((a) => !a.readOnly && a.confirm === "always" && byName.has(a.tool.name))
  if (!clegra) skip("mcp.confirm", CONFIRM_TITLE, "not a Clegra caller (a plain client relies on destructiveHint or elicitation)")
  else if (!sensitive.length) skip("mcp.confirm", CONFIRM_TITLE, "no write that asks for confirmation is listed to this caller")
  else {
    const p: string[] = []
    let tried = 0
    const codeOf = (r: Awaited<ReturnType<typeof rpc>>): string | null => (r.error ? `error ${r.error.message}` : ((r.result?.structuredContent as { error?: { code?: string } } | undefined)?.error?.code ?? (r.result?.isError ? "isError" : null)))
    const attempt = (name: string, args: Record<string, unknown>, meta?: Record<string, unknown>) => rpc("tools/call", { name, arguments: args, ...(meta ? { _meta: { [META_KEY]: meta } } : {}) }, token)
    for (const a of sensitive) {
      const tool = byName.get(a.tool.name)!
      const args = (sampleOf(tool.inputSchema) ?? {}) as Record<string, unknown>
      if (a.entity) {
        const e = manifest.entities.find((x) => x.name === a.entity)
        const first = e && byName.has(e.tools.list.name) ? (await rowsOf(e, { limit: 1 })).rows[0] : undefined
        if (typeof first?.uri !== "string") continue
        args.id = decodeURIComponent(first.uri.split("/").pop() ?? "")
      }
      const bare = codeOf(await attempt(tool.name, args))
      if (bare === "invalid_input" || bare === "not_found" || bare === "permission_denied") continue
      tried++
      if (bare !== "confirmation_required") {
        p.push(`${tool.name}: ${bare === null ? "ran" : `answered ${bare}`} without a confirmation`)
        continue
      }
      if (!clegra.confirmation) continue
      const other = codeOf(await attempt(tool.name, args, { confirmation: await clegra.confirmation({ tool: tool.name, args: { ...args, conformance_other_arguments: true } }) }))
      if (other !== "confirmation_required") p.push(`${tool.name}: ${other === null ? "ran" : `answered ${other}`} with a confirmation of other arguments`)
      const right = codeOf(await attempt(tool.name, args, { confirmation: await clegra.confirmation({ tool: tool.name, args }) }))
      if (right === "confirmation_required") p.push(`${tool.name}: refused the core's confirmation of its own arguments`)
    }
    if (!tried && !p.length) skip("mcp.confirm", CONFIRM_TITLE, "no sensitive write takes the sample arguments")
    else check("mcp.confirm", CONFIRM_TITLE, p)
  }

  // 6. The manifest is also one MCP resource, identical to the file.
  const resources = ((await rpc("resources/list", {}, token)).result?.resources ?? []) as { uri: string; mimeType?: string }[]
  const asResource = resources.find((r) => r.mimeType === "application/json" && r.uri === `${URI_SCHEME}://${manifest.name}`)
  let same = false
  if (asResource) {
    const contents = ((await rpc("resources/read", { uri: asResource.uri }, token)).result?.contents ?? []) as { text?: string }[]
    try {
      same = JSON.stringify(JSON.parse(contents[0]?.text ?? "null")) === JSON.stringify(manifest)
    } catch {}
  }
  check("mcp.manifest", "the manifest is one MCP resource, identical to the well-known file", !asResource ? "no manifest resource listed" : same ? null : "the resource differs from the file")
  return done()
}

export function formatReport(report: Report): string {
  const verdict = !report.ok ? "NOT conformant." : report.complete ? "Conformant." : "Incomplete: the public checks pass, the MCP checks did not run. Not a conformance result: give a plain caller's token (--token) or a Clegra caller."
  return [...report.checks.map((c) => `${c.skipped ? "SKIP" : c.ok ? "PASS" : "FAIL"}  ${c.id} — ${c.title}${c.detail ? `\n      ${c.detail}` : ""}`), verdict].join("\n")
}
