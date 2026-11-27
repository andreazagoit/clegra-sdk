import type { IncomingMessage, ServerResponse } from "node:http"

import type { ServedApp } from "./define"
import { toNodeHandler } from "./node"

/**
 * `@clegra/sdk/express`: a served app (`serve(app, …)`) as Express (or Connect) middleware, at the root of the site:
 *
 * ```ts
 * app.use(clegraMiddleware(served))
 * ```
 *
 * The app answers its own routes (MCP at `/mcp`, `/.well-known/…`, `/openapi.json`, `/operations/…`, the sign-in's
 * `/oauth/…`, views, the site's bridge); every other request goes on to the next middleware. No body parser may run
 * before it on those routes (the app reads the raw body: a confirmation covers the arguments as sent).
 */
export function clegraMiddleware(served: ServedApp): (req: IncomingMessage, res: ServerResponse, next: (error?: unknown) => void) => Promise<void> {
  const handle = toNodeHandler(served)
  return (req, res, next) => handle(req, res, next)
}
