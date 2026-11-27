import { defineAction } from "@clegra/sdk"
import { z } from "zod"

import { courier } from "../courier"
import { shipment } from "../entities/shipment"
import { l } from "../labels"

// Run by the workspace host every 15 minutes (app.ts `schedules`), as the installation, with nobody at the screen.
export const checkDeliveries = defineAction({
  name: "check_deliveries",
  title: l("Check deliveries", "Controlla le consegne"),
  description: l(
    "Reads the courier's state of every shipment and tells whoever sees shipments of each delivery and each delay, once",
    "Legge dal corriere lo stato di ogni spedizione e avvisa, una volta, chi vede le spedizioni di ogni consegna e di ogni ritardo",
  ),
  icon: "bell-ring",
  input: z.object({}),
  // It changes nothing of the shipments (it remembers what was told): never asks.
  confirm: "never",
  permission: "shipments.view",
  // The host's machinery: never a model's tool.
  visibility: "app",
  run: (_input, ctx) => {
    const changes = courier().statusChanges(ctx.installation)
    for (const { shipment: s, status } of changes)
      ctx.notify(
        status === "delivered"
          ? { type: "delivered", title: l(`Delivered: ${s.trackingNumber}`, `Consegnata: ${s.trackingNumber}`), body: l(`To ${s.customer}, ${s.destination}.`, `A ${s.customer}, ${s.destination}.`), uri: ctx.uri(shipment, s.id), to: "admins" }
          : { type: "late", title: l(`Late: ${s.trackingNumber}`, `In ritardo: ${s.trackingNumber}`), body: l(`Expected on ${s.expectedDelivery} at ${s.customer}.`, `Prevista il ${s.expectedDelivery} da ${s.customer}.`), uri: ctx.uri(shipment, s.id), to: "admins" },
      )
    return { message: ctx.t(l(`${changes.length} shipments delivered or late since the last check.`, `${changes.length} spedizioni consegnate o in ritardo dall'ultimo controllo.`)), data: { told: changes.map((c) => c.shipment.id) } }
  },
})
