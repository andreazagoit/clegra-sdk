import "server-only"

import type { App } from "@clegra/sdk"

import { getAuth } from "./auth"
import { createWarehouseApp } from "./clegra"
import { clegraAuth, clientOriginsFrom } from "./clegra-auth"

/**
 * The warehouse's Clegra app, as the site serves it: the MCP route (app/api/clegra), the site's proxy (proxy.ts) and
 * the pages, for a Clegra client's person (lib/session.ts). Made on first use, the database never touched at build
 * time; better-auth is built only when one of its own tokens or metadata requests needs it (clegraAuth takes the getter).
 */
let app: App | undefined
export const warehouseApp = (): App => (app ??= createWarehouseApp({ auth: clegraAuth(getAuth), clientOrigins: clientOriginsFrom() }))
