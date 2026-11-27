import { AppError, type Context } from "@clegra/sdk"

import { CourierError, type Courier } from "../courier"
import { l } from "./labels"

/**
 * The courier's data the handlers read, as an app reads its database: one source per process, given when the app is
 * served (`serveShipments`, ../serve.ts). The data are partitioned by tenant (`ctx.installation`) inside it.
 */
let source: Courier | null = null

/** Gives the handlers their courier (`serveShipments` does it). */
export function useCourier(courier: Courier): void {
  source = courier
}

/** The courier the handlers read; a clear error before the app is served. */
export function courier(): Courier {
  if (!source) throw new Error("shipments: no courier yet: serve the app with serveShipments()")
  return source
}

/** The courier's refusals, as app errors the host shows; anything else stays a server error. */
export function mapped<T>(work: () => T): T {
  try {
    return work()
  } catch (error) {
    if (error instanceof CourierError) throw new AppError(error.code, error.message, error.fields ? { fields: error.fields } : undefined)
    throw error
  }
}

/** The depot pickups start from: the installation's setting, which its administrator sets. */
export function depotOf(ctx: Context): string {
  const depot = typeof ctx.settings.depot === "string" ? ctx.settings.depot.trim() : ""
  if (!depot) throw new AppError("invalid_input", ctx.t(l("The depot is not set: an administrator sets it in the app's settings.", "Il deposito non è impostato: lo imposta un amministratore nelle impostazioni dell'app.")))
  return depot
}
