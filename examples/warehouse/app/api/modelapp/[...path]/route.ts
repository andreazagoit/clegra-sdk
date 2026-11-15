import { toNextHandlers, type NextHandlers } from "modelapp/next"

import { getAuth } from "@/lib/auth"
import { createWarehouseApp } from "@/lib/modelapp"
import { modelAppAuth } from "@/lib/modelapp-auth"

// MCP (/mcp), the MAP manifest and the OAuth metadata (/.well-known/…): next.config's withModelApp rewrites
// them here. The app is made on the first request (the database and better-auth are never touched at build time).
let handlers: Promise<NextHandlers> | undefined
const route = () => (handlers ??= getAuth().then((auth) => toNextHandlers(createWarehouseApp({ auth: modelAppAuth(auth) }))))

export const GET = async (request: Request) => (await route()).GET(request)
export const POST = async (request: Request) => (await route()).POST(request)
export const DELETE = async (request: Request) => (await route()).DELETE(request)
export const OPTIONS = async (request: Request) => (await route()).OPTIONS(request)
