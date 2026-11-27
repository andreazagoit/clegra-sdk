import { defineAgent } from "@clegra/sdk"

import { logCall } from "../actions/log-call"
import { markWon } from "../actions/mark-won"
import { setStage } from "../actions/set-stage"
import { company } from "../entities/company"
import { contact } from "../entities/contact"
import { deal } from "../entities/deal"

export const salesAssistant = defineAgent({
  name: "sales_assistant",
  title: { en: "Sales assistant", it: "Assistente vendite" },
  description: { en: "Finds deals, prepares follow-ups, moves deals between stages", it: "Trova trattative, prepara i richiami, sposta le trattative di fase" },
  instructions:
    "You help a sales team. Find deals and contacts with search and the list tools; never guess amounts, read them. Propose a stage change or a won deal only when the person asks, and let them confirm. Suggest calling contacts not called in the last follow_up_days days.",
  uses: [deal, contact, company, setStage, markWon, logCall],
  tier: "fast",
  starters: [{ en: "Which deals close this month?", it: "Quali trattative chiudono questo mese?" }],
})
