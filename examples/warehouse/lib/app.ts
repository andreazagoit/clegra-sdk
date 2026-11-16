import "server-only"

import type { App } from "modelapp"

import { getAuth } from "./auth"
import { createWarehouseApp } from "./modelapp"
import { modelAppAuth } from "./modelapp-auth"

/**
 * The warehouse's MAP app, as the site serves it: the MCP route (app/api/modelapp), the embed proxy (proxy.ts) and the
 * embedded pages (app/embed). Made on first use: better-auth and the database are never touched at build time.
 */
let app: Promise<App> | undefined
export const warehouseApp = (): Promise<App> => (app ??= getAuth().then((auth) => createWarehouseApp({ auth: modelAppAuth(auth) })))
