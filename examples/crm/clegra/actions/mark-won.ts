import { defineAction } from "@clegra/sdk"
import { z } from "zod"

import { markWon as closeWon } from "@/lib/crm"
import { deal } from "../entities/deal"
import { refused, tenant } from "../lib"

// The page's «Mark as won» button and this tool call the same markWon in lib/crm.ts.
export const markWon = defineAction({
  name: "mark_won",
  on: deal,
  title: { en: "Mark as won", it: "Segna come vinta" },
  description: { en: "Closes the deal as won. Only when the person says so", it: "Chiude la trattativa come vinta. Solo se la persona lo dice" },
  icon: "trophy",
  input: z.object({ note: z.string().max(500).optional().meta({ label: { en: "Note", it: "Nota" } }) }),
  confirm: true,
  permission: "deals.edit",
  run: async (input, ctx, record) => {
    await closeWon(await tenant(ctx), record.id, input).catch((e) => refused(e, ctx, { en: `${record.name} is already closed.`, it: `${record.name} è già chiusa.` }))
    ctx.notify({ title: { en: `Deal won: ${record.name}`, it: `Trattativa vinta: ${record.name}` }, uri: ctx.uri(deal, record.id) })
    return { message: ctx.t({ en: `${record.name} marked as won.`, it: `${record.name} segnata come vinta.` }), record: record.id }
  },
})
