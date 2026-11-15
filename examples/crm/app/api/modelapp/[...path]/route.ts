// The MAP server (MCP at /mcp, its manifest and OAuth metadata under /.well-known/), rewritten here by
// withModelApp in next.config.ts.
import { toNextHandlers, type NextHandlers } from "modelapp/next"

import { publicOrigin } from "@/lib/site"
import { crmApp } from "@/modelapp"

let handlers: NextHandlers | undefined
const route = () => (handlers ??= toNextHandlers(crmApp(), { publicUrl: publicOrigin() }))

export const GET = (request: Request) => route().GET(request)
export const POST = (request: Request) => route().POST(request)
export const DELETE = (request: Request) => route().DELETE(request)
export const OPTIONS = (request: Request) => route().OPTIONS(request)
