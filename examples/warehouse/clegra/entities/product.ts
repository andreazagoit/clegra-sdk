import { defineEntity } from "@clegra/sdk"
import { z } from "zod"

import { CATEGORY_LABELS, STOCK_STATUS_LABELS, UNIT_LABELS } from "../../lib/labels"
import { CATEGORIES, getProduct, listProducts, STOCK_STATUSES, UNITS } from "../../lib/warehouse"
import { mapped, tenant } from "../context"

export const product = defineEntity({
  name: "product",
  label: { en: "Product", it: "Prodotto" },
  plural: { en: "Products", it: "Prodotti" },
  description: { en: "An article the shop keeps in stock", it: "Un articolo che il negozio tiene a magazzino" },
  icon: "package",
  kind: "product",
  schema: z.object({
    id: z.string(),
    name: z.string().meta({ role: "title", label: { en: "Name", it: "Nome" }, search: true, sort: true }),
    // Kind product: the SKU, the GTIN (its key: other apps find the same product by it, an exact filter), the price.
    sku: z.string().meta({ role: "subtitle", as: "sku", label: "SKU", search: true, sort: true }),
    gtin: z.string().optional().meta({ as: "gtin", label: "GTIN", filter: true }),
    category: z.enum(CATEGORIES).meta({ label: { en: "Category", it: "Categoria" }, filter: true, labels: CATEGORY_LABELS }),
    unit: z.enum(UNITS).meta({ label: { en: "Unit", it: "Unità" }, labels: UNIT_LABELS }),
    stock: z.number().int().meta({ label: { en: "In stock", it: "Giacenza" }, sort: true, filter: true }),
    reorderLevel: z.number().int().meta({ label: { en: "Reorder level", it: "Scorta minima" } }),
    stockStatus: z.enum(STOCK_STATUSES).meta({ role: "status", label: { en: "Stock", it: "Disponibilità" }, filter: true, labels: STOCK_STATUS_LABELS, tones: { ok: "success", low: "warning", out: "danger" } }),
    salePrice: z.number().meta({ role: "amount", as: "price", currency: "EUR", label: { en: "Sale price", it: "Prezzo di vendita" }, sort: true }),
    // What the shop pays: admins only, everywhere (rows, records, filters, sorts, search).
    purchaseCost: z.number().meta({ currency: "EUR", label: { en: "Purchase cost", it: "Costo d'acquisto" }, sort: true, filter: true, permission: "products.cost" }),
  }),
  permission: "products.view",
  get: async (id, ctx) => getProduct(await tenant(ctx), id),
  list: (q, ctx) => mapped(async () => listProducts(await tenant(ctx), q)),
})
