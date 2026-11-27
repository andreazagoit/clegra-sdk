import { defineApp } from "@clegra/sdk"

import { note } from "./note"

// The fixture's definition: nothing here is served (clegra/index.ts serves it).
export const definition = defineApp({
  name: "fixture-notes",
  title: "Fixture notes",
  version: "1.0.0",
  permissions: { "notes.view": { label: "See notes", default: true } },
  entities: [note],
})
