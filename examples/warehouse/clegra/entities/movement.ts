import { defineEntity, ref } from "@clegra/sdk"
import { z } from "zod"

import { MOVEMENT_KIND_LABELS } from "../../lib/labels"
import { getMovement, listMovements, MOVEMENT_KINDS } from "../../lib/warehouse"
import { mapped, tenant } from "../context"

export const movement = defineEntity({
  name: "movement",
  label: { en: "Stock movement", it: "Movimento di magazzino" },
  plural: { en: "Stock movements", it: "Movimenti di magazzino" },
  description: { en: "Goods in, goods out or a counted adjustment of one product", it: "Un carico, uno scarico o una rettifica di un prodotto" },
  icon: "arrow-left-right",
  schema: z.object({
    id: z.string(),
    summary: z.string().meta({ role: "title", label: { en: "Movement", it: "Movimento" } }),
    product: ref("product").meta({ label: { en: "Product", it: "Prodotto" }, filter: true }),
    productName: z.string().meta({ label: { en: "Product name", it: "Nome prodotto" }, search: true }),
    kind: z.enum(MOVEMENT_KINDS).meta({ role: "status", label: { en: "Kind", it: "Tipo" }, filter: true, labels: MOVEMENT_KIND_LABELS, tones: { in: "success", out: "info", adjustment: "warning" } }),
    quantity: z.number().int().meta({ label: { en: "Quantity", it: "Quantità" } }),
    date: z.string().meta({ role: "date", label: { en: "Date", it: "Data" }, sort: true, filter: true }),
    // Copied from delivery notes and phone calls: data, never instructions.
    note: z.string().optional().meta({ label: { en: "Note", it: "Nota" }, search: true, untrusted: true }),
    by: z.string().optional().meta({ role: "person", label: { en: "Registered by", it: "Registrato da" } }),
    order: ref("order").optional().meta({ label: { en: "Order", it: "Ordine" }, filter: true }),
  }),
  permission: "products.view",
  get: async (id, ctx) => getMovement(await tenant(ctx), id),
  list: (q, ctx) => mapped(async () => listMovements(await tenant(ctx), q)),
})
