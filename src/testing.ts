import { createHash, randomUUID } from "node:crypto"

import { calculateJwkThumbprint, exportJWK, generateKeyPair, SignJWT, type CryptoKey, type JWK } from "jose"

import { LATER_TOOL, META_KEY } from "../spec/src/protocol"
import type { Person } from "./auth"
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
  /** The person calling (a dev person's id, or any `{ id, name }`); `null`: nobody — with `host: "workspace"`, the installation itself (see `installationClient`). */
  person?: string | Person | null
  permissions?: string[] | "all"
  host?: "workspace" | "plain"
  installation?: string
  locale?: string
  /** Use this bearer instead of a dev token (null: no Authorization header; a function: a new one per request). */
  token?: string | null | (() => string | Promise<string>)
  /** The address the requests come from (default loopback: dev tokens count only there). */
  remoteAddress?: string
  /**
   * A DPoP-bound token (the sign-in module's, RFC 9449): sent as `Authorization: DPoP <token>` with a proof signed by
   * `key` for `htu` (the app's configured resource); a `use_dpop_nonce` answer is retried once with the nonce.
   */
  dpop?: { key: DeviceKey; htu: string }
  /** The `Origin` header of every request (a browser's). */
  origin?: string
}

/** An export as the test reads it back: the file's facts and its bytes (from the embedded resource). */
export type ExportedFile = { name: string; contentType: string; bytes: number; sha256: string; body: Buffer }

export async function testClient(app: App, options: TestClientOptions = {}) {
  const { token: given, remoteAddress = "127.0.0.1", dpop, origin, ...who } = options
  const plain = given === undefined && who.host !== "workspace" ? await app.devToken(who) : null
  const bearer = async () => (typeof given === "function" ? given() : given !== undefined ? given : (plain ?? app.devToken(who)))
  let id = 0

  let nonce: string | undefined
  const send = async (token: string | null, body: string) => {
    const auth: Record<string, string> = !token ? {} : dpop ? { authorization: `DPoP ${token}`, dpop: await dpop.key.proof({ htm: "POST", htu: dpop.htu, token, ...(nonce ? { nonce } : {}) }) } : { authorization: `Bearer ${token}` }
    return app.fetch(
      new Request("http://127.0.0.1/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18", ...(origin ? { origin } : {}), ...auth },
        body,
      }),
      { remoteAddress },
    )
  }
  const rpc = async (method: string, params: Record<string, unknown>): Promise<{ status: number; result?: unknown; error?: { code: number; message: string } }> => {
    const body = JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params })
    let response = await send(await bearer(), body)
    if (dpop && response.status === 401 && response.headers.get("dpop-nonce")) {
      nonce = response.headers.get("dpop-nonce")!
      response = await send(await bearer(), body)
    }
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
      const signed = await app.devConfirmation({ tool: name, args, call, ...(options.person ? { person: typeof options.person === "string" ? options.person : options.person.id } : {}), ...(options.installation ? { installation: options.installation } : {}), ...proof })
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

// ------------------------------------------------------------ Clegra's core, for tests

/** A device's (or a server's) key pair: what a Clegra client signs DPoP proofs and confirmation proofs with. */
export type DeviceKey = {
  /** The key's thumbprint (RFC 7638): what tokens name in `cnf.jkt`. */
  jkt: string
  publicJwk: JWK
  privateKey: CryptoKey
  /** A DPoP proof (RFC 9449) for one request. `iat` (epoch seconds) and `jti` for tests of refusals. */
  proof(input: { htm: string; htu: string; token: string; nonce?: string; iat?: number; jti?: string }): Promise<string>
}

const sha256 = (value: string) => createHash("sha256").update(value).digest("base64url")

/** A new device key (Ed25519). */
export async function deviceKey(): Promise<DeviceKey> {
  const { privateKey, publicKey } = await generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true })
  const publicJwk = await exportJWK(publicKey)
  const jkt = await calculateJwkThumbprint(publicJwk, "sha256")
  const now = () => Math.floor(Date.now() / 1000)
  return {
    jkt,
    publicJwk,
    privateKey,
    proof: (i) =>
      new SignJWT({ htm: i.htm, htu: i.htu, ath: sha256(i.token), ...(i.nonce ? { nonce: i.nonce } : {}) })
        .setProtectedHeader({ alg: "EdDSA", typ: "dpop+jwt", jwk: publicJwk })
        .setIssuedAt(i.iat ?? now())
        .setJti(i.jti ?? randomUUID())
        .sign(privateKey),
  }
}
