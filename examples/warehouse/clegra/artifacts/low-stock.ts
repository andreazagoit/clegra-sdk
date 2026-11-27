import { defineArtifact } from "@clegra/sdk"
import { z } from "zod"

import { STOCK_STATUS_LABELS } from "../../lib/labels"
import { lowStock as lowOf } from "../../lib/warehouse"
import { tenant } from "../context"
import { product } from "../entities/product"

export const lowStock = defineArtifact({
  name: "low_stock",
  title: { en: "Low stock", it: "Sotto scorta" },
  description: { en: "Products at or under their reorder level, emptiest first", it: "Prodotti alla scorta minima o sotto, i più vuoti per primi" },
  params: z.object({ limit: z.number().int().min(1).max(20).default(8).meta({ label: { en: "How many", it: "Quanti" } }) }),
  permission: "products.view",
  template: "list",
  data: async ({ limit }, ctx) => ({
    items: (await lowOf(await tenant(ctx), limit)).map((p) => ({
      title: p.name,
      subtitle: ctx.t({ en: `${p.stock} in stock, reorder at ${p.reorderLevel}`, it: `${p.stock} in giacenza, scorta minima ${p.reorderLevel}` }),
      status: ctx.t(STOCK_STATUS_LABELS[p.stockStatus]),
      uri: ctx.uri(product, p.id),
    })),
  }),
})
