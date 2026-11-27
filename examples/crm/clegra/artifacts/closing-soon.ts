import { defineArtifact } from "@clegra/sdk"
import { z } from "zod"

import { closingSoon as dealsClosing } from "@/lib/crm"
import { createDeal } from "../actions/create-deal"
import { deal } from "../entities/deal"
import { stageLabels, tenant } from "../lib"

export const closingSoon = defineArtifact({
  name: "closing_soon",
  title: { en: "Closing soon", it: "In chiusura" },
  description: { en: "Open deals closing within some days", it: "Trattative aperte che chiudono entro alcuni giorni" },
  params: z.object({ days: z.number().int().min(1).max(365).default(60) }),
  permission: "deals.view",
  template: "list",
  // Deal names are outsiders' text.
  untrusted: true,
  actions: [createDeal],
  data: async (p, ctx) => ({
    items: (await dealsClosing(await tenant(ctx), p.days))
      // The date as people read it, in the caller's language (a template's texts are shown as they are).
      .map((d) => ({ title: d.name, subtitle: new Intl.DateTimeFormat(ctx.locale, { dateStyle: "medium" }).format(new Date(`${d.closeDate}T12:00:00`)), status: ctx.t(stageLabels[d.stage]), uri: ctx.uri(deal, d.id) })),
  }),
})
