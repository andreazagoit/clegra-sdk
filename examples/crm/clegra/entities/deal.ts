import { defineEntity, ref } from "@clegra/sdk"
import { z } from "zod"

import { getDeal, listDeals, STAGES } from "@/lib/crm"
import { stageLabels, tenant } from "../lib"

export const deal = defineEntity({
  name: "deal",
  label: { en: "Deal", it: "Trattativa" },
  plural: { en: "Deals", it: "Trattative" },
  description: { en: "A sales opportunity with a company", it: "Un'opportunità di vendita con un'azienda" },
  icon: "briefcase",
  schema: z.object({
    id: z.string(),
    name: z.string().meta({ role: "title", label: { en: "Deal", it: "Trattativa" }, search: true, untrusted: true }),
    company: ref("company").meta({ label: { en: "Company", it: "Azienda" }, filter: true }),
    stage: z.enum(STAGES).meta({ role: "status", label: { en: "Stage", it: "Fase" }, filter: true, labels: stageLabels, tones: { lead: "neutral", qualified: "info", proposal: "warning", won: "success", lost: "danger" } }),
    value: z.number().meta({ role: "amount", currency: "EUR", label: { en: "Value", it: "Valore" }, sort: true, permission: "deals.values" }),
    closeDate: z.string().meta({ role: "date", label: { en: "Close date", it: "Chiusura prevista" }, sort: true, filter: true }),
    owner: z.string().meta({ role: "person", label: { en: "Owner", it: "Responsabile" } }),
  }),
  permission: "deals.view",
  get: async (id, ctx) => {
    const found = await getDeal(await tenant(ctx), id)
    if (!found) return null
    const { wonNote: _, ...fields } = found
    return fields
  },
  list: async (q, ctx) => listDeals(await tenant(ctx), q),
})
