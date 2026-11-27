import { defineArtifact } from "@clegra/sdk"
import { z } from "zod"

import { courier } from "../courier"
import { l } from "../labels"

export const lateShipments = defineArtifact({
  name: "late_shipments",
  title: l("Late shipments", "Spedizioni in ritardo"),
  description: l("How many shipments missed their expected delivery", "Quante spedizioni non sono arrivate alla consegna prevista"),
  icon: "clock-alert",
  params: z.object({}),
  permission: "shipments.view",
  size: "small",
  template: "stat",
  data: (_p, ctx) => {
    const late = courier().shipments(ctx.installation).filter((s) => s.status === "late").length
    return { label: ctx.t(l("Late shipments", "Spedizioni in ritardo")), value: late, format: "number" }
  },
})
