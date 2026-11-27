import { definePage } from "@clegra/sdk"

import { company } from "../entities/company"

export const companiesPage = definePage({ name: "companies", title: { en: "Companies", it: "Aziende" }, icon: "building-2", list: company, columns: ["name", "city", "industry"] })
