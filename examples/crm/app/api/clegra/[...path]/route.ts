// The Clegra app server (MCP at /mcp, its manifest and OAuth metadata under /.well-known/), rewritten here by
// withClegra in next.config.ts.
import { toNextHandlers, type NextHandlers } from "@clegra/sdk/next"

import { publicOrigin } from "@/lib/site"
import { crmApp } from "@/clegra"

let handlers: NextHandlers | undefined
const route = () => (handlers ??= toNextHandlers(crmApp(), { publicUrl: publicOrigin() }))

export const GET = (request: Request) => route().GET(request)
export const POST = (request: Request) => route().POST(request)
export const DELETE = (request: Request) => route().DELETE(request)
export const OPTIONS = (request: Request) => route().OPTIONS(request)
