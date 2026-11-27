import { defineEntity, ref } from "@clegra/sdk"
import { z } from "zod"

import { getCompany, listCompanies } from "@/lib/crm"
import { tenant } from "../lib"

export const company = defineEntity({
  name: "company",
  label: { en: "Company", it: "Azienda" },
  plural: { en: "Companies", it: "Aziende" },
  description: { en: "A customer or prospect company", it: "Un'azienda cliente o potenziale" },
  icon: "building-2",
  kind: "organization",
  schema: z.object({
    id: z.string(),
    // Free text, typed in from outside (a web form, an import): marked `untrusted`, so a model reads it as data.
    name: z.string().meta({ role: "title", label: { en: "Name", it: "Nome" }, search: true, sort: true, untrusted: true }),
    city: z.string().meta({ role: "subtitle", label: { en: "City", it: "Città" }, filter: true, untrusted: true }),
    industry: z.enum(["manufacturing", "retail", "services", "software"]).meta({
      label: { en: "Industry", it: "Settore" },
      filter: true,
      labels: { manufacturing: { en: "Manufacturing", it: "Manifattura" }, retail: { en: "Retail", it: "Commercio" }, services: { en: "Services", it: "Servizi" }, software: "Software" },
    }),
    // What other apps can find the company by (kind organization): its VAT number, an exact filter, and its website.
    vatId: z.string().optional().meta({ as: "vatID", label: { en: "VAT number", it: "Partita IVA" }, filter: true }),
    website: z.string().optional().meta({ as: "url", label: { en: "Website", it: "Sito web" } }),
    // The same company in another app (an ERP's customer): a record URI of kind organization. The CRM keeps the URI
    // only; hosts show the ERP's live title to people who may see it there.
    erpCustomer: ref.kind("organization").optional().meta({ label: { en: "ERP customer", it: "Cliente nel gestionale" } }),
  }),
  get: async (id, ctx) => getCompany(await tenant(ctx), id),
  list: async (q, ctx) => listCompanies(await tenant(ctx), q),
})
