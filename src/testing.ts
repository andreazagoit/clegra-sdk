import { randomUUID } from "node:crypto"

import { LATER_TOOL, META_KEY } from "../spec/src/protocol"
import type { App } from "./define"

/**
 * A test client (spec-level, over the real HTTP path): JSON-RPC to
 * `app.fetch` with a dev token, as a plain host or a workspace host (whose
 * tokens are for one request: a new one is signed for each). Needs
 * `auth: { dev: true }` on the app (or `token`).
 */
export type ToolCallResult = {
  isError?: boolean
  content?: { type: string; text?: string; resource?: { uri: string; mimeType?: string; blob?: string; text?: string } }[]
  structuredContent?: Record<string, unknown>
  _meta?: Record<string, unknown>
}

export type TestClientOptions = {
  /** The person calling (a dev person's id); `null`: nobody — with `host: "workspace"`, the installation itself (see `installationClient`). */
  person?: string | null
  permissions?: string[] | "all"
  host?: "workspace" | "plain"
  installation?: string
  locale?: string
  /** Use this bearer instead of a dev token (null: no Authorization header; a function: a new one per request). */
  token?: string | null | (() => string | Promise<string>)
  /** The address the requests come from (default loopback: dev tokens count only there). */
  remoteAddress?: string
}

/** An export as the test reads it back: the file's facts and its bytes (from the embedded resource). */
export type ExportedFile = { name: string; contentType: string; bytes: number; sha256: string; body: Buffer }

export async function testClient(app: App, options: TestClientOptions = {}) {
  const { token: given, remoteAddress = "127.0.0.1", ...who } = options
  const plain = given === undefined && who.host !== "workspace" ? await app.devToken(who) : null
  const bearer = async () => (typeof given === "function" ? given() : given !== undefined ? given : (plain ?? app.devToken(who)))
  let id = 0
  const rpc = async (method: string, params: Record<string, unknown>): Promise<{ status: number; result?: unknown; error?: { code: number; message: string } }> => {
    const token = await bearer()
    const response = await app.fetch(
      new Request("http://127.0.0.1/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18", ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
      }),
      { remoteAddress },
    )
    const raw = await response.text()
    if (response.status !== 200) return { status: response.status }
    const json = response.headers.get("content-type")?.includes("text/event-stream")
      ? JSON.parse(raw.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).filter(Boolean).pop() ?? "{}")
      : JSON.parse(raw)
    return { status: 200, ...(json.result !== undefined ? { result: json.result } : {}), ...(json.error ? { error: json.error } : {}) }
  }
  const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "clegra-test", version: "1.0.0" } })
  const client = {
    status: init.status,
    initialize: init.result as Record<string, unknown> | undefined,
    rpc,
    async listTools(): Promise<{ name: string; inputSchema: Record<string, unknown>; annotations?: Record<string, unknown>; _meta?: Record<string, unknown>; title?: string; description?: string }[]> {
      const r = await rpc("tools/list", {})
      return ((r.result as { tools?: never[] } | undefined)?.tools ?? []) as never
    },
    async call(name: string, args: Record<string, unknown> = {}, meta: Record<string, unknown> = {}): Promise<ToolCallResult> {
      const r = await rpc("tools/call", { name, arguments: args, _meta: meta })
      if (r.error) return { isError: true, content: [{ type: "text", text: r.error.message }], structuredContent: { error: { code: "protocol", message: r.error.message } } }
      return r.result as ToolCallResult
    },
    /**
     * A write as a workspace host does it after the person's «Confirm»: a call id and a proof. For an action with
     * `later` the proof carries the run's deadline (`until`), as a host signs it; `until` overrides it.
     */
    async confirmed(name: string, args: Record<string, unknown>, call: string = randomUUID(), proof: { until?: number } = {}): Promise<ToolCallResult> {
      const signed = await app.devConfirmation({ tool: name, args, call, ...(options.person ? { person: options.person } : {}), ...(options.installation ? { installation: options.installation } : {}), ...proof })
      return client.call(name, args, { [META_KEY]: { call, confirmation: signed } })
    },
    async readResource(uri: string): Promise<{ uri: string; mimeType?: string; text?: string; _meta?: Record<string, unknown> }[]> {
      const r = await rpc("resources/read", { uri })
      return ((r.result as { contents?: never[] } | undefined)?.contents ?? []) as never
    },
    /** A schedule's run, as the workspace host makes it: its tool, called with `_meta.clegra.schedule` (use an `installationClient`). */
    async schedule(name: string, settings?: Record<string, unknown>): Promise<ToolCallResult> {
      const s = app.manifest().schedules?.find((x) => x.name === name)
      if (!s) throw new Error(`testClient.schedule: "${name}" is not a schedule of ${app.name}`)
      return client.call(s.tool, {}, { [META_KEY]: { schedule: name, ...(settings ? { settings } : {}) } })
    },
    /** One pass over the due later runs, as the host's `clegra_later` schedule makes it (use an `installationClient`). */
    async runLater(settings?: Record<string, unknown>): Promise<ToolCallResult> {
      return client.call(LATER_TOOL, {}, { [META_KEY]: { schedule: LATER_TOOL, ...(settings ? { settings } : {}) } })
    },
    /** `clegra_export`, its file read back from the embedded resource: null when the app keeps nothing (use an `installationClient`). */
    async exportData(): Promise<{ result: ToolCallResult; file: ExportedFile | null }> {
      const result = await client.call("clegra_export")
      const s = result.structuredContent as { name?: string; contentType?: string; bytes?: number; sha256?: string; empty?: boolean } | undefined
      const blob = result.content?.find((c) => c.type === "resource")?.resource?.blob
      if (result.isError || !s || s.empty || typeof blob !== "string") return { result, file: null }
      return { result, file: { name: String(s.name), contentType: String(s.contentType), bytes: Number(s.bytes), sha256: String(s.sha256), body: Buffer.from(blob, "base64") } }
    },
  }
  return client
}

/**
 * A client that is the installation itself: a workspace host's token with no person, as a host calls schedules,
 * later runs (`runLater`) and the lifecycle tools. `permissions`: what its token lists (default none; a host lists
 * exactly the permission the called action declares).
 */
export function installationClient(app: App, options: Omit<TestClientOptions, "person" | "host"> = {}) {
  return testClient(app, { ...options, host: "workspace", person: null })
}
