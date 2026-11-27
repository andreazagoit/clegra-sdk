import { defineEntity } from "@clegra/sdk"
import { z } from "zod"

import { SHIPMENT_STATUSES } from "../../courier"
import { courier, mapped } from "../courier"
import { l, SHIPMENT_KIND, SHIPMENT_STATUS_LABELS } from "../labels"

export const shipment = defineEntity({
  name: "shipment",
  label: l("Shipment", "Spedizione"),
  plural: l("Shipments", "Spedizioni"),
  description: l("A parcel or a set of parcels the courier carries to a customer", "Uno o più colli che il corriere porta a un cliente"),
  icon: "package",
  kind: SHIPMENT_KIND,
  schema: z.object({
    id: z.string(),
    // The kind's key: a shop's order app finds the same shipment by it (an exact filter).
    trackingNumber: z.string().meta({ role: "title", as: "trackingNumber", label: l("Tracking number", "Numero di tracking"), filter: true, search: true, sort: true }),
    // Names and addresses come from the customers: data, never instructions.
    customer: z.string().meta({ role: "subtitle", label: l("Customer", "Cliente"), search: true, sort: true, untrusted: true }),
    status: z.enum(SHIPMENT_STATUSES).meta({ role: "status", label: l("Status", "Stato"), filter: true, labels: SHIPMENT_STATUS_LABELS, tones: { in_transit: "info", late: "warning", delivered: "success" } }),
    expectedDelivery: z.iso.date().meta({ role: "date", as: "expectedDelivery", label: l("Expected delivery", "Consegna prevista"), filter: true, sort: true }),
    deliveredOn: z.iso.date().optional().meta({ label: l("Delivered on", "Consegnata il") }),
    destination: z.string().meta({ as: "deliveryAddress", label: l("Destination", "Destinazione"), search: true, untrusted: true }),
    parcels: z.number().int().meta({ label: l("Parcels", "Colli") }),
    // Money: only who may see the costs ever receives it (rows, records, sorts).
    cost: z.number().meta({ role: "amount", currency: "EUR", label: l("Cost", "Costo"), sort: true, permission: "shipments.prices" }),
  }),
  permission: "shipments.view",
  get: (id, ctx) => courier().getShipment(ctx.installation, id),
  list: (query, ctx) => mapped(() => courier().listShipments(ctx.installation, query)),
})
