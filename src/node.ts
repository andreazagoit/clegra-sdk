import { createServer, type IncomingMessage } from "node:http"

import { PROTOCOL_ID } from "../spec/src/protocol"

import { isLoopback } from "./auth"
import type { App } from "./define"

/**
 * `clegra/node`: an app on Node's own HTTP server, for a standalone
 * app or local tools. A web app serves `app.fetch` from its framework instead
 * (`clegra/next`); the core itself never opens a socket.
 */
export async function listen(app: App, options: { port?: number; host?: string; log?: boolean } = {}): Promise<{ url: string; close: () => Promise<void> }> {
  const port = options.port ?? 3000
  const host = options.host ?? "127.0.0.1"
  if (app.devMode && !isLoopback(host)) throw new Error(`auth.dev works only on a loopback address, not ${host}`)
  const { devCode } = await app.start()
  const http = createServer(async (req, res) => {
    const started = Date.now()
    try {
      const response = await app.fetch(await toRequest(req), { remoteAddress: req.socket.remoteAddress ?? null })
      const headers: Record<string, string> = {}
      response.headers.forEach((v, k) => (headers[k] = v))
      res.writeHead(response.status, headers)
      if (response.body) {
        const reader = response.body.getReader()
        for (let r = await reader.read(); !r.done; r = await reader.read()) res.write(r.value)
      }
      res.end()
    } catch (error) {
      console.error(`[${PROTOCOL_ID} http]`, error)
      if (!res.headersSent) res.writeHead(500).end()
      else res.end()
    } finally {
      if (options.log !== false) console.log(`${new Date().toISOString()} ${req.method} ${req.url} ${res.statusCode} ${Date.now() - started}ms`)
    }
  })
  await new Promise<void>((resolve, reject) => {
    http.once("error", reject)
    http.listen(port, host, resolve)
  })
  const address = http.address()
  const url = `http://${host}:${typeof address === "object" && address ? address.port : port}`
  const base = app.manifest().mcp.url
  console.log(`${app.name} — MCP ${url}${base} · manifest ${url}/.well-known/clegra.json`)
  if (devCode) console.log(`DEV AUTH ON (never in production) — sign-in code: ${devCode}`)
  return { url, close: () => new Promise((resolve) => http.close(() => resolve())) }
}

async function toRequest(req: IncomingMessage): Promise<Request> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  const headers = new Headers()
  for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(", ") : v)
  const body = chunks.length && req.method !== "GET" && req.method !== "HEAD" ? Buffer.concat(chunks) : undefined
  return new Request(`http://${req.headers.host ?? "localhost"}${req.url}`, { method: req.method, headers, ...(body ? { body } : {}) })
}
