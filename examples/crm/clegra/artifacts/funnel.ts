import { defineArtifact } from "@clegra/sdk"
import { z } from "zod"

import { pipelineByStage } from "@/lib/crm"
import { createDeal } from "../actions/create-deal"
import { stageFunnel } from "../components/stage-funnel"
import { stageLabels, tenant } from "../lib"

export const funnel = defineArtifact({
  name: "funnel",
  title: { en: "Pipeline funnel", it: "Imbuto della pipeline" },
  description: { en: "How many deals are in each stage, as a funnel", it: "Quante trattative ci sono in ogni fase, come un imbuto" },
  params: z.object({}),
  permission: "deals.view",
  component: stageFunnel,
  actions: [createDeal],
  data: async (_p, ctx) => {
    // Values only for who may see them (`deals.values`): the component draws what it gets.
    const money = ctx.can("deals.values")
    const stages = (await pipelineByStage(await tenant(ctx))).map((s) => ({ label: ctx.t(stageLabels[s.stage]), count: s.count, ...(money ? { value: s.value } : {}) }))
    return { stages, currency: "EUR" }
  },
})
