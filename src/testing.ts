import type { ServedApp } from "./server"

/**
 * `@clegra/sdk/testing`: an MCP client on revision 2026-07-28 that talks to `served.fetch` directly, with a token of
 * yours (from `devSignIn(app).dev.token(…)` in tests). It declares URL-mode elicitation unless `elicitation: false`.
 */

export const PROTOCOL_VERSION = "2026-07-28"

export type ToolCallResult = {
  isError?: boolean
  content?: { type: string; text?: string; uri?: string; name?: string; mimeType?: string }[]
  structuredContent?: Record<string, unknown>
  resultType?: string
  inputRequests?: Record<string, { method: string; params: { mode?: string; url?: string; message?: string } }>
  requestState?: string
  _meta?: Record<string, unknown>
}

export type TestClientOptions = {
  token: string | (() => string | Promise<string>)
  /** Declare URL-mode elicitation (default true). */
  elicitation?: boolean
  /** Extensions the client declares, default web-map and app-share. */
  extensions?: Record<string, Record<string, unknown>>
  /** `io.modelcontextprotocol/acceptLanguage`. */
  language?: string
  /** The app's origin the requests are made at (default the served origin). */
  origin?: string
}

export type RpcAnswer = { status: number; result?: Record<string, unknown>; error?: { code: number; message: string; data?: unknown }; headers: Headers }

export function testClient(served: ServedApp, options: TestClientOptions) {
  let id = 0
  const base = options.origin ?? served.origin()
  const meta = () => ({
    "io.modelcontextprotocol/protocolVersion": PROTOCOL_VERSION,
    "io.modelcontextprotocol/clientInfo": { name: "clegra-test", version: "1.0.0" },
    "io.modelcontextprotocol/clientCapabilities": {
      ...(options.elicitation === false ? {} : { elicitation: { url: {} } }),
      extensions: options.extensions ?? { "com.clegra/web-map": { revision: "0.2" }, "com.clegra/app-share": { revision: "0.1" } },
    },
    ...(options.language ? { "io.modelcontextprotocol/acceptLanguage": options.language } : {}),
  })
  const token = async () => (typeof options.token === "function" ? options.token() : options.token)
  async function rpc(method: string, params: Record<string, unknown> = {}, name?: string): Promise<RpcAnswer> {
    const { _meta: extraMeta, ...rest } = params as { _meta?: Record<string, unknown> }
    const body = JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params: { ...rest, _meta: { ...meta(), ...(extraMeta ?? {}) } } })
    const t = await token()
    const response = await served.fetch(
      new Request(served.mcpUrl().replace(served.origin(), base), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": PROTOCOL_VERSION,
          "mcp-method": method,
          ...(name ? { "mcp-name": name } : {}),
          ...(t ? { authorization: `Bearer ${t}` } : {}),
        },
        body,
      }),
    )
    const raw = await response.text()
    if (response.status !== 200) return { status: response.status, headers: response.headers }
    const json = response.headers.get("content-type")?.includes("text/event-stream")
      ? JSON.parse(raw.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).filter(Boolean).pop() ?? "{}")
      : JSON.parse(raw)
    return { status: 200, headers: response.headers, ...(json.result !== undefined ? { result: json.result } : {}), ...(json.error ? { error: json.error } : {}) }
  }
  return {
    rpc,
    async discover() {
      return (await rpc("server/discover")).result as { capabilities: { extensions?: Record<string, Record<string, unknown>> }; instructions?: string; _meta?: Record<string, unknown> }
    },
    async listTools(): Promise<{ name: string; title?: string; description?: string; inputSchema: Record<string, unknown>; annotations?: Record<string, unknown>; _meta?: Record<string, unknown> }[]> {
      return ((await rpc("tools/list")).result?.tools ?? []) as never
    },
    async call(name: string, args: Record<string, unknown> = {}, more: { inputResponses?: Record<string, unknown>; requestState?: string; _meta?: Record<string, unknown> } = {}): Promise<ToolCallResult & { status: number; headers: Headers }> {
      const r = await rpc("tools/call", { name, arguments: args, ...more }, name)
      if (r.error) return { status: r.status, headers: r.headers, isError: true, structuredContent: { error: { code: "protocol", message: r.error.message, rpc: r.error.code } } }
      return { status: r.status, headers: r.headers, ...((r.result ?? {}) as ToolCallResult) }
    },
    async read(uri: string): Promise<{ status: number; contents: { uri: string; mimeType?: string; text?: string; _meta?: Record<string, unknown> }[]; error?: { code: number; message: string } }> {
      const r = await rpc("resources/read", { uri }, uri)
      return { status: r.status, contents: ((r.result?.contents ?? []) as never), ...(r.error ? { error: r.error } : {}) }
    },
    async readJson<T = Record<string, unknown>>(uri: string): Promise<T> {
      const r = await this.read(uri)
      if (r.error || !r.contents[0]?.text) throw new Error(`read ${uri}: ${r.error?.message ?? `status ${r.status}`}`)
      return JSON.parse(r.contents[0].text) as T
    },
    async listResources() {
      return ((await rpc("resources/list")).result?.resources ?? []) as { uri: string; name: string; _meta?: Record<string, unknown> }[]
    },
    async listTemplates() {
      return ((await rpc("resources/templates/list")).result?.resourceTemplates ?? []) as { uriTemplate: string; name: string; _meta?: Record<string, unknown> }[]
    },
    async listSkills() {
      return ((await rpc("skills/list")).result?.skills ?? []) as { uri: string; frontmatter: Record<string, unknown>; resources: { uri: string; digest: string }[] }[]
    },
  }
}

/** The person's click on a confirmation page, as a test makes it: signs in with `cookie`, reads the page, posts the decision. */
export async function confirmOnPage(served: ServedApp, url: string, cookie: string, decision: "confirm" | "decline" | "revoke" = "confirm"): Promise<Response> {
  const page = await served.fetch(new Request(url, { headers: { cookie } }))
  const html = await page.text()
  const nonce = /name="nonce" value="([^"]+)"/.exec(html)?.[1]
  if (!nonce) throw new Error(`confirmOnPage: no confirmation form at ${url} (status ${page.status})`)
  const origin = new URL(url).origin
  return served.fetch(new Request(url, { method: "POST", headers: { cookie, origin, "sec-fetch-site": "same-origin", "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ nonce, decision }) }))
}
