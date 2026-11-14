import { randomUUID } from "node:crypto"

import type { McpWorkspacesServer } from "./server"

/**
 * A test client (spec-level, over the real HTTP path): JSON-RPC to
 * `app.fetch` with a dev token, as a plain host or a workspace host. Needs
 * `auth: { dev: true }` on the app (or `token`).
 */
export type ToolCallResult = { isError?: boolean; content?: { type: string; text?: string }[]; structuredContent?: Record<string, unknown>; _meta?: Record<string, unknown> }

export type TestClientOptions = {
  person?: string
  permissions?: string[] | "all"
  host?: "workspace" | "plain"
  installation?: string
  locale?: string
  /** Use this bearer instead of a dev token (null: no Authorization header). */
  token?: string | null
}

export async function testClient(app: McpWorkspacesServer, options: TestClientOptions = {}) {
  const token = options.token === undefined ? await app.devToken(options) : options.token
  let id = 0
  const rpc = async (method: string, params: Record<string, unknown>): Promise<{ status: number; result?: unknown; error?: { code: number; message: string } }> => {
    const response = await app.fetch(
      new Request("http://127.0.0.1/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18", ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
      }),
    )
    const raw = await response.text()
    if (response.status !== 200) return { status: response.status }
    const json = response.headers.get("content-type")?.includes("text/event-stream")
      ? JSON.parse(raw.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).filter(Boolean).pop() ?? "{}")
      : JSON.parse(raw)
    return { status: 200, ...(json.result !== undefined ? { result: json.result } : {}), ...(json.error ? { error: json.error } : {}) }
  }
  const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "mcpw-test", version: "1.0.0" } })
  return {
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
    /** A write as a workspace host does it after the person's «Confirm»: a call id and a proof. */
    async confirmed(name: string, args: Record<string, unknown>, call: string = randomUUID()): Promise<ToolCallResult> {
      const proof = await app.devConfirmation({ tool: name, args, call, ...(options.person ? { person: options.person } : {}) })
      return this.call(name, args, { "mcpw/call": call, "mcpw/confirmation": proof })
    },
    async readResource(uri: string): Promise<{ uri: string; mimeType?: string; text?: string; _meta?: Record<string, unknown> }[]> {
      const r = await rpc("resources/read", { uri })
      return ((r.result as { contents?: never[] } | undefined)?.contents ?? []) as never
    },
  }
}
