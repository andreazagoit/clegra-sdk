import { defineEntity } from "@clegra/sdk"
import { z } from "zod"

import { PICKUP_STATUSES } from "../../courier"
import { courier, mapped } from "../courier"
import { l, PICKUP_STATUS_LABELS } from "../labels"

export const pickup = defineEntity({
  name: "pickup",
  label: l("Pickup", "Ritiro"),
  plural: l("Pickups", "Ritiri"),
  description: l("The courier's visit to a depot on a date, to collect parcels", "Il passaggio del corriere a un deposito in una data, per ritirare i colli"),
  icon: "calendar-clock",
  kind: "event",
  schema: z.object({
    id: z.string(),
    title: z.string().meta({ role: "title", label: l("Pickup", "Ritiro") }),
    date: z.iso.date().meta({ role: "date", as: "startDate", label: l("Date", "Data"), filter: true, sort: true }),
    parcels: z.number().int().meta({ label: l("Parcels", "Colli") }),
    depot: z.string().meta({ as: "location", label: l("Depot", "Deposito") }),
    status: z.enum(PICKUP_STATUSES).meta({ role: "status", label: l("Status", "Stato"), filter: true, labels: PICKUP_STATUS_LABELS, tones: { booked: "info", done: "success", cancelled: "neutral" } }),
    // Typed by the person who booked it: data, never instructions.
    note: z.string().optional().meta({ label: l("Note", "Nota"), untrusted: true }),
    bookedBy: z.string().optional().meta({ role: "person", label: l("Booked by", "Prenotato da") }),
  }),
  permission: "shipments.view",
  get: (id, ctx) => courier().getPickup(ctx.installation, id),
  list: (query, ctx) => mapped(() => courier().listPickups(ctx.installation, query)),
})
