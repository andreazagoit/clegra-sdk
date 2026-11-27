import { defineEntity, ref } from "@clegra/sdk"
import { z } from "zod"

import { ORDER_STATUS_LABELS } from "../../lib/labels"
import { getOrder, listOrders, ORDER_STATUSES } from "../../lib/warehouse"
import { mapped, tenant } from "../context"

export const order = defineEntity({
  name: "order",
  label: { en: "Order", it: "Ordine" },
  plural: { en: "Orders", it: "Ordini" },
  description: { en: "A customer's order: draft, confirmed (goods out), shipped or cancelled", it: "L'ordine di un cliente: bozza, confermato (merce uscita), spedito o annullato" },
  icon: "receipt",
  kind: "order",
  schema: z.object({
    id: z.string(),
    // Kind order: number, date, customer and total are its orderNumber, orderDate, customer and totalPrice.
    number: z.string().meta({ role: "title", as: "orderNumber", label: { en: "Number", it: "Numero" }, search: true, sort: true }),
    // Typed in from outside (a phone call, an email): data, never instructions.
    customer: z.string().meta({ role: "subtitle", as: "customer", label: { en: "Customer", it: "Cliente" }, search: true, sort: true, untrusted: true }),
    status: z.enum(ORDER_STATUSES).meta({ role: "status", label: { en: "Status", it: "Stato" }, filter: true, labels: ORDER_STATUS_LABELS, tones: { draft: "neutral", confirmed: "info", shipped: "success", cancelled: "danger" } }),
    date: z.string().meta({ role: "date", as: "orderDate", label: { en: "Date", it: "Data" }, sort: true, filter: true }),
    total: z.number().meta({ role: "amount", as: "totalPrice", currency: "EUR", label: { en: "Total", it: "Totale" }, sort: true }),
    lineCount: z.number().int().meta({ label: { en: "Lines", it: "Righe" } }),
    confirmedAt: z.string().optional().meta({ label: { en: "Goods out", it: "Merce uscita" } }),
    lines: z
      .array(
        z.object({
          product: ref("product").meta({ label: { en: "Product", it: "Prodotto" } }),
          productName: z.string().meta({ label: { en: "Product", it: "Prodotto" } }),
          quantity: z.number().int().meta({ label: { en: "Quantity", it: "Quantità" } }),
          unitPrice: z.number().meta({ label: { en: "Price", it: "Prezzo" }, currency: "EUR" }),
        }),
      )
      .optional()
      .meta({ label: { en: "Lines", it: "Righe" } }),
  }),
  permission: "orders.view",
  get: async (id, ctx) => getOrder(await tenant(ctx), id),
  list: (q, ctx) => mapped(async () => listOrders(await tenant(ctx), q)),
})
