import { toNextHandlers, type NextHandlers } from "modelapp/next"

import { warehouseApp } from "@/lib/app"

// MCP (/mcp), the MAP manifest and the OAuth metadata (/.well-known/…): next.config's withModelApp rewrites
// them here. The app is made on the first request (the database and better-auth are never touched at build time).
let handlers: Promise<NextHandlers> | undefined
const route = () => (handlers ??= warehouseApp().then((app) => toNextHandlers(app)))

export const GET = async (request: Request) => (await route()).GET(request)
export const POST = async (request: Request) => (await route()).POST(request)
export const DELETE = async (request: Request) => (await route()).DELETE(request)
export const OPTIONS = async (request: Request) => (await route()).OPTIONS(request)
