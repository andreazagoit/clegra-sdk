import { defineEntity } from "@clegra/sdk"
import { z } from "zod"

// The fixture's one entity: notes of the caller's organization.
const notes = [
  { id: "n1", title: "First note", org: "org-a" },
  { id: "n2", title: "Second note", org: "org-a" },
]

export const note = defineEntity({
  name: "note",
  label: "Note",
  permission: "notes.view",
  schema: z.object({ id: z.string(), title: z.string().meta({ role: "title", search: true, sort: true }) }),
  get: (id, ctx) => notes.find((n) => n.id === id && n.org === ctx.installation) ?? null,
  list: (_q, ctx) => ({ rows: notes.filter((n) => n.org === ctx.installation).map(({ id, title }) => ({ id, title })) }),
})
