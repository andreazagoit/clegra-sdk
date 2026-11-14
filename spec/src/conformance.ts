import { readFileSync } from "node:fs"

import { Ajv2020 } from "ajv/dist/2020.js"

import { MANIFEST_PATH, PROTOCOL_ID, URI_SCHEME } from "./protocol"

/**
 * CONFORMANCE (spec §8): what any app must do, checked from outside over
 * HTTP. It knows nothing of the SDK: it reads the manifest, validates it
 * against the published JSON Schema, and talks plain MCP to the endpoint.
 *
 *   const report = await checkApp({ url: "http://127.0.0.1:3920", token })
 */

export { MANIFEST_PATH }
export const MCP_APP_MIME_TYPE = "text/html;profile=mcp-app"

export const manifestSchema = JSON.parse(readFileSync(new URL("../schema/modelapp.schema.json", import.meta.url), "utf8")) as Record<string, unknown>

export type Check = { id: string; title: string; ok: boolean; detail?: string; skipped?: boolean }
/** `ok`: no check failed. `complete`: every check ran (false when the MCP checks were skipped for lack of a token). Conformant = both. */
export type Report = { ok: boolean; complete: boolean; checks: Check[] }

export type Options = {
  /** The app's origin, e.g. `https://crm.example.com`. */
  url: string
  /** A bearer token of a plain MCP caller (not a workspace host). Without it only the public checks run. */
  token?: string
  /** `fetch` to use (tests pass the app's own handler). */
  fetch?: (request: Request) => Promise<Response>
}

type Tool = { name: string; title?: string; description?: string; inputSchema?: Record<string, unknown>; annotations?: Record<string, unknown>; _meta?: Record<string, unknown> }
type ToolRef = { name: string; plain: boolean }
type Manifest = {
  specVersion: string
  name: string
  mcp: { url: string }
  auth: { resource?: string; authorizationServers: string[] }
  resolveTool: string
  searchTool?: string
  entities: { name: string; permission?: string; fields: { name: string; ref?: string; permission?: string; role?: string }[]; tools: { list: ToolRef; get: ToolRef } }[]
  actions: { name: string; entity?: string; readOnly: boolean; confirm: string; permission?: string; tool: ToolRef }[]
  pages: { name: string; kind: string; entity?: string; columns?: string[]; permission?: string; tool: ToolRef; view?: string; url?: string }[]
  fragments: { type: string; entity?: string; template?: string; view?: string; permission?: string; tool: ToolRef; actions?: string[] }[]
  agents: { name: string; tools: string[] }[]
  permissions: { id: string }[]
}

const TOOL_NAME = /^[a-zA-Z0-9_.-]{1,64}$/

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
      if (f.ref && !entities.has(f.ref)) problems.push(`${e.name}.${f.name}: unknown entity ${f.ref}`)
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
  for (const f of manifest.fragments) {
    perm(f.permission, `fragment ${f.type}`)
    if (!f.template && !f.view) problems.push(`fragment ${f.type}: neither a template nor a view`)
    for (const a of f.actions ?? []) if (!actions.has(a)) problems.push(`fragment ${f.type}: unknown action ${a}`)
  }
  const refs: { where: string; tool: ToolRef; kind: "read" | "write"; destructive?: boolean; view?: string }[] = [
    ...manifest.entities.flatMap((e) => [
      { where: `entity ${e.name}`, tool: e.tools.list, kind: "read" as const },
      { where: `entity ${e.name}`, tool: e.tools.get, kind: "read" as const },
    ]),
    ...manifest.actions.map((a) => ({ where: `action ${a.name}`, tool: a.tool, kind: a.readOnly ? ("read" as const) : ("write" as const), destructive: !a.readOnly && a.confirm === "always" })),
    ...manifest.pages.filter((p) => p.kind !== "record").map((p) => ({ where: `page ${p.name}`, tool: p.tool, kind: "read" as const, ...(p.view ? { view: p.view } : {}) })),
    ...manifest.fragments.filter((f) => !f.entity).map((f) => ({ where: `fragment ${f.type}`, tool: f.tool, kind: "read" as const, ...(f.view ? { view: f.view } : {}) })),
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
  check("manifest.references", "names in the manifest refer to things it declares; tool names are unique and valid", problems)

  // 3. MCP authorization: no parallel sign-in.
  const mcpUrl = new URL(manifest.mcp.url, `${origin}/`).toString()
  const rpc = async (method: string, params: Record<string, unknown>, token?: string) => {
    const response = await doFetch(
      new Request(mcpUrl, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18", ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      }),
    )
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
        if (!Array.isArray(body.authorization_servers) || !body.authorization_servers.length) authProblems.push("protected-resource metadata names no authorization server")
      }
    }
    check("auth.mcp", "without a token the endpoint answers 401 and points to OAuth protected-resource metadata", authProblems)
  } else if (anonymous.status === 200) skip("auth.mcp", "without a token the endpoint answers 401 and points to OAuth protected-resource metadata", "the app accepts anonymous callers")
  else check("auth.mcp", "without a token the endpoint answers 401 and points to OAuth protected-resource metadata", `status ${anonymous.status}`)

  const token = options.token ?? (anonymous.status === 200 ? undefined : null)
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
    if (!r.tool.plain) {
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
  const again = ((await rpc("tools/list", {}, token)).result?.tools ?? []) as Tool[]
  check("mcp.deterministic", "tools/list is the same on every call", JSON.stringify(again) === JSON.stringify(listed) ? null : "two calls differ")

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
  check("mcp.views", "every view a tool names is served as an MCP Apps document", viewProblems)

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
  const verdict = !report.ok ? "NOT conformant." : report.complete ? "Conformant." : "Incomplete: the public checks pass, the MCP checks did not run. Not a conformance result: give a plain caller's token (--token)."
  return [...report.checks.map((c) => `${c.skipped ? "SKIP" : c.ok ? "PASS" : "FAIL"}  ${c.id} — ${c.title}${c.detail ? `\n      ${c.detail}` : ""}`), verdict].join("\n")
}
