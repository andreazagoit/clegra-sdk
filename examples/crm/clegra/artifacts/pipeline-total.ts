import { defineArtifact } from "@clegra/sdk"
import { z } from "zod"

import { openPipeline } from "@/lib/crm"
import { tenant } from "../lib"

export const pipelineTotal = defineArtifact({
  name: "pipeline_total",
  title: { en: "Open pipeline", it: "Pipeline aperta" },
  description: { en: "The total value of open deals", it: "Il valore totale delle trattative aperte" },
  params: z.object({}),
  permission: "deals.values",
  template: "stat",
  data: async (_p, ctx) => {
    const open = await openPipeline(await tenant(ctx))
    return { label: ctx.t(open.count === 1 ? { en: "1 open deal", it: "1 trattativa aperta" } : { en: `${open.count} open deals`, it: `${open.count} trattative aperte` }), value: open.value, format: "money", currency: "EUR" }
  },
})
