import { defineAction, ref } from "@clegra/sdk"
import { z } from "zod"

import { setErpCustomer } from "@/lib/crm"
import { company } from "../entities/company"
import { refused, tenant } from "../lib"

// Takes a record URI of kind organization (another app's customer) and stores it: the CRM never calls the other app.
export const linkErpCustomer = defineAction({
  name: "link_erp_customer",
  on: company,
  title: { en: "Link to the ERP customer", it: "Collega al cliente del gestionale" },
  description: { en: "Records which customer of another app (the ERP) this company is", it: "Registra quale cliente di un'altra app (il gestionale) è questa azienda" },
  icon: "link",
  input: z.object({ customer: ref.kind("organization").meta({ label: { en: "ERP customer", it: "Cliente nel gestionale" } }) }),
  confirm: "optional",
  permission: "deals.edit",
  run: async (input, ctx, record) => {
    await setErpCustomer(await tenant(ctx), record.id, input.customer).catch((e) => refused(e, ctx))
    return { message: ctx.t({ en: `${record.name} linked to ${input.customer}.`, it: `${record.name} collegata a ${input.customer}.` }), record: record.id }
  },
})
