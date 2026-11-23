import { siteProxy } from "@clegra/sdk/next"

import { crmApp } from "./clegra"

/**
 * The CRM's own pages are its site in a Clegra client (spec §5.1). In front of every page: a page opened in a Clegra
 * client's session may be framed by that client only; a Clegra frame whose session ended gets the signed-out page
 * (the client opens the site again); anything else may not be framed at all (`frame-ancestors 'none'`), so sign-in
 * and consent can't be clickjacked. The SDK's own paths (/mcp, /clegra/*, /.well-known/*) keep their own headers.
 */
export const proxy = siteProxy(crmApp)

export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] }
