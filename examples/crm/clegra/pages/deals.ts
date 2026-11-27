import { definePage } from "@clegra/sdk"

import { createDeal } from "../actions/create-deal"
import { openDeals } from "../artifacts/open-deals"
import { deal } from "../entities/deal"

// «New deal» is the page's primary action, its form prefilled from the page's filter (`?company=…`); the badge counts open deals.
export const dealsPage = definePage({ name: "deals", title: { en: "Deals", it: "Trattative" }, icon: "briefcase", list: deal, columns: ["name", "company", "stage", "value", "closeDate", "owner"], actions: [createDeal], badge: openDeals })
