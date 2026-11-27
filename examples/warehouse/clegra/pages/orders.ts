import { definePage } from "@clegra/sdk"

import { createOrderAction } from "../actions/create-order"
import { order } from "../entities/order"

export const orders = definePage({ name: "orders", title: { en: "Orders", it: "Ordini" }, icon: "receipt", list: order, actions: [createOrderAction], columns: ["number", "customer", "date", "status", "total"] })
