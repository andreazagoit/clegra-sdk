import { toNextHandlers, type NextHandlers } from "modelapp/next"

import { getAuth } from "@/lib/auth"
import { createWarehouseApp } from "@/lib/modelapp"
import { modelAppAuth } from "@/lib/modelapp-auth"

// MCP (/mcp), the MAP manifest and the OAuth metadata (/.well-known/…): next.config's withModelApp rewrites
// them here. The app is made on the first request (the database and better-auth are never touched at build time),
// better-auth only when one of its own tokens or metadata requests needs it.
let handlers: NextHandlers | undefined
const route = () => (handlers ??= toNextHandlers(createWarehouseApp({ auth: modelAppAuth(getAuth) })))

export const GET = (request: Request) => route().GET(request)
export const POST = (request: Request) => route().POST(request)
export const DELETE = (request: Request) => route().DELETE(request)
export const OPTIONS = (request: Request) => route().OPTIONS(request)
