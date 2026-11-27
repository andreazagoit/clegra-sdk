// The warehouse's Clegra app at work: its definition (app.ts) with how it runs here. Who may call is its own
// better-auth (lib/clegra-auth.ts); its write store is its Postgres; its pages are its site in a workspace client.
import { serve, SqlStore, type AuthOptions, type IdempotencyStore } from "@clegra/sdk"

import { sql } from "../lib/db"
import { personNames } from "../lib/warehouse"
import { warehouse } from "./app"
import { tenant } from "./context"

export type WarehouseServeOptions = {
  /** Who may call (spec §7): the app's own better-auth tokens (`auth.resolve`), lib/clegra-auth.ts. */
  auth: AuthOptions
  /** The workspace clients that show the warehouse's site in their frame (`CLEGRA_CLIENT_ORIGINS`); none: no site. */
  clientOrigins?: string[]
  /** Idempotency of writes and one-time token ids: the app's Postgres by default (table from db/migrations/005_clegra_store.sql). */
  store?: IdempotencyStore
}

export function serveWarehouse({ auth, clientOrigins = [], store = new SqlStore((text, params) => sql(text, params)) }: WarehouseServeOptions) {
  return serve(warehouse, {
    auth,
    store,
    // The warehouse's own pages are its site in a workspace client (spec §5.1): framed at the app's origin by the
    // client origins only, the person signed in there with the warehouse's own sign-in.
    ...(clientOrigins.length ? { clientOrigins, site: { start: "/" } } : {}),
    people: async (ids, ctx) => personNames(await tenant(ctx), ids),
  })
}
