// What the CRM's Clegra files share: the tenant of a call, its refusals in the caller's language.
import { AppError, type Context } from "@clegra/sdk"

import { CrmError } from "@/lib/crm"
import { STAGE_WORDS } from "@/lib/format"

/** A deal's stage in each language the CRM speaks. */
export const stageLabels = STAGE_WORDS

/**
 * The tenant of this call: `ctx.installation`, from the verified token: the organization of the CRM's own user the
 * token was issued to (any client acts with a token of the CRM's own sign-in).
 */
export async function tenant(ctx: Pick<Context, "installation">): Promise<string> {
  return ctx.installation
}

/** The CRM's refusals in the caller's language; anything else stays an internal error. */
export function refused(error: unknown, ctx: Context, closed?: { en: string; it: string }): never {
  if (!(error instanceof CrmError)) throw error
  if (error.code === "closed" && closed) throw new AppError("conflict", ctx.t(closed))
  if (error.code === "not_found") throw new AppError("not_found", ctx.t({ en: "Not found.", it: "Non trovato." }))
  throw new AppError("invalid_input", error.message)
}
