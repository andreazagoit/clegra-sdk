import { defineArtifact } from "@clegra/sdk"
import { z } from "zod"

import { bookPickup } from "../actions/book-pickup"
import { courier } from "../courier"
import { pickup } from "../entities/pickup"
import { l, PICKUP_STATUS_LABELS } from "../labels"

export const upcomingPickups = defineArtifact({
  name: "upcoming_pickups",
  title: l("Upcoming pickups", "Prossimi ritiri"),
  description: l("The booked pickups, soonest first", "I ritiri prenotati, i più vicini per primi"),
  icon: "calendar-clock",
  params: z.object({ limit: z.number().int().min(1).max(20).default(5).meta({ label: l("How many", "Quanti") }) }),
  permission: "shipments.view",
  actions: [bookPickup],
  template: "list",
  data: ({ limit }, ctx) => ({
    items: courier()
      .pickups(ctx.installation)
      .filter((p) => p.status === "booked")
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
      .slice(0, limit)
      .map((p) => ({ title: p.title, subtitle: ctx.t(l(`${p.parcels} parcels from ${p.depot}`, `${p.parcels} colli da ${p.depot}`)), status: ctx.t(PICKUP_STATUS_LABELS[p.status]), uri: ctx.uri(pickup, p.id) })),
  }),
})
