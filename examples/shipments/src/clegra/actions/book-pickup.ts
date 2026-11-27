import { defineAction } from "@clegra/sdk"
import { z } from "zod"

import { courier, depotOf, mapped } from "../courier"
import { pickup } from "../entities/pickup"
import { l } from "../labels"

export const bookPickup = defineAction({
  name: "book_pickup",
  title: l("Book a pickup", "Prenota un ritiro"),
  description: l("Books the courier's pickup at the company's depot on a date, today or later", "Prenota il ritiro del corriere al deposito dell'azienda in una data, oggi o più avanti"),
  icon: "calendar-plus",
  input: z.object({
    date: z.iso.date().meta({ label: l("Date", "Data") }),
    parcels: z.number().int().min(1).max(500).meta({ label: l("Parcels", "Colli") }),
    note: z.string().max(300).optional().meta({ label: l("Note for the courier", "Nota per il corriere") }),
  }),
  // The courier comes and charges for it: the person always confirms first.
  confirm: "always",
  permission: "shipments.book",
  run: (input, ctx) =>
    mapped(() => {
      const made = courier().bookPickup(ctx.installation, { ...input, depot: depotOf(ctx), ...(ctx.person ? { by: ctx.person } : {}) })
      return { message: ctx.t(l(`Pickup ${made.id} booked for ${made.date}: ${made.parcels} parcels from ${made.depot}.`, `Ritiro ${made.id} prenotato per il ${made.date}: ${made.parcels} colli da ${made.depot}.`)), record: ctx.uri(pickup, made.id) }
    }),
})
