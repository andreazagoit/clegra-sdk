import { defineArtifact } from "@clegra/sdk"
import { z } from "zod"

import { outgoingByWeek } from "../../lib/warehouse"
import { tenant } from "../context"

export const unitsOutByWeek = defineArtifact({
  name: "units_out_by_week",
  title: { en: "Units out per week", it: "Unità uscite per settimana" },
  description: { en: "How many units left the warehouse in each of the last weeks", it: "Quante unità sono uscite dal magazzino in ciascuna delle ultime settimane" },
  params: z.object({ weeks: z.number().int().min(2).max(26).default(8).meta({ label: { en: "Weeks", it: "Settimane" } }) }),
  permission: "products.view",
  template: "chart",
  data: async ({ weeks }, ctx) => ({ kind: "bar", points: (await outgoingByWeek(await tenant(ctx), weeks)).map((w) => ({ label: w.week, value: w.units })), format: "number" }),
})
