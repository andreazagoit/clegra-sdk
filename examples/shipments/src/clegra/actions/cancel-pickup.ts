import { defineAction } from "@clegra/sdk"
import { z } from "zod"

import { courier, mapped } from "../courier"
import { pickup } from "../entities/pickup"
import { l } from "../labels"

export const cancelPickup = defineAction({
  name: "cancel_pickup",
  on: pickup,
  title: l("Cancel pickup", "Annulla il ritiro"),
  description: l("Cancels a booked pickup; the courier won't come", "Annulla un ritiro prenotato: il corriere non passa"),
  icon: "calendar-x",
  input: z.object({}),
  confirm: "always",
  permission: "shipments.book",
  run: (_input, ctx, record) =>
    mapped(() => {
      const cancelled = courier().cancelPickup(ctx.installation, record.id)
      return { message: ctx.t(l(`Pickup ${cancelled.id} on ${cancelled.date} cancelled.`, `Ritiro ${cancelled.id} del ${cancelled.date} annullato.`)), record: ctx.uri(pickup, cancelled.id) }
    }),
})
