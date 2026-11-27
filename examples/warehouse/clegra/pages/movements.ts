import { definePage } from "@clegra/sdk"

import { movement } from "../entities/movement"

export const movements = definePage({ name: "movements", title: { en: "Stock movements", it: "Movimenti" }, icon: "arrow-left-right", list: movement, columns: ["date", "summary", "kind", "note", "by"] })
