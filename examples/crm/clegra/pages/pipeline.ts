import { definePage } from "@clegra/sdk"
import { z } from "zod"

import { closingSoon } from "../artifacts/closing-soon"
import { dealsByStage } from "../artifacts/deals-by-stage"
import { funnel } from "../artifacts/funnel"
import { pipelineTotal } from "../artifacts/pipeline-total"

export const pipelinePage = definePage({
  name: "pipeline",
  title: { en: "Pipeline", it: "Pipeline" },
  icon: "chart-column",
  permission: "deals.view",
  params: z.object({ days: z.number().int().min(1).max(365).optional() }),
  dashboard: (p) => [
    { artifact: pipelineTotal, size: "small" },
    { artifact: dealsByStage, size: "medium" },
    { artifact: closingSoon, params: { days: p.days ?? 60 }, size: "medium" },
    { artifact: funnel, size: "medium" },
  ],
})
