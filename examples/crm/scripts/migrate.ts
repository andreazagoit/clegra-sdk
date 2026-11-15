import "./env"

import { closeDatabase, database } from "../lib/db"
import { migrate } from "../lib/migrate"

const d = database()
await migrate(d)
console.log(`migrated (${d.kind === "postgres" ? "DATABASE_URL" : `PGlite in ${process.env.PGLITE_DATA_DIR || ".data/pglite"}`})`)
await closeDatabase()
