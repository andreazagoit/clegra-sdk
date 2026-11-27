import { defineApp, definePage, defineTool } from "@clegra/sdk"
import { z } from "zod"

import { note, notes } from "./note"

// The fixture's definition: nothing here is served (clegra/index.ts serves it).
export const notesPage = definePage({ name: "notes", title: "Notes", path: "/notes", role: "list", entity: note, frame: true, nav: { order: 1 } })
export const notePage = definePage({ name: "note", title: "Note", path: "/notes/{id}", role: "record", entity: note, frame: true })

const list = defineTool({
  name: "notes.list",
  title: "List notes",
  description: "Every note",
  input: z.object({}),
  annotations: { readOnly: true },
  entity: note,
  page: notesPage,
  run: () => ({ data: { count: notes.size }, records: [...notes.values()].map((record) => ({ entity: note, record })) }),
})

const rename = defineTool({
  name: "notes.rename",
  title: "Rename note",
  description: "Changes a note's title",
  input: z.object({ id: z.string(), title: z.string() }),
  annotations: { readOnly: false, destructive: false, idempotent: true },
  entity: note,
  on: "record",
  page: notePage,
  run: ({ title }, _ctx, record) => {
    record.title = title
    return { records: [{ entity: note, record }] }
  },
})

const publish = defineTool({
  name: "notes.publish",
  title: "Publish note",
  description: "Publishes a note for everyone to read",
  input: z.object({ id: z.string() }),
  annotations: { readOnly: false, destructive: false, openWorld: true },
  entity: note,
  on: "record",
  confirm: { message: (_i, _c, r) => `Publish «${r.title}» for everyone?`, values: (_i, _c, r) => ({ title: r.title }) },
  run: () => ({ text: "Published" }),
})

export const definition = defineApp({
  name: "fixture-notes",
  title: "Fixture notes",
  description: "A tiny notes app for the real Next.js test",
  version: "1.0.0",
  entities: [note],
  tools: [list, rename, publish],
  pages: [notesPage, notePage],
})
