import { definePage } from "@clegra/sdk"

import { createContact } from "../actions/create-contact"
import { contact } from "../entities/contact"

export const contactsPage = definePage({ name: "contacts", title: { en: "Contacts", it: "Contatti" }, icon: "users", list: contact, columns: ["name", "email", "company", "lastCall"], actions: [createContact] })
