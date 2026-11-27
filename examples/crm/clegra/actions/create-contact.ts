import { defineAction, ref } from "@clegra/sdk"
import { z } from "zod"

import { createContact as addContact } from "@/lib/crm"
import { contact } from "../entities/contact"
import { refused, tenant } from "../lib"

export const createContact = defineAction({
  name: "create_contact",
  title: { en: "New contact", it: "Nuovo contatto" },
  description: { en: "Adds a person at one of our companies", it: "Aggiunge una persona di una delle nostre aziende" },
  icon: "user-plus",
  input: z.object({
    name: z.string().min(2).max(120).meta({ label: { en: "Name", it: "Nome" } }),
    email: z.email().meta({ label: "Email" }),
    // On the contacts page filtered by a company (`?company=…`) this is filled in.
    company: ref("company").meta({ label: { en: "Company", it: "Azienda" } }),
  }),
  permission: "contacts.edit",
  run: async (input, ctx) => {
    const added = await addContact(await tenant(ctx), input).catch((e) => refused(e, ctx))
    return { message: ctx.t({ en: `Contact ${added.name} added.`, it: `Contatto ${added.name} aggiunto.` }), record: ctx.uri(contact, added.id) }
  },
})
