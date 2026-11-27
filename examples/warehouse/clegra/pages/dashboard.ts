import { definePage } from "@clegra/sdk"

import { lowStock } from "../artifacts/low-stock"
import { stockValue } from "../artifacts/stock-value"
import { unitsOutByWeek } from "../artifacts/units-out-by-week"

export const dashboard = definePage({
  name: "dashboard",
  title: { en: "Warehouse", it: "Magazzino" },
  icon: "layout-dashboard",
  dashboard: [
    { artifact: stockValue, params: {}, size: "small" },
    { artifact: lowStock, params: { limit: 8 } },
    { artifact: unitsOutByWeek, params: { weeks: 8 } },
  ],
})
