import { siteProxy } from "@clegra/sdk/next"

import { crm } from "./clegra"

/**
 * The CRM's own pages are its site in a Clegra client (spec §5.1). In front of every page: framable by the CRM itself
 * and its client origins only (`frame-ancestors`); without client origins by nobody (`frame-ancestors 'none'`), so
 * sign-in and consent can't be clickjacked. The SDK's own paths (/mcp, /openapi.json, /clegra/*, /.well-known/*) keep
 * their own headers.
 */
export const proxy = siteProxy(crm)

export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] }
