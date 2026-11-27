import { defineEntity } from "@clegra/sdk"
import { z } from "zod"

// The fixture's one entity: notes, kept in the process (globalThis: next dev may load a module more than once).
type Note = { id: string; title: string; body: string }
const g = globalThis as { __notes?: Map<string, Note> }
export const notes: Map<string, Note> = (g.__notes ??= new Map([
  ["n1", { id: "n1", title: "First note", body: "Hello" }],
  ["n2", { id: "n2", title: "Second note", body: "World" }],
]))

export const note = defineEntity({
  name: "note",
  title: "Note",
  path: "/notes/{id}",
  schema: z.object({ id: z.string(), title: z.string(), body: z.string() }),
  card: { title: "title", subtitle: "body" },
  get: ({ id }) => notes.get(id!) ?? null,
  list: () => ({ rows: [...notes.values()] }),
})
