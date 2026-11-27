/**
 * `clegra check`: the conformance check of a running app against the extensions (docs/extensions). A level is what
 * this check finds, never a claim: A (web map), B1 (confirmed actions), B2 (hardened access), C (one sign-in), and the
 * add-ons (app-share, app agents, event types). It speaks MCP 2026-07-28 over plain HTTP with the tokens it is given,
 * and never changes anything: it confirms nothing, runs no confirmed call and completes no session transfer.
 */

export type Level = "A" | "B1" | "B2" | "C" | "add-on"

export type Check = {
  id: string
  level: Level
  ok: boolean | "skipped"
  message: string
  /** A skipped optional check does not keep its level from being reached (nothing there to check). */
  optional?: boolean
}

export type Report = {
  url: string
  mcpUrl: string
  /** The origin the web map declares (and this check proved), or the MCP endpoint's. */
  origin: string
  checks: Check[]
  /** The levels reached: A, then B1 and B2 on top of it; C on top of A. */
  levels: ("A" | "B1" | "B2" | "C")[]
  /** The checked URL is http on a loopback name (a local stack): same-origin http counted where https is required. */
  localHttp: boolean
  /** No check failed. */
  ok: boolean
}

export type CheckOptions = {
  /** The app's origin (its MCP server at `/mcp`) or its MCP URL. */
  url: string
  /** An access token of the app's own sign-in for a test person, with the scopes to check (all, for level C). */
  token: string
  /** A token with only `web.read`: the step-up check (B2). */
  readToken?: string
  /** A call of a tool the app confirms, with real arguments: the B1 checks ask for it and never run it. */
  confirmCall?: { tool: string; arguments: Record<string, unknown> }
  fetch?: (input: string, init?: RequestInit) => Promise<Response>
}

const PROTOCOL = "2026-07-28"
const WEB_MAP = "com.clegra/web-map"
const APP_SHARE = "com.clegra/app-share"
const SESSION = "com.clegra/session-transfer"
const SKILLS = "io.modelcontextprotocol/skills"
const EVENTS = "io.modelcontextprotocol/events"
const CARD_KEYS = new Set(["$schema", "name", "title", "description", "version", "icons", "remotes"])
const CARD_TYPE = "application/mcp-server-card+json"
const CARD_SCHEMA = "https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json"
const CATALOG_TYPE = "application/ai-catalog+json"

type Json = Record<string, unknown>
type Tool = { name: string; inputSchema?: Json; annotations?: Json; _meta?: Json }
type Rpc = { status: number; headers: Headers; result?: Json; error?: { code: number; message: string } }

const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v)
/** The loopback names of a local stack, the sign-in's development rule: localhost, one label under .localhost, 127.0.0.1, [::1]. */
const LOOPBACK = /^(localhost|[a-z0-9-]+\.localhost|127\.0\.0\.1|\[::1\])$/i

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`
  if (isObj(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`
  return JSON.stringify(v) ?? "null"
}

/** Every variable of a URI Template (path and query expressions). */
function vars(template: string): string[] {
  return [...template.matchAll(/\{[?&]?([A-Za-z0-9_.,]+)\}/g)].flatMap((m) => m[1]!.split(","))
}

/** The path variables only: a query expression ({?a}) expands without its variables, so it never blocks a page. */
function pathVars(template: string): string[] {
  return [...template.matchAll(/\{([A-Za-z0-9_.,]+)\}/g)].flatMap((m) => m[1]!.split(","))
}

/** A template filled with placeholders, as a URL (null when it is not one). */
function sample(template: string): URL | null {
  try {
    return new URL(template.replace(/\{[?&][^}]*\}/g, "").replace(/\{[^}]*\}/g, "x"))
  } catch {
    return null
  }
}

/**
 * Whether a URL (or template) is https and on `origin` (ORG-2). `localHttp` (the checked URL is http on a loopback
 * name): http counts too, on that same origin only.
 */
export function onOriginRule(template: string, origin: string, localHttp: boolean): boolean {
  const u = sample(template)
  if (!u) return false
  if (u.protocol !== "https:" && !(localHttp && u.protocol === "http:" && LOOPBACK.test(u.hostname))) return false
  return u.origin === origin
}

function randomB64url(bytes: number): string {
  const b = crypto.getRandomValues(new Uint8Array(bytes))
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

export async function checkApp(options: CheckOptions): Promise<Report> {
  const doFetch = options.fetch ?? ((input: string, init?: RequestInit) => fetch(input, init))
  const given = new URL(options.url)
  const mcpUrl = given.pathname === "/" || given.pathname === "" ? `${given.origin}/mcp` : `${given.origin}${given.pathname.replace(/\/+$/, "")}`
  const mcpOrigin = given.origin
  // A local stack (http on a loopback name): the sign-in's development rule, same-origin http counts. Anything else: https.
  const localHttp = given.protocol === "http:" && LOOPBACK.test(given.hostname)
  const onOrigin = (template: string, origin: string) => onOriginRule(template, origin, localHttp)
  const mcpPath = new URL(mcpUrl).pathname
  const checks: Check[] = []
  const add = (level: Level, id: string, ok: boolean | "skipped", message: string, optional = false) => checks.push({ id, level, ok, message, ...(optional ? { optional } : {}) })
  let id = 0

  async function rpc(method: string, params: Json = {}, o: { token?: string | null; elicitation?: boolean; name?: string } = {}): Promise<Rpc> {
    const token = o.token === undefined ? options.token : o.token
    const { _meta: extra, ...rest } = params as { _meta?: Json }
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: ++id,
      method,
      params: {
        ...rest,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": PROTOCOL,
          "io.modelcontextprotocol/clientInfo": { name: "clegra-check", version: "1.0.0" },
          "io.modelcontextprotocol/clientCapabilities": { ...(o.elicitation === false ? {} : { elicitation: { url: {} } }), extensions: { [WEB_MAP]: { revision: "0.2" }, [APP_SHARE]: { revision: "0.1" }, [SKILLS]: {}, [EVENTS]: {} } },
          ...(extra ?? {}),
        },
      },
    })
    const name = o.name ?? (typeof params.name === "string" ? params.name : typeof params.uri === "string" ? params.uri : undefined)
    const response = await doFetch(mcpUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": PROTOCOL,
        "mcp-method": method,
        ...(name ? { "mcp-name": name } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body,
    })
    const raw = await response.text()
    if (response.status !== 200) return { status: response.status, headers: response.headers }
    let json: Json = {}
    try {
      json = response.headers.get("content-type")?.includes("text/event-stream")
        ? JSON.parse(raw.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).filter(Boolean).pop() ?? "{}")
        : JSON.parse(raw)
    } catch {
      return { status: response.status, headers: response.headers, error: { code: -1, message: "not JSON" } }
    }
    return { status: 200, headers: response.headers, ...(isObj(json.result) ? { result: json.result } : {}), ...(isObj(json.error) ? { error: json.error as Rpc["error"] } : {}) }
  }
  const getJson = async (url: string, headers: Record<string, string> = {}) => {
    const r = await doFetch(url, { headers })
    let body: unknown = null
    try {
      body = await r.json()
    } catch {}
    return { r, body }
  }
  const readJson = async (uri: string): Promise<unknown> => {
    const r = await rpc("resources/read", { uri })
    const text = (r.result?.contents as { text?: string }[] | undefined)?.[0]?.text
    if (r.error || typeof text !== "string") throw new Error(r.error?.message ?? `status ${r.status}`)
    return JSON.parse(text)
  }
  const attempt = async (level: Level, checkId: string, fn: () => Promise<unknown>) => {
    try {
      await fn()
    } catch (error) {
      add(level, checkId, false, `failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // ---------------------------------------------------------------- A: discovery, the card, authorization
  const cardUrl = `${mcpUrl}/server-card`
  await attempt("A", "A.server-card", async () => {
    const { r, body } = await getJson(cardUrl, { accept: CARD_TYPE })
    const problems: string[] = []
    if (r.status !== 200) problems.push(`status ${r.status}`)
    if (!(r.headers.get("content-type") ?? "").startsWith(CARD_TYPE)) problems.push(`media type ${r.headers.get("content-type")}`)
    if (!isObj(body)) problems.push("not a JSON object")
    else {
      const extra = Object.keys(body).filter((k) => !CARD_KEYS.has(k))
      if (extra.length) problems.push(`more than $schema, name, title, description, version, icons and remotes: ${extra.join(", ")} (ORG-5)`)
      if (body.$schema !== CARD_SCHEMA) problems.push(`$schema is not ${CARD_SCHEMA}`)
      for (const k of ["name", "version", "description"]) if (typeof body[k] !== "string" || !body[k]) problems.push(`no ${k}`)
      if (!Array.isArray(body.remotes) || !body.remotes.some((x) => isObj(x) && x.url === mcpUrl)) problems.push(`no remote at ${mcpUrl}`)
    }
    add("A", "A.server-card", problems.length === 0, problems.length ? problems.join("; ") : `${cardUrl}: only what is public`)
  })

  const unauth = await rpc("server/discover", {}, { token: null })
  add("A", "A.unauthenticated", unauth.status === 401 && /resource_metadata=/.test(unauth.headers.get("www-authenticate") ?? ""), unauth.status === 401 ? "401 with resource_metadata" : `status ${unauth.status}, expected 401 with WWW-Authenticate resource_metadata`)

  const prmUrl = `${mcpOrigin}/.well-known/oauth-protected-resource${mcpPath}`
  let prm: Json | null = null
  await attempt("A", "A.protected-resource", async () => {
    const { r, body } = await getJson(prmUrl)
    prm = isObj(body) ? body : null
    const ok = r.status === 200 && isObj(body) && body.resource === mcpUrl && Array.isArray(body.authorization_servers) && body.authorization_servers.length > 0
    add("A", "A.protected-resource", ok, ok ? `${prmUrl}: resource ${mcpUrl}` : `${prmUrl}: status ${r.status}, needs resource = ${mcpUrl} and authorization_servers`)
  })

  const discover = await rpc("server/discover")
  const extensions = (isObj(discover.result?.capabilities) ? (discover.result!.capabilities as Json).extensions : undefined) as Record<string, Json> | undefined
  const map = extensions?.[WEB_MAP]
  const declared = isObj(map) && typeof map.origin === "string" ? String(map.origin) : null
  let origin = mcpOrigin
  if (!isObj(map) || map.revision !== "0.2" || !declared) {
    add("A", "A.web-map", false, discover.status !== 200 ? `server/discover: status ${discover.status}` : `server/discover does not declare ${WEB_MAP} revision "0.2" with an origin`)
  } else {
    let proven = declared === mcpOrigin
    let how = "the MCP endpoint's own origin"
    // ORG-1: the AI Catalog at the declared origin lists a Server Card whose remote is this MCP URL.
    // The AI Catalog v0.9: `application/ai-catalog+json`, `specVersion`, and an entry of the Server Card's type whose
    // `url` is this card, or whose inline `data` is a card with this remote.
    const { r, body } = await getJson(`${declared}/.well-known/ai-catalog.json`, { accept: CATALOG_TYPE }).catch(() => ({ r: null, body: null }))
    const entries = isObj(body) && typeof body.specVersion === "string" && Array.isArray(body.entries) ? body.entries.filter(isObj) : []
    const listsCard = entries.some(
      (e) =>
        e.type === CARD_TYPE &&
        typeof e.identifier === "string" &&
        (e.url === cardUrl || (isObj(e.data) && Array.isArray(e.data.remotes) && e.data.remotes.some((x) => isObj(x) && x.url === mcpUrl))),
    )
    const catalogType = (r?.headers.get("content-type") ?? "").startsWith(CATALOG_TYPE)
    const inCatalog = r?.status === 200 && catalogType && listsCard
    if (!proven && inCatalog) {
      proven = true
      how = "listed by its AI Catalog"
    }
    if (proven) origin = declared
    add("A", "A.web-map", proven, proven ? `origin ${declared} (${how})` : `origin ${declared} is neither the endpoint's (${mcpOrigin}) nor proven by ${declared}/.well-known/ai-catalog.json (ORG-1)`)
    const catalogProblem = r?.status !== 200 ? `status ${r?.status ?? "no answer"}` : !catalogType ? `media type ${r.headers.get("content-type")}, not ${CATALOG_TYPE}` : !entries.length ? "no specVersion and entries" : `no entry of type ${CARD_TYPE} for ${cardUrl}`
    add("A", "A.ai-catalog", inCatalog, inCatalog ? `${declared}/.well-known/ai-catalog.json lists the Server Card` : `${declared}/.well-known/ai-catalog.json: ${catalogProblem}`)
  }

  // ---------------------------------------------------------------- A: tools, records, pages
  const toolsAnswer = await rpc("tools/list")
  const tools = ((toolsAnswer.result?.tools ?? []) as Tool[]).filter((t) => isObj(t))
  const toolNames = new Set(tools.map((t) => t.name))
  const propsOf = (t: Tool) => Object.keys(isObj(t.inputSchema?.properties) ? (t.inputSchema!.properties as Json) : {})
  const unannotated = tools.filter((t) => !isObj(t.annotations) || typeof t.annotations.readOnlyHint !== "boolean")
  add("A", "A.annotations", toolsAnswer.status === 200 && unannotated.length === 0, toolsAnswer.status !== 200 ? `tools/list: status ${toolsAnswer.status}` : unannotated.length ? `no readOnlyHint on: ${unannotated.map((t) => t.name).join(", ")}` : `${tools.length} tools, each with its annotations`)

  const templatesAnswer = await rpc("resources/templates/list")
  const templates = ((templatesAnswer.result?.resourceTemplates ?? []) as { uriTemplate: string; name: string; _meta?: Json }[]).filter((t) => isObj(t))
  const records = templates.map((t) => ({ t, record: isObj(t._meta?.[WEB_MAP]) && isObj((t._meta![WEB_MAP] as Json).record) ? ((t._meta![WEB_MAP] as Json).record as Json) : null })).filter((x) => x.record)
  const recordOf = (entity: unknown) => records.find((x) => x.record!.entity === entity)
  {
    const problems: string[] = []
    for (const { t, record } of records) {
      if (!onOrigin(t.uriTemplate, origin)) problems.push(`${t.name}: ${t.uriTemplate} is not on ${origin} (ORG-2)`)
      if (!isObj(record!.card) || typeof (record!.card as Json).title !== "string") problems.push(`${t.name}: no card.title (REC-4)`)
      for (const k of ["get", "list"] as const) if (record![k] !== undefined && !toolNames.has(String(record![k]))) problems.push(`${t.name}: ${k} "${String(record![k])}" is not a tool`)
    }
    add("A", "A.records", templatesAnswer.status === 200 && problems.length === 0, problems.length ? problems.join("; ") : `${records.length} record templates on ${origin}`)
  }
  {
    const problems: string[] = []
    let n = 0
    for (const t of tools) {
      const m = t._meta?.[WEB_MAP]
      if (!isObj(m)) continue
      n++
      const props = propsOf(t)
      if (m.on !== undefined && m.on !== "record" && m.on !== "collection") problems.push(`${t.name}: on "${String(m.on)}"`)
      if (m.on === "record" && !props.includes(String(m.recordArg ?? "id"))) problems.push(`${t.name}: recordArg "${String(m.recordArg ?? "id")}" is not an input (MAP-3)`)
      if (typeof m.page === "string") {
        if (!onOrigin(m.page, origin)) problems.push(`${t.name}: page ${m.page} is not on ${origin} (ORG-2)`)
        const recordVars = m.on === "record" ? vars(recordOf(m.entity)?.t.uriTemplate ?? "") : []
        for (const v of pathVars(m.page)) if (!props.includes(v) && !recordVars.includes(v)) problems.push(`${t.name}: page variable {${v}} cannot be filled (MAP-2)`)
      }
      if (m.entity !== undefined && !recordOf(m.entity)) problems.push(`${t.name}: entity "${String(m.entity)}" has no record template`)
    }
    add("A", "A.tool-map", problems.length === 0, problems.length ? problems.join("; ") : `${n} tools carry a well-formed web map`)
  }
  const irreversible = tools.filter((t) => t.annotations?.readOnlyHint === false && (t.annotations?.openWorldHint === true || t.annotations?.destructiveHint !== false))
  add("A", "A.irreversible", true, irreversible.length ? `these writes reach outside or destroy, so the app confirms them if they cannot be put back (B1): ${irreversible.map((t) => t.name).join(", ")}` : "no write reaches outside or destroys", true)

  let pages: Json[] = []
  await attempt("A", "A.pages", async () => {
    const body = await readJson("webmap://pages")
    if (!isObj(body) || !Array.isArray(body.pages)) throw new Error("webmap://pages is not { pages: [...] }")
    pages = body.pages.filter(isObj)
    const problems = pages.filter((p) => typeof p.url !== "string" || !onOrigin(p.url, origin) || typeof p.name !== "string" || typeof p.role !== "string").map((p) => `${String(p.name)}: ${String(p.url)}`)
    add("A", "A.pages", problems.length === 0, problems.length ? `pages not on ${origin} or incomplete: ${problems.join(", ")}` : `${pages.length} pages for this person, all on ${origin}`)
  })
  const resourcesAnswer = await rpc("resources/list")
  const resources = ((resourcesAnswer.result?.resources ?? []) as { uri: string; _meta?: Json }[]).filter(isObj)
  {
    const webResources = resources.filter((r) => typeof r.uri === "string" && r.uri.startsWith(`${origin}/`))
    add("A", "A.no-page-resources", resourcesAnswer.status === 200 && webResources.length === 0, webResources.length ? `resources/list lists web URLs: ${webResources.map((r) => r.uri).join(", ")} (pages are not resources)` : "no page is an MCP resource")
  }
  {
    const badges = [...new Set(pages.map((p) => p.badge).filter((b): b is string => typeof b === "string"))]
    const widgets = resources.filter((r) => isObj(r._meta?.[WEB_MAP]) && isObj((r._meta![WEB_MAP] as Json).widget))
    const problems: string[] = []
    for (const b of badges) {
      try {
        const v = await readJson(b)
        if (!isObj(v) || typeof v.value !== "number") problems.push(`${b}: not { value: number }`)
      } catch (e) {
        problems.push(`${b}: ${(e as Error).message}`)
      }
    }
    for (const w of widgets) {
      try {
        const v = await readJson(w.uri)
        if (!isObj(v) || typeof v.title !== "string") problems.push(`${w.uri}: a tile needs a title`)
        else {
          // The tile's URI is a resource URI (any scheme, read on this server); its links are navigable (ORG-2).
          const links = [v.url, ...(Array.isArray(v.rows) ? v.rows.filter(isObj).map((r) => r.url) : [])].filter((u) => u !== undefined)
          for (const u of links) if (typeof u !== "string" || !onOrigin(u, origin)) problems.push(`${w.uri}: link ${String(u)} is not on ${origin} (ORG-2)`)
        }
      } catch (e) {
        problems.push(`${w.uri}: ${(e as Error).message}`)
      }
    }
    if (!badges.length && !widgets.length) add("A", "A.badges-widgets", "skipped", "no badge or widget", true)
    else add("A", "A.badges-widgets", problems.length === 0, problems.length ? problems.join("; ") : `${badges.length} badges and ${widgets.length} widgets readable`)
  }
  await attempt("A", "A.record-round-trip", async () => {
    const withList = records.find((x) => typeof x.record!.list === "string")
    if (!withList) return add("A", "A.record-round-trip", "skipped", "no record template names a list tool", true)
    const listed = await rpc("tools/call", { name: String(withList.record!.list), arguments: {} })
    const links = ((listed.result?.content ?? []) as { type?: string; uri?: string }[]).filter((c) => c.type === "resource_link" && typeof c.uri === "string" && c.uri.startsWith(`${origin}/`))
    let uri = links[0]?.uri
    if (!uri) {
      // A list that returns rows as data: the first row filled into the record's template.
      const rows = (listed.result?.structuredContent as { rows?: Json[] } | undefined)?.rows
      const row = Array.isArray(rows) ? rows.find(isObj) : undefined
      const names = vars(withList.t.uriTemplate)
      if (row && names.every((n) => row[n] !== undefined)) uri = withList.t.uriTemplate.replace(/\{([^}]+)\}/g, (_a, n: string) => encodeURIComponent(String(row[n])))
    }
    if (!uri) return add("A", "A.record-round-trip", "skipped", `${String(withList.record!.list)} returned no record to read`, true)
    const viaMcp = await readJson(uri)
    const r = await doFetch(uri, { headers: { authorization: `Bearer ${options.token}`, accept: "application/json" } })
    const problems: string[] = []
    if (r.status !== 200) problems.push(`bearer GET ${uri}: status ${r.status}`)
    else {
      if (!/authorization/i.test(r.headers.get("vary") ?? "")) problems.push("no Vary: Authorization")
      if (!/private|no-store/.test(r.headers.get("cache-control") ?? "")) problems.push("Cache-Control is not private")
      const viaWeb = await r.json().catch(() => null)
      if (canonical(viaWeb) !== canonical(viaMcp)) problems.push("the bearer GET and resources/read differ")
    }
    const bad = await doFetch(uri, { headers: { authorization: "Bearer clegra-check-invalid-token", accept: "application/json" } })
    if (bad.status !== 401 || !bad.headers.get("www-authenticate")) problems.push(`an invalid bearer got ${bad.status}, expected 401 with WWW-Authenticate`)
    add("A", "A.record-round-trip", problems.length === 0, problems.length ? problems.join("; ") : `${uri}: resources/read = bearer GET; an invalid token gets 401 (REC-1)`)
  })

  // ---------------------------------------------------------------- B1: the app's own confirmation
  const call = options.confirmCall
  if (!call) {
    add("B1", "B1.confirmation", "skipped", "give --confirm-call with a tool the app confirms (it is asked for, never run)")
  } else {
    await attempt("B1", "B1.url-elicitation", async () => {
      const first = await rpc("tools/call", { name: call.tool, arguments: call.arguments })
      const r = first.result ?? {}
      const asks = isObj(r.inputRequests) ? Object.entries(r.inputRequests as Json) : []
      const url = asks.map(([, a]) => (isObj(a) && isObj(a.params) && a.params.mode === "url" ? String(a.params.url) : null)).find(Boolean)
      const ok = r.resultType === "input_required" && typeof url === "string" && onOrigin(url, origin) && typeof r.requestState === "string"
      add("B1", "B1.url-elicitation", ok, ok ? `input_required with a URL-mode elicitation on ${origin}` : `expected input_required with a URL elicitation on ${origin}, got ${JSON.stringify(r).slice(0, 200)}`)
      if (!ok) return
      const key = asks[0]![0]
      const retry = await rpc("tools/call", { name: call.tool, arguments: call.arguments, inputResponses: { [key]: { action: "accept" } }, requestState: r.requestState })
      const still = retry.result?.resultType === "input_required"
      add("B1", "B1.accept-alone", still, still ? "accept alone did not run it (CNF-1)" : `accept alone answered ${JSON.stringify(retry.result ?? retry.error).slice(0, 200)} (CNF-1: it must not run)`)
      const page = await doFetch(String(url), { redirect: "manual" })
      const html = page.status === 200 ? await page.text() : ""
      const formShown = /name="decision"|type="submit"/.test(html) && page.status === 200
      const csp = page.headers.get("content-security-policy") ?? ""
      const framed = page.status >= 300 && page.status < 400 ? true : /frame-ancestors 'none'/.test(csp)
      add("B1", "B1.page", !formShown && framed, formShown ? "the confirmation page shows its form without a session" : !framed ? "the confirmation page does not send frame-ancestors 'none'" : `without a session the page answers ${page.status} (sign-in first; never framed)`)
    })
    await attempt("B1", "B1.fallback", async () => {
      const r = await rpc("tools/call", { name: call.tool, arguments: call.arguments }, { elicitation: false })
      const error = (r.result?.structuredContent as { error?: Json } | undefined)?.error
      const link = ((r.result?.content ?? []) as { type?: string; uri?: string }[]).some((c) => c.type === "resource_link" && isObj(error) && c.uri === error.url)
      const ok = r.result?.isError === true && isObj(error) && error.code === "confirmation_required" && typeof error.url === "string" && typeof error.expiresAt === "string" && link
      add("B1", "B1.fallback", ok, ok ? "confirmation_required with url, expiresAt and a resource_link (CNF-8)" : `expected confirmation_required with url, expiresAt and a resource_link, got ${JSON.stringify(r.result ?? r.error).slice(0, 200)}`)
    })
  }

  // ---------------------------------------------------------------- B2: hardened access
  const scopes = Array.isArray((prm as Json | null)?.scopes_supported) ? ((prm as unknown as Json).scopes_supported as string[]) : []
  const missing = ["web.read", "web.write", "web.irreversible"].filter((s) => !scopes.includes(s))
  add("B2", "B2.scopes", missing.length === 0, missing.length ? `the protected-resource metadata does not list ${missing.join(", ")}` : "web.read, web.write and web.irreversible offered")
  await attempt("B2", "B2.authorization-server", async () => {
    const issuer = (prm as Json | null)?.authorization_servers
    const first = Array.isArray(issuer) ? String(issuer[0]) : null
    if (!first) return add("B2", "B2.authorization-server", false, "no authorization server named")
    const u = new URL(first)
    const path = u.pathname.replace(/\/+$/, "")
    let meta: unknown = null
    for (const candidate of [`${u.origin}/.well-known/oauth-authorization-server${path}`, `${u.origin}/.well-known/openid-configuration${path}`]) {
      const { r, body } = await getJson(candidate).catch(() => ({ r: null, body: null }))
      if (r?.status === 200 && isObj(body)) {
        meta = body
        break
      }
    }
    if (!isObj(meta)) return add("B2", "B2.authorization-server", false, `no RFC 8414 metadata for ${first}`)
    const listed = Array.isArray(meta.scopes_supported) ? (meta.scopes_supported as string[]) : []
    const lacks = ["web.read", "web.write", "web.irreversible"].filter((s) => !listed.includes(s))
    add("B2", "B2.authorization-server", lacks.length === 0, lacks.length ? `${first}: scopes_supported lacks ${lacks.join(", ")}` : `${first}: metadata with the access profile's scopes`)
  })
  await attempt("B2", "B2.step-up", async () => {
    if (!options.readToken) return add("B2", "B2.step-up", "skipped", "give --read-token (a token with only web.read)")
    const writes = tools.filter((t) => t.annotations?.readOnlyHint === false && !t._meta?.[SESSION])
    const tool = writes.find((t) => Array.isArray(t.inputSchema?.required) && (t.inputSchema!.required as unknown[]).length > 0) ?? writes[0]
    if (!tool) return add("B2", "B2.step-up", "skipped", "the app has no write tool", true)
    const r = await rpc("tools/call", { name: tool.name, arguments: {} }, { token: options.readToken })
    const ok = r.status === 403 && /insufficient_scope/.test(r.headers.get("www-authenticate") ?? "")
    add("B2", "B2.step-up", ok, ok ? `${tool.name} with a web.read token: 403 insufficient_scope` : `${tool.name} with a web.read token answered ${r.status}, expected 403 with insufficient_scope (ACC-2)`)
  })

  // ---------------------------------------------------------------- C: session transfer
  const bound = tools.find((t) => t.name === "create_bound_browser_session")
  if (!bound) add("C", "C.bound-tool", false, "no create_bound_browser_session tool")
  else {
    const marker = bound._meta?.[SESSION]
    const ui = bound._meta?.ui
    const ok = isObj(marker) && marker.revision === "0.3" && marker.mode === "bound" && isObj(ui) && Array.isArray(ui.visibility) && ui.visibility.length === 1 && ui.visibility[0] === "app"
    add("C", "C.bound-tool", ok, ok ? "create_bound_browser_session, marked and hidden from models" : `marker or visibility wrong: ${JSON.stringify(bound._meta)}`)
    await attempt("C", "C.bound-refusals", async () => {
      const target = `${origin}/`
      const without = await rpc("tools/call", { name: bound.name, arguments: { target } })
      const refused = without.status !== 200 || without.error !== undefined || without.result?.isError === true
      add("C", "C.challenge-required", refused, refused ? "a call without challenge is refused (SES-2)" : "a call without challenge was not refused")
      const issued = await rpc("tools/call", { name: bound.name, arguments: { target, challenge: randomB64url(32).slice(0, 43) } })
      if (issued.status === 403) return add("C", "C.bound-code", false, "the token lacks bound_browser_session: give one with it")
      const url = (issued.result?.structuredContent as { url?: string } | undefined)?.url
      if (typeof url !== "string" || !onOrigin(url, origin)) return add("C", "C.bound-code", false, `no same-origin url: ${JSON.stringify(issued.result ?? issued.error).slice(0, 200)}`)
      add("C", "C.bound-code", true, "a one-time URL on the app's origin")
      // SES-2/SES-3: a strong-mode code redeems only by a POST with its verifier. A GET offers no form and no nonce,
      // sets no cookie, and a POST without the verifier (the interstitial's "continue", with whatever nonce the page
      // showed) creates no session.
      const get = await doFetch(url, { redirect: "manual" })
      const html = await get.text()
      const nonce = /name="nonce" value="([^"]+)"/.exec(html)?.[1] ?? ""
      const closed = get.status !== 303 && !get.headers.get("set-cookie") && !/<form/i.test(html)
      add("C", "C.bound-get", closed, closed ? "a GET on a strong-mode code offers no way in and sets no cookie (SES-3)" : `a GET on a strong-mode code answered ${get.status}${get.headers.get("set-cookie") ? " with a cookie" : ""}${/<form/i.test(html) ? " with a form" : ""}`)
      const form = { "content-type": "application/x-www-form-urlencoded" }
      const noVerifier = await doFetch(url, { method: "POST", headers: form, body: new URLSearchParams({ decision: "continue", nonce }).toString(), redirect: "manual" })
      const wrong = await doFetch(url, { method: "POST", headers: form, body: new URLSearchParams({ verifier: randomB64url(32) }).toString(), redirect: "manual" })
      const none = !noVerifier.headers.get("set-cookie") && !wrong.headers.get("set-cookie") && noVerifier.status !== 303 && wrong.status !== 303
      add("C", "C.verifier", none, none ? "no session without its verifier, through the interstitial or not (SES-3)" : `a redeem without the right verifier answered ${noVerifier.status} / ${wrong.status}${noVerifier.headers.get("set-cookie") || wrong.headers.get("set-cookie") ? " with a cookie" : ""}`)
    })
  }
  const link = tools.find((t) => t.name === "create_browser_session")
  if (link) {
    await attempt("C", "C.link-mode", async () => {
      const marker = link._meta?.[SESSION]
      if (!isObj(marker) || marker.mode !== "link" || marker.revision !== "0.3") return add("C", "C.link-mode", false, `create_browser_session marker: ${JSON.stringify(marker)}`)
      const issued = await rpc("tools/call", { name: link.name, arguments: { target: `${origin}/` } })
      if (issued.status === 403) return add("C", "C.link-mode", "skipped", "the token lacks browser_session", true)
      const url = (issued.result?.structuredContent as { url?: string } | undefined)?.url
      if (typeof url !== "string" || !onOrigin(url, origin)) return add("C", "C.link-mode", false, "no same-origin link")
      const get = await doFetch(url, { redirect: "manual" })
      const ok = get.status === 200 && !get.headers.get("set-cookie")
      add("C", "C.link-mode", ok, ok ? "Clerk-compatible mode: the link opens the interstitial, no cookie (SES-15)" : `the link's GET answered ${get.status}${get.headers.get("set-cookie") ? " with a cookie" : ""}`)
    })
  }

  // ---------------------------------------------------------------- add-ons
  {
    const sharing = tools.filter((t) => isObj(t._meta?.[APP_SHARE]))
    const problems: string[] = []
    for (const t of sharing) {
      const s = t._meta![APP_SHARE] as Json
      if (t.inputSchema?.additionalProperties !== false) problems.push(`${t.name}: its input is not closed (SHR-3)`)
      const props = propsOf(t)
      for (const entry of [...(Array.isArray(s.accepts) ? s.accepts : []), ...(Array.isArray(s.plugins) ? s.plugins : [])].filter(isObj)) {
        for (const input of Object.keys(isObj(entry.map) ? entry.map : {})) if (!props.includes(input)) problems.push(`${t.name}: map names "${input}", not an input`)
        if (typeof entry.urlArg === "string" && !props.includes(entry.urlArg)) problems.push(`${t.name}: urlArg "${entry.urlArg}" is not an input`)
      }
    }
    if (!sharing.length) add("add-on", "share", "skipped", "no app-share declarations", true)
    else add("add-on", "share", problems.length === 0, problems.length ? problems.join("; ") : `${sharing.length} tools accept shares or plug into other apps`)
  }
  if (extensions?.[SKILLS]) {
    await attempt("add-on", "agents", async () => {
      const r = await rpc("skills/list")
      const skills = ((r.result?.skills ?? []) as { uri: string; resources?: { uri: string; digest?: string }[] }[]).filter(isObj)
      const problems: string[] = []
      let agents = 0
      for (const s of skills) {
        const file = s.resources?.find((x) => x.uri.endsWith("/agent.json"))
        if (!file) continue
        agents++
        if (s.resources!.some((x) => typeof x.digest !== "string")) problems.push(`${s.uri}: a file without its digest (AGT-4)`)
        const a = await readJson(file.uri)
        if (!isObj(a)) {
          problems.push(`${file.uri}: not an object`)
          continue
        }
        if (a.tier !== undefined && !["fast", "standard", "strong"].includes(String(a.tier))) problems.push(`${file.uri}: tier "${String(a.tier)}"`)
        if (a.maxSteps !== undefined && !(Number.isInteger(a.maxSteps) && (a.maxSteps as number) >= 1 && (a.maxSteps as number) <= 200)) problems.push(`${file.uri}: maxSteps is 1 to 200`)
        if (Array.isArray(a.starters) && a.starters.length > 6) problems.push(`${file.uri}: more than 6 starters`)
        if (isObj(a.approval) && !["ask", "always"].includes(String(a.approval.change))) problems.push(`${file.uri}: approval.change "${String(a.approval.change)}"`)
        for (const sch of Array.isArray(a.schedules) ? a.schedules.filter(isObj) : []) {
          const minute = String(sch.cron ?? "").trim().split(/\s+/)
          if (minute.length !== 5 || !/^\d{1,2}$/.test(minute[0]!)) problems.push(`${file.uri}: schedule "${String(sch.name)}" more often than hourly (AGT-8)`)
          if (!Array.isArray(a.starters) || typeof sch.starter !== "number" || !a.starters[sch.starter]) problems.push(`${file.uri}: schedule "${String(sch.name)}" names no starter`)
        }
      }
      if (!agents) add("add-on", "agents", "skipped", "no skill with an agent.json", true)
      else add("add-on", "agents", problems.length === 0, problems.length ? problems.join("; ") : `${agents} agents, each a skill with a valid agent.json`)
    })
  }
  if (extensions?.[EVENTS]) {
    await attempt("add-on", "events", async () => {
      const r = await rpc("events/list")
      const names = ((r.result?.events ?? []) as { name?: string }[]).map((e) => e.name)
      const lacks = ["com.clegra.app.notification", "com.clegra.app.activity"].filter((n) => !names.includes(n))
      add("add-on", "events", lacks.length === 0, lacks.length ? `events/list lacks ${lacks.join(", ")}` : "both event types listed")
    })
  }

  const reached = (level: Level) => checks.filter((c) => c.level === level).every((c) => c.ok === true || (c.ok === "skipped" && c.optional))
  const levels: Report["levels"] = []
  if (reached("A")) {
    levels.push("A")
    if (reached("B1") && checks.some((c) => c.level === "B1" && c.ok === true)) {
      levels.push("B1")
      if (reached("B2")) levels.push("B2")
    }
    if (reached("C")) levels.push("C")
  }
  return { url: options.url, mcpUrl, origin, checks, levels, localHttp, ok: !checks.some((c) => c.ok === false) }
}

export function formatReport(report: Report): string {
  const mark = (c: Check) => (c.ok === true ? "ok  " : c.ok === false ? "FAIL" : "skip")
  const out = [`clegra check ${report.mcpUrl} (origin ${report.origin})`, ...(report.localHttp ? ["local http: a loopback address, so same-origin http URLs count where https is required (never for a public address)"] : []), ""]
  for (const level of ["A", "B1", "B2", "C", "add-on"] as const) {
    const of = report.checks.filter((c) => c.level === level)
    if (!of.length) continue
    out.push(level === "add-on" ? "Add-ons" : `Level ${level}`)
    for (const c of of) out.push(`  ${mark(c)}  ${c.id.padEnd(24)} ${c.message}`)
    out.push("")
  }
  out.push(`Levels reached: ${report.levels.length ? report.levels.join(", ") : "none"}${report.ok ? "" : " — some checks failed"}`)
  return out.join("\n")
}
