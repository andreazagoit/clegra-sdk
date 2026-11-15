// Every test file: its own in-memory database, migrated and seeded like `npm run setup` does.
import { randomBytes } from "node:crypto"
import { after } from "node:test"

import { closeDatabase, database } from "../lib/db"
import { migrate } from "../lib/migrate"
import { seed } from "../lib/seed"

delete process.env.DATABASE_URL
process.env.PGLITE_DATA_DIR = "memory://"
process.env.BETTER_AUTH_SECRET = randomBytes(32).toString("base64url")

await migrate(database())
/** The demo accounts' password in this test run. */
export const password = randomBytes(18).toString("base64url")
/** The seeded accounts' user ids, by demo key (alice, ben, emma). */
export const { users } = await seed(password)

after(() => closeDatabase())
