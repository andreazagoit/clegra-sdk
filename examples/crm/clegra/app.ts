// The CRM as a Clegra app (docs/examples/crm.md): its entities, actions, artifacts, pages and agent, one per file,
// each over the functions the CRM already has (lib/crm.ts), assembled here. Pure: nothing is served (index.ts).
// Hosts and MCP clients get the same rules as the pages: the tenant from the verified caller, the field permissions
// applied by the SDK, the changes through the same functions.
import { defineApp } from "@clegra/sdk"

import { createContact } from "./actions/create-contact"
import { createDeal } from "./actions/create-deal"
import { linkErpCustomer } from "./actions/link-erp-customer"
import { logCall } from "./actions/log-call"
import { markWon } from "./actions/mark-won"
import { setStage } from "./actions/set-stage"
import { salesAssistant } from "./agents/sales-assistant"
import { closingSoon } from "./artifacts/closing-soon"
import { dealsByStage } from "./artifacts/deals-by-stage"
import { funnel } from "./artifacts/funnel"
import { openDeals } from "./artifacts/open-deals"
import { pipelineTotal } from "./artifacts/pipeline-total"
import { stageFunnel } from "./components/stage-funnel"
import { company } from "./entities/company"
import { contact } from "./entities/contact"
import { deal } from "./entities/deal"
import { companiesPage } from "./pages/companies"
import { contactsPage } from "./pages/contacts"
import { dealPage } from "./pages/deal"
import { dealsPage } from "./pages/deals"
import { forecastPage } from "./pages/forecast"
import { pipelinePage } from "./pages/pipeline"

export const crmApp = defineApp({
  name: "crm",
  title: { en: "CRM", it: "CRM" },
  version: "1.0.0",
  description: { en: "Companies, contacts and deals of a small sales team.", it: "Aziende, contatti e trattative di un piccolo team commerciale." },
  locale: "en",
  instructions: "A CRM. Use search or the *_list tools to find records, *_get for one record, open_pipeline for the overview. Changes need the person's confirmation.",

  permissions: {
    "deals.view": { label: { en: "See deals", it: "Vedere le trattative" }, default: true },
    "deals.edit": { label: { en: "Change deals", it: "Modificare le trattative" }, default: true },
    "deals.values": { label: { en: "See deal values", it: "Vedere i valori delle trattative" } },
    "contacts.edit": { label: { en: "Add contacts and log calls", it: "Aggiungere contatti e registrare chiamate" }, default: true },
  },
  settings: {
    follow_up_days: { label: { en: "Follow-up after (days)", it: "Richiamare dopo (giorni)" }, type: "number", default: 7 },
  },

  entities: [company, contact, deal],
  // Writes reach every client the CRM's own sign-in linked (Clegra, ChatGPT, Claude).
  actions: [markWon, setStage, logCall, linkErpCustomer, createContact, createDeal],
  components: [stageFunnel],
  artifacts: [funnel, openDeals, pipelineTotal, dealsByStage, closingSoon],
  pages: [dealsPage, companiesPage, contactsPage, dealPage, pipelinePage, forecastPage],
  // The host's navigation: selling first, then the companies and contacts we sell to.
  nav: [
    { section: { en: "Sales", it: "Vendite" }, pages: [pipelinePage, dealsPage, forecastPage] },
    { section: { en: "Customers", it: "Clienti" }, pages: [companiesPage, contactsPage] },
  ],
  agents: [salesAssistant],
})
