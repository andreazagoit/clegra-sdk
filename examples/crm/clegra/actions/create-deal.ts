import { AppError, defineAction, ref } from "@clegra/sdk"
import { z } from "zod"

import { createDeal as addDeal, CrmError } from "@/lib/crm"
import { deal } from "../entities/deal"
import { tenant } from "../lib"

export const createDeal = defineAction({
  name: "create_deal",
  title: { en: "New deal", it: "Nuova trattativa" },
  description: { en: "Creates a deal for a company", it: "Crea una trattativa per un'azienda" },
  icon: "plus",
  input: z.object({
    name: z.string().min(2).max(120).meta({ label: { en: "Name", it: "Nome" } }),
    company: ref("company").meta({ label: { en: "Company", it: "Azienda" } }),
    value: z.number().min(0).meta({ label: { en: "Value", it: "Valore" }, currency: "EUR" }),
    closeDate: z.iso.date().meta({ label: { en: "Close date", it: "Chiusura prevista" } }),
  }),
  permission: "deals.edit",
  run: async (input, ctx) => {
    const owner = { id: ctx.person?.id ?? "unknown" }
    const added = await addDeal(await tenant(ctx), owner, input).catch((e) => {
      if (e instanceof CrmError && e.code === "unknown_company") throw new AppError("invalid_input", ctx.t({ en: `Unknown company ${input.company}.`, it: `Azienda ${input.company} sconosciuta.` }))
      throw e
    })
    return { message: ctx.t({ en: `Deal «${input.name}» created.`, it: `Trattativa «${input.name}» creata.` }), record: ctx.uri(deal, added.id) }
  },
})
