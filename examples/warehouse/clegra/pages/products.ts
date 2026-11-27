import { definePage } from "@clegra/sdk"

import { product } from "../entities/product"

export const products = definePage({ name: "products", title: { en: "Products", it: "Prodotti" }, icon: "package", list: product, columns: ["sku", "name", "category", "stock", "stockStatus", "salePrice", "purchaseCost"] })
