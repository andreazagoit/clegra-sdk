import { lookup } from "node:dns/promises"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"

import type { ServedApp } from "./server"
import { useHostLookup } from "./platform"

/**
 * `@clegra/sdk/node`: a served app (`serve(app, …)`) on Node's own HTTP server, for a standalone app or local tools,
 * and the request handler other Node frameworks mount (`@clegra/sdk/express`). The core runs on Web APIs only; what
 * it needs of Node (the DNS resolver that checks a client's host before its metadata is fetched) is given here.
 */

/** Node's resolver, for the core (`useHostLookup`): every address of a host. */
export const nodeHostLookup = async (host: string) => (await lookup(host, { all: true })).map((a) => a.address)
useHostLookup(nodeHostLookup)

export type NodeHandlerOptions = {
  /** Requests the app does not answer (404, not one of its routes): `next()` gives them to the framework instead. */
  next?: (req: IncomingMessage, res: ServerResponse) => void
}

/** `(req, res)` for any Node HTTP server: the request as a Fetch `Request` to `served.fetch`, its answer streamed back. */
export function toNodeHandler(served: ServedApp): (req: IncomingMessage, res: ServerResponse, next?: (error?: unknown) => void) => Promise<void> {
  return async (req, res, next) => {
    try {
      const response = await served.handle(await toRequest(req))
      if (!response) {
        if (next) return next()
        res.writeHead(404, { "content-type": "text/plain" }).end("Not found")
        return
      }
      await writeResponse(res, response)
    } catch (error) {
      if (next) return next(error)
      console.error(`[${served.app.name} http]`, error)
      if (!res.headersSent) res.writeHead(500).end()
      else res.end()
    }
  }
}

export async function listen(served: ServedApp, options: { port?: number; host?: string; log?: boolean } = {}): Promise<{ url: string; close: () => Promise<void> }> {
  const port = options.port ?? 3000
  const host = options.host ?? "127.0.0.1"
  const handle = toNodeHandler(served)
  const http = createServer(async (req, res) => {
    const started = Date.now()
    await handle(req, res)
    if (options.log !== false) console.log(`${new Date().toISOString()} ${req.method} ${req.url} ${res.statusCode} ${Date.now() - started}ms`)
  })
  await new Promise<void>((resolve, reject) => {
    http.once("error", reject)
    http.listen(port, host, resolve)
  })
  const address = http.address()
  const url = `http://${host}:${typeof address === "object" && address ? address.port : port}`
  if (options.log !== false) console.log(`${served.app.name} on ${url}: MCP ${served.mcpUrl()}`)
  return { url, close: () => new Promise((resolve) => http.close(() => resolve())) }
}

async function toRequest(req: IncomingMessage): Promise<Request> {
  const chunks: Uint8Array[] = []
  for await (const chunk of req) chunks.push(chunk as Uint8Array)
  const headers = new Headers()
  for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(", ") : v)
  const body = chunks.length && req.method !== "GET" && req.method !== "HEAD" ? Buffer.concat(chunks) : undefined
  // Express (and other frameworks) strip a mount path from `url`; `originalUrl` keeps it.
  const path = (req as IncomingMessage & { originalUrl?: string }).originalUrl ?? req.url
  return new Request(`http://${req.headers.host ?? "localhost"}${path}`, { method: req.method, headers, ...(body ? { body } : {}) })
}

async function writeResponse(res: ServerResponse, response: Response): Promise<void> {
  const headers: Record<string, string> = {}
  response.headers.forEach((v, k) => (headers[k] = v))
  res.writeHead(response.status, headers)
  if (response.body) {
    const reader = response.body.getReader()
    for (let r = await reader.read(); !r.done; r = await reader.read()) res.write(r.value)
  }
  res.end()
}
