import { readdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { getMigrations } from "better-auth/db/migration"

import { createAuth } from "./auth"
import { getDb, sql } from "./db"

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), "..", "db", "migrations")

/**
 * Brings the database up to date, in order: better-auth's own tables (its
 * migration plan, from the plugins configured in lib/auth.ts), then the app's
 * plain .sql files in db/migrations, each once, in one transaction, by name.
 * An explicit command (`npm run db:migrate`), never run at startup.
 */
export async function migrate(log: (line: string) => void = () => undefined): Promise<string[]> {
  const db = await getDb()
  const plan = await getMigrations(createAuth(db.pool, { validateSchema: false }).options)
  if (plan.toBeCreated.length || plan.toBeAdded.length || plan.toBeAddedIndexes.length) {
    await plan.runMigrations()
    log(`better-auth: ${[...plan.toBeCreated.map((t) => `+${t.table}`), ...plan.toBeAdded.map((t) => `~${t.table}`)].join(" ") || "indexes"}`)
  }

  await sql(`CREATE TABLE IF NOT EXISTS schema_migration (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`)
  const done = new Set((await sql<{ name: string }>(`SELECT name FROM schema_migration`)).map((r) => r.name))
  const applied: string[] = []
  for (const name of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) {
    if (done.has(name)) continue
    const body = readFileSync(join(MIGRATIONS, name), "utf8")
    const quoted = name.replace(/'/g, "''")
    try {
      await db.exec(`BEGIN;\n${body}\nINSERT INTO schema_migration (name) VALUES ('${quoted}');\nCOMMIT;`)
    } catch (error) {
      await db.exec("ROLLBACK").catch(() => undefined)
      throw new Error(`migration ${name} failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    applied.push(name)
    log(`applied ${name}`)
  }
  return applied
}
