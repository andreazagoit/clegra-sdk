import { defineArtifact } from "@clegra/sdk"
import { z } from "zod"

import { stockValue as valueOf } from "../../lib/warehouse"
import { tenant } from "../context"

export const stockValue = defineArtifact({
  name: "stock_value",
  title: { en: "Stock value", it: "Valore del magazzino" },
  description: { en: "What the stock on hand cost to buy", it: "Quanto è costata la merce in magazzino" },
  params: z.object({}),
  permission: "products.cost",
  size: "small",
  template: "stat",
  data: async (_p, ctx) => {
    const v = await valueOf(await tenant(ctx))
    return { label: ctx.t({ en: `${v.units} units of ${v.products} products, at purchase cost`, it: `${v.units} unità di ${v.products} prodotti, a costo d'acquisto` }), value: v.value, format: "money", currency: "EUR" }
  },
})
