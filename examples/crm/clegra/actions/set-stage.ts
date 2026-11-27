import { defineAction } from "@clegra/sdk"
import { z } from "zod"

import { setStage as moveStage } from "@/lib/crm"
import { deal } from "../entities/deal"
import { refused, stageLabels, tenant } from "../lib"

export const setStage = defineAction({
  name: "set_stage",
  on: deal,
  title: { en: "Move to stage", it: "Sposta di fase" },
  description: { en: "Moves an open deal to another open stage, or to lost", it: "Sposta una trattativa aperta in un'altra fase aperta, o tra le perse" },
  input: z.object({ stage: z.enum(["lead", "qualified", "proposal", "lost"]).meta({ label: { en: "Stage", it: "Fase" }, labels: stageLabels }) }),
  confirm: "optional",
  permission: "deals.edit",
  run: async (input, ctx, record) => {
    await moveStage(await tenant(ctx), record.id, input.stage).catch((e) => refused(e, ctx, { en: "Closed deals don't move.", it: "Le trattative chiuse non si spostano." }))
    return { message: ctx.t({ en: `${record.name}: now ${stageLabels[input.stage].en}.`, it: `${record.name}: ora ${stageLabels[input.stage].it}.` }), record: record.id }
  },
})
