import { defineArtifact } from "@clegra/sdk"
import { z } from "zod"

import { SHIPMENT_STATUSES } from "../../courier"
import { courier } from "../courier"
import { l, SHIPMENT_STATUS_LABELS } from "../labels"

export const shipmentsByStatus = defineArtifact({
  name: "shipments_by_status",
  title: l("Shipments by status", "Spedizioni per stato"),
  description: l("How many shipments are in transit, late and delivered", "Quante spedizioni sono in transito, in ritardo e consegnate"),
  icon: "chart-pie",
  params: z.object({}),
  permission: "shipments.view",
  template: "chart",
  data: (_p, ctx) => ({
    kind: "pie",
    points: SHIPMENT_STATUSES.map((status) => ({ label: ctx.t(SHIPMENT_STATUS_LABELS[status]), value: courier().shipments(ctx.installation).filter((s) => s.status === status).length })),
    format: "number",
  }),
})
