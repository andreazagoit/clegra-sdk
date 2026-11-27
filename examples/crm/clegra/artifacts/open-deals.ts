import { defineArtifact } from "@clegra/sdk"
import { z } from "zod"

import { openPipeline } from "@/lib/crm"
import { tenant } from "../lib"

// The deals page's badge (a stat artifact: its value is the count).
export const openDeals = defineArtifact({
  name: "open_deals",
  title: { en: "Open deals", it: "Trattative aperte" },
  description: { en: "How many deals are open", it: "Quante trattative sono aperte" },
  params: z.object({}),
  permission: "deals.view",
  // A count for the navigation, not something a model needs: views and the host call it, models never get it.
  visibility: "app",
  template: "stat",
  data: async (_p, ctx) => {
    const open = await openPipeline(await tenant(ctx))
    return { label: ctx.t({ en: "Open deals", it: "Trattative aperte" }), value: open.count, format: "number" }
  },
})
