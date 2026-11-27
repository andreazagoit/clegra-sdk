import { defineAction } from "@clegra/sdk"
import { z } from "zod"

import { logCall as recordCall } from "@/lib/crm"
import { contact } from "../entities/contact"
import { refused, tenant } from "../lib"

export const logCall = defineAction({
  name: "log_call",
  on: contact,
  title: { en: "Log a call", it: "Registra chiamata" },
  description: { en: "Records that we called this contact today, with a note", it: "Registra che abbiamo chiamato oggi questo contatto, con una nota" },
  icon: "phone",
  input: z.object({ note: z.string().min(1).max(500).meta({ label: { en: "Note", it: "Nota" } }) }),
  permission: "contacts.edit",
  run: async (input, ctx, record) => {
    await recordCall(await tenant(ctx), record.id, { personId: ctx.person?.id ?? "unknown", note: input.note }).catch((e) => refused(e, ctx))
    return { message: ctx.t({ en: `Call with ${record.name} logged.`, it: `Chiamata con ${record.name} registrata.` }), record: record.id }
  },
})
