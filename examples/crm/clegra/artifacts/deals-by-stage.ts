import { defineArtifact } from "@clegra/sdk"
import { z } from "zod"

import { pipelineByStage } from "@/lib/crm"
import { stageLabels, tenant } from "../lib"

export const dealsByStage = defineArtifact({
  name: "deals_by_stage",
  title: { en: "Deals by stage", it: "Trattative per fase" },
  description: { en: "How many deals are in each stage", it: "Quante trattative ci sono in ogni fase" },
  params: z.object({}),
  permission: "deals.view",
  template: "chart",
  data: async (_p, ctx) => ({ kind: "bar", points: (await pipelineByStage(await tenant(ctx))).map((s) => ({ label: ctx.t(stageLabels[s.stage]), value: s.count })) }),
})
