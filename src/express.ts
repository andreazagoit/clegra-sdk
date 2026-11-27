import type { IncomingMessage, ServerResponse } from "node:http"

import type { ServedApp } from "./server"
import { toNodeHandler } from "./node"

/**
 * `@clegra/sdk/express`: a served app (`serve(app, …)`) as Express (or Connect) middleware, at the root of the site:
 *
 * ```ts
 * app.use(clegraMiddleware(served))
 * ```
 *
 * The app answers its own routes (MCP at `/mcp` and its Server Card, `/.well-known/…`, the sign-in's `/oauth/…`, the
 * confirmation and session-transfer pages, the access log, bearer reads of record URLs); every other request goes on
 * to the next middleware. No body parser may run
 * before it on those routes (the app reads the raw body: a confirmation covers the arguments as sent).
 */
export function clegraMiddleware(served: ServedApp): (req: IncomingMessage, res: ServerResponse, next: (error?: unknown) => void) => Promise<void> {
  const handle = toNodeHandler(served)
  return (req, res, next) => handle(req, res, next)
}
