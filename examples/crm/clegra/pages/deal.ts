import { definePage } from "@clegra/sdk"

import { deal } from "../entities/deal"

// One deal's page, in two sections (every entity has a default record page; this one replaces the deal's).
export const dealPage = definePage({
  name: "deal",
  record: deal,
  sections: [
    { title: { en: "Deal", it: "Trattativa" }, fields: ["name", "company", "stage", "value"] },
    { title: { en: "Planning", it: "Pianificazione" }, fields: ["closeDate", "owner"] },
  ],
})
