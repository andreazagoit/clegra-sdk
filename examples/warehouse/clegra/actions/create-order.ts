import { defineAction, ref } from "@clegra/sdk"
import { z } from "zod"

import { createOrder } from "../../lib/warehouse"
import { actor, mapped, tenant } from "../context"
import { order } from "../entities/order"

export const createOrderAction = defineAction({
  name: "create_order",
  title: { en: "New order", it: "Nuovo ordine" },
  description: { en: "Creates a draft order for a customer at today's prices; nothing leaves the warehouse until it is confirmed", it: "Crea un ordine in bozza per un cliente ai prezzi di oggi; nulla esce dal magazzino finché non è confermato" },
  icon: "plus",
  input: z.object({
    customer: z.string().min(2).max(120).meta({ label: { en: "Customer", it: "Cliente" } }),
    lines: z
      .array(z.object({ product: ref("product").meta({ label: { en: "Product", it: "Prodotto" } }), quantity: z.number().int().min(1).max(100_000).meta({ label: { en: "Quantity", it: "Quantità" } }) }))
      .min(1)
      .max(50)
      .meta({ label: { en: "Lines", it: "Righe" } }),
  }),
  // Only a draft: the host decides whether to ask first.
  confirm: "optional",
  permission: "orders.manage",
  run: (input, ctx) =>
    mapped(async () => {
      const t = await tenant(ctx)
      const made = await createOrder(t, await actor(t, ctx), { customer: input.customer, lines: input.lines.map((l) => ({ productId: l.product, quantity: l.quantity })) })
      return { message: ctx.t({ en: `Draft order ${made.number} created.`, it: `Ordine ${made.number} creato in bozza.` }), record: ctx.uri(order, made.id) }
    }),
})
