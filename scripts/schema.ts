// Writes the manifest's JSON Schema where the spec publishes it (spec/schema). `npm run schema`.
import { writeFileSync } from "node:fs"

import { manifestJsonSchema } from "../src/manifest"

const file = new URL("../spec/schema/modelapp.schema.json", import.meta.url)
writeFileSync(file, `${JSON.stringify(manifestJsonSchema(), null, 2)}\n`)
console.log(`written ${file.pathname}`)
