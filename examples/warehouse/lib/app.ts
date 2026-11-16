import "server-only"

import type { App } from "modelapp"

import { getAuth } from "./auth"
import { createWarehouseApp } from "./modelapp"
import { modelAppAuth } from "./modelapp-auth"

/**
 * The warehouse's MAP app, as the site serves it: the MCP route (app/api/modelapp), the embed proxy (proxy.ts) and the
 * embedded pages (app/embed). Made on first use, the database never touched at build time; better-auth is built only
 * when one of its own tokens or metadata requests needs it (modelAppAuth takes the getter).
 */
let app: App | undefined
export const warehouseApp = (): App => (app ??= createWarehouseApp({ auth: modelAppAuth(getAuth) }))
