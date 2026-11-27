import { defineArtifact } from "@clegra/sdk"
import { z } from "zod"

import { courier } from "../courier"
import { l } from "../labels"

export const shippingCosts = defineArtifact({
  name: "shipping_costs",
  title: l("Shipping costs", "Costi di spedizione"),
  description: l("What the shipments in the list cost", "Quanto costano le spedizioni dell'elenco"),
  icon: "euro",
  params: z.object({}),
  permission: "shipments.prices",
  size: "small",
  template: "stat",
  data: (_p, ctx) => {
    const shipments = courier().shipments(ctx.installation)
    return { label: ctx.t(l(`${shipments.length} shipments`, `${shipments.length} spedizioni`)), value: Math.round(shipments.reduce((sum, s) => sum + s.cost, 0) * 100) / 100, format: "money", currency: "EUR" }
  },
})
