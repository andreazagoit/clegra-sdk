// What every handler of the warehouse's Clegra app shares: the tenant, who acts, and the app's refusals as app errors.
// Each handler calls the functions the pages already use (lib/warehouse.ts), with the tenant the SDK took from the
// verified caller.
import { AppError, type Context } from "@clegra/sdk"

import { ListError } from "../lib/sql-list"
import { isMember, WarehouseError, type Actor } from "../lib/warehouse"

/**
 * The tenant of this call: `ctx.installation`, from the verified token, never a parameter: the organization of the
 * warehouse's own user the token was issued to (any client acts with a token of the warehouse's own sign-in).
 */
export async function tenant(ctx: Pick<Context, "installation">): Promise<string> {
  return ctx.installation
}

/**
 * Who makes a change: the person the token names, recorded with their name (a member of the organization is also
 * named from better-auth). Null for a call without a person.
 */
export async function actor(tenantId: string, ctx: Context): Promise<Actor | null> {
  const person = ctx.person
  if (!person?.id) return null
  return (await isMember(tenantId, person.id)) ? { id: person.id } : { id: person.id, ...(person.name ? { name: person.name } : {}) }
}

/** The app's own refusals, as app errors the host can show; anything else stays a server error. */
export async function mapped<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (error) {
    if (error instanceof WarehouseError) throw new AppError(error.code === "invalid" ? "invalid_input" : error.code, error.message)
    if (error instanceof ListError) throw new AppError("invalid_input", error.message)
    throw error
  }
}
