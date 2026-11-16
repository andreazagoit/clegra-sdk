// Writes what the spec publishes (spec/): the manifest's JSON Schema and the kinds of this version. `npm run schema`.
import { writeFileSync } from "node:fs"

import { kindsDocument } from "../spec/src/kinds"
import { SPEC_VERSION } from "../spec/src/protocol"
import { manifestJsonSchema } from "../src/manifest"

const files: [URL, unknown][] = [
  [new URL("../spec/schema/clegra.schema.json", import.meta.url), manifestJsonSchema()],
  [new URL("../spec/kinds.json", import.meta.url), kindsDocument(SPEC_VERSION)],
]
for (const [file, content] of files) {
  writeFileSync(file, `${JSON.stringify(content, null, 2)}\n`)
  console.log(`written ${file.pathname}`)
}
