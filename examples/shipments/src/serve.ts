import { MemoryStore, serve, type AuthOptions, type IdempotencyStore, type ServedApp } from "@clegra/sdk"

import { shipmentsApp } from "./clegra/app"
import { useCourier } from "./clegra/courier"
import { createCourier, type Courier } from "./courier"

export type ShipmentsServeOptions = {
  /** Who may call (spec §7): the app's own sign-in (`signIn`, auth.ts), or the development sign-in (`devSignIn`) in tests and local runs. */
  auth: AuthOptions
  /** Idempotency of writes and one-time token ids. In memory: this example keeps everything in one process. */
  store?: IdempotencyStore
  /** The courier's data (default: a new set in memory, seeded per tenant). */
  courier?: Courier
}

/** The Shipments app at work: its definition (clegra/app.ts) with who may call, its store and the courier's data. */
export function serveShipments({ auth, store = new MemoryStore(), courier = createCourier() }: ShipmentsServeOptions): ServedApp {
  useCourier(courier)
  return serve(shipmentsApp, { auth, store, people: (ids, ctx) => courier.personNames(ctx.installation, ids) })
}
