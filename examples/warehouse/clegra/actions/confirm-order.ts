import { defineAction } from "@clegra/sdk"
import { z } from "zod"

import { confirmOrder } from "../../lib/warehouse"
import { actor, mapped, tenant } from "../context"
import { order } from "../entities/order"

export const confirmOrderAction = defineAction({
  name: "confirm_order",
  on: order,
  title: { en: "Confirm order", it: "Conferma ordine" },
  description: { en: "Confirms a draft order: all its goods leave the warehouse at once", it: "Conferma un ordine in bozza: tutta la merce esce dal magazzino insieme" },
  icon: "check",
  input: z.object({}),
  // Moves stock and can't be undone from here: the person always confirms first.
  confirm: "always",
  permission: "orders.manage",
  // Exposed to plain clients too (spec §7): one that can elicit is asked to confirm by the server itself; the others
  // get `destructiveHint: true` on the tool, which ChatGPT and Claude turn into their own approval. A double call is
  // safe either way: a confirmed order refuses a second confirmation (conflict).
  run: (_input, ctx, record) =>
    mapped(async () => {
      const t = await tenant(ctx)
      const done = await confirmOrder(t, await actor(t, ctx), record.id)
      return { message: ctx.t({ en: `Order ${done.number} confirmed: the goods left the warehouse.`, it: `Ordine ${done.number} confermato: la merce è uscita dal magazzino.` }), record: ctx.uri(order, done.id) }
    }),
})
