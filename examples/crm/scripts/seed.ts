import "./env"

import { closeDatabase } from "../lib/db"
import { DEMO_USERS } from "../lib/demo-data"
import { seed } from "../lib/seed"

const report = await seed(process.env.DEMO_PASSWORD)
if (report.created.length) console.log(`created: ${report.created.join(", ")}`)
if (report.kept.length) console.log(`already there (data kept): ${report.kept.join(", ")}`)
console.log(`demo accounts (password: DEMO_PASSWORD in .env.local): ${DEMO_USERS.map((u) => u.email).join(", ")}`)
await closeDatabase()
