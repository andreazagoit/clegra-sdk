import { defineAction } from "@clegra/sdk"
import { z } from "zod"

import { stockAlerts } from "../../lib/warehouse"
import { mapped, tenant } from "../context"
import { product } from "../entities/product"

// Run by the workspace host every hour (app.ts `schedules`), as the installation, with nobody at the screen.
export const checkLowStock = defineAction({
  name: "check_low_stock",
  title: { en: "Check low stock", it: "Controlla le scorte" },
  description: {
    en: "Finds the products at or under their reorder level and tells the people who register stock about each one once, until it is back in stock",
    it: "Trova i prodotti alla scorta minima o sotto e lo dice, una volta per prodotto finché non torna disponibile, a chi registra i movimenti",
  },
  icon: "bell-ring",
  input: z.object({}),
  // It records which products were told about, nothing of the warehouse: never asks.
  confirm: "never",
  permission: "products.view",
  // The host's machinery: never a model's tool.
  visibility: "app",
  run: (_input, ctx) =>
    mapped(async () => {
      const { low, fresh } = await stockAlerts(await tenant(ctx))
      for (const p of fresh)
        ctx.notify({
          type: "low_stock",
          title: p.stockStatus === "out" ? { en: `Out of stock: ${p.name}`, it: `Esaurito: ${p.name}` } : { en: `Low stock: ${p.name}`, it: `Sotto scorta: ${p.name}` },
          body: { en: `${p.stock} in stock, reorder level ${p.reorderLevel}.`, it: `${p.stock} in giacenza, scorta minima ${p.reorderLevel}.` },
          uri: ctx.uri(product, p.id),
          to: "admins",
        })
      return {
        message: ctx.t({ en: `${low.length} products at or under their reorder level, ${fresh.length} newly.`, it: `${low.length} prodotti alla scorta minima o sotto, ${fresh.length} da adesso.` }),
        data: { low: low.length, told: fresh.map((p) => p.id) },
      }
    }),
})
