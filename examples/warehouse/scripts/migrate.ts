// npm run db:migrate — better-auth's tables, then db/migrations/*.sql (each once).
import { closeDb } from "../lib/db"
import { migrate } from "../lib/migrate"

const applied = await migrate((line) => console.log(line))
console.log(applied.length ? `migrated (${applied.length} new)` : "up to date")
await closeDb()
