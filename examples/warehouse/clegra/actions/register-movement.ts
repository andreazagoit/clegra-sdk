import { defineAction } from "@clegra/sdk"
import { z } from "zod"

import { MOVEMENT_KIND_LABELS } from "../../lib/labels"
import { MOVEMENT_KINDS, registerMovement } from "../../lib/warehouse"
import { actor, mapped, tenant } from "../context"
import { movement } from "../entities/movement"
import { product } from "../entities/product"

// Writes reach every client the warehouse's own sign-in linked (Clegra, ChatGPT, Claude).
export const registerMovementAction = defineAction({
  name: "register_movement",
  on: product,
  title: { en: "Register a movement", it: "Registra un movimento" },
  description: {
    en: "Records goods in, goods out, or a counted adjustment (signed: -2 for two missing) of this product",
    it: "Registra un carico, uno scarico o una rettifica di inventario (con segno: -2 se ne mancano due) di questo prodotto",
  },
  icon: "arrow-left-right",
  input: z.object({
    kind: z.enum(MOVEMENT_KINDS).meta({ label: { en: "Kind", it: "Tipo" }, labels: MOVEMENT_KIND_LABELS }),
    quantity: z.number().int().min(-100_000).max(100_000).meta({ label: { en: "Quantity", it: "Quantità" } }),
    note: z.string().max(500).optional().meta({ label: { en: "Note", it: "Nota" } }),
  }),
  // Undone by another movement: the host decides whether to ask first.
  confirm: "optional",
  permission: "stock.move",
  run: (input, ctx, record) =>
    mapped(async () => {
      const t = await tenant(ctx)
      const { movement: made, stock } = await registerMovement(t, await actor(t, ctx), { productId: record.id, kind: input.kind, quantity: input.quantity, note: input.note })
      return { message: ctx.t({ en: `Registered ${made.summary}. Now ${stock} in stock.`, it: `Registrato ${made.summary}. Giacenza: ${stock}.` }), record: ctx.uri(movement, made.id), data: { stock } }
    }),
})
