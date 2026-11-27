import { defineEntity, ref } from "@clegra/sdk"
import { z } from "zod"

import { getContact, listContacts } from "@/lib/crm"
import { tenant } from "../lib"

export const contact = defineEntity({
  name: "contact",
  label: { en: "Contact", it: "Contatto" },
  plural: { en: "Contacts", it: "Contatti" },
  description: { en: "A person at a company", it: "Una persona di un'azienda" },
  icon: "user",
  kind: "person",
  schema: z.object({
    id: z.string(),
    name: z.string().meta({ role: "title", label: { en: "Name", it: "Nome" }, search: true, sort: true, untrusted: true }),
    // Kind person: the email is its key, an exact filter (hosts find the same person in other apps by it).
    email: z.string().meta({ role: "subtitle", as: "email", label: "Email", filter: true, search: true, untrusted: true }),
    company: ref("company").meta({ as: "worksFor", label: { en: "Company", it: "Azienda" }, filter: true }),
    lastCall: z.string().optional().meta({ role: "date", label: { en: "Last call", it: "Ultima chiamata" }, sort: true }),
    lastNote: z.string().optional().meta({ label: { en: "Last note", it: "Ultima nota" }, untrusted: true }),
  }),
  get: async (id, ctx) => getContact(await tenant(ctx), id),
  list: async (q, ctx) => listContacts(await tenant(ctx), q),
})
