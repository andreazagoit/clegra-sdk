import "server-only"

import type { ServedApp } from "@clegra/sdk"

import { serveWarehouse } from "../clegra/serve"
import { getAuth } from "./auth"
import { clegraAuth, clientOriginsFrom } from "./clegra-auth"

/**
 * The warehouse's Clegra app, as the site serves it: the MCP route (app/api/clegra), the site's proxy (proxy.ts) and
 * the pages. Made on first use, the database never touched at build time; better-auth is built only when one of its
 * own tokens or metadata requests needs it (clegraAuth takes the getter).
 */
let served: ServedApp | undefined
export const warehouseApp = (): ServedApp => (served ??= serveWarehouse({ auth: clegraAuth(getAuth), clientOrigins: clientOriginsFrom() }))
