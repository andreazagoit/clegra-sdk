// npm run db:seed — the invented demo companies, people and data (idempotent).
import { closeDb } from "../lib/db"
import { seed } from "../lib/seed"

await seed((line) => console.log(line))
await closeDb()
