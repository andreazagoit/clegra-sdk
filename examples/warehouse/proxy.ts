import { embedProxy } from "clegra/next"

import { warehouseApp } from "@/lib/app"

/**
 * The embedded pages (/embed/*, spec §5.1): `POST /embed/_ticket` exchanges a host's sign-in ticket for the page's
 * partitioned session cookie, and every /embed response says who may frame it (frame-ancestors: the hosts declared in
 * lib/clegra.ts). Every other page may not be framed at all (next.config.ts).
 */
export const proxy = embedProxy(warehouseApp)

export const config = { matcher: "/embed/:path*" }
