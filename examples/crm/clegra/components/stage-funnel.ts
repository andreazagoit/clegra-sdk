import { defineComponent } from "@clegra/sdk"
import { z } from "zod"

// The CRM's own A2UI component (spec §5.4 rule 6): a page of the CRM that draws the props a host gives it, inside
// any A2UI surface, beside the host's native cards. The `funnel` artifact is drawn by it.
export const stageFunnel = defineComponent({
  name: "StageFunnel",
  title: { en: "Stage funnel", it: "Imbuto per fase" },
  description: { en: "Deals narrowing stage by stage, with their value", it: "Le trattative che si restringono fase per fase, con il loro valore" },
  props: z.object({ stages: z.array(z.object({ label: z.string(), count: z.number().int(), value: z.number().optional() })), currency: z.string().optional() }),
  view: { html: () => import("../funnel-view").then((m) => m.funnelHtml) },
})
