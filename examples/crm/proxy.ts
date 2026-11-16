import { embedProxy } from "clegra/next"

import { crmApp } from "./clegra"

/**
 * The embedded pages (/embed/*, spec §5.1): `POST /embed/_ticket` exchanges a host's sign-in ticket for the page's
 * partitioned session cookie, and every /embed response says who may frame it (frame-ancestors: the hosts the CRM
 * declares in clegra/app.ts). Every other page may not be framed at all (next.config.ts), so sign-in and consent
 * can't be clickjacked.
 */
export const proxy = embedProxy(crmApp)

export const config = { matcher: "/embed/:path*" }
