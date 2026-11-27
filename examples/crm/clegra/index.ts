// The CRM's Clegra app as it runs (app/api/clegra/[...path]/route.ts, proxy.ts): its definition (app.ts) served with
// the CRM's own sign-in, its database as the store, and its people's names. Made on first use: the configuration is
// read from the environment at run time, never during a build.
import { serve, SqlStore, type IdempotencyStore, type ServeOptions, type ServedApp } from "@clegra/sdk"

import { personNames } from "@/lib/crm"
import { database } from "@/lib/db"
import { crmApp } from "./app"
import { crmAuth, crmClientOrigins } from "./auth"
import { tenant } from "./lib"

export type CrmServeOptions = {
  /** Who may call: the CRM's own users, with access tokens of its own sign-in (`resolve`: better-auth, auth.ts). */
  auth: NonNullable<ServeOptions["auth"]>
  /** The workspace clients that show the CRM's site in their frame (`CLEGRA_CLIENT_ORIGINS`); none: no site. */
  clientOrigins?: string[]
  /** Default: the `clegra_store` table in the CRM's database. */
  store?: IdempotencyStore
}

/** The CRM served with this configuration (tests serve it with a development sign-in). */
export function serveCrm({ auth, clientOrigins = [], store = new SqlStore((text, params) => database().query(text, params)) }: CrmServeOptions): ServedApp {
  return serve(crmApp, {
    auth,
    store,
    // The CRM's own pages are its site in a workspace client (spec §5.1): framed at the CRM's origin by the client
    // origins only, the person signed in there with the CRM's own sign-in (its cookie partitioned in the frame).
    ...(clientOrigins.length ? { clientOrigins, site: { start: "/" } } : {}),
    // Deal owners are person ids: their names, so a host never shows an id.
    people: async (ids, ctx) => personNames(await tenant(ctx), ids),
  })
}

let served: ServedApp | undefined
export const crm = (): ServedApp => (served ??= serveCrm({ auth: crmAuth(), clientOrigins: crmClientOrigins() }))
