// The database: Postgres (postgres.js) when DATABASE_URL is set; locally,
// without it, an embedded Postgres (PGlite) in .data/. Opened on first use,
// never at import, and never migrated here (`npm run db:migrate`).
import { mkdirSync } from "node:fs"

import { PGlite } from "@electric-sql/pglite"
import { drizzle as drizzlePglite } from "drizzle-orm/pglite"
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core"
import { drizzle as drizzlePostgres } from "drizzle-orm/postgres-js"
import postgres from "postgres"

import * as schema from "@/db/schema"

export type Db = PgDatabase<PgQueryResultHKT, typeof schema>
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0]

/** One SQL statement with `$1…` parameters: for code that takes plain SQL (the MAP store). */
export type RawQuery = (text: string, params: unknown[]) => Promise<Record<string, unknown>[]>

export type Database = { kind: "postgres" | "pglite"; db: Db; query: RawQuery; client: postgres.Sql | PGlite; close(): Promise<void> }

/** Where PGlite keeps its files when DATABASE_URL is not set (`memory://` keeps nothing: tests). */
const DEFAULT_PGLITE_DIR = ".data/pglite"

export function openDatabase(env: Record<string, string | undefined> = process.env): Database {
  const url = env.DATABASE_URL?.trim()
  if (url) {
    const client = postgres(url, { max: Number(env.DATABASE_POOL_MAX ?? 5), onnotice: () => undefined })
    return {
      kind: "postgres",
      db: drizzlePostgres(client, { schema }) as unknown as Db,
      query: async (text, params) => [...(await client.unsafe(text, params as postgres.ParameterOrJSON<never>[]))],
      client,
      close: () => client.end(),
    }
  }
  if (env.NODE_ENV === "production") throw new Error("DATABASE_URL is not set. In production the CRM needs a Postgres database (the embedded PGlite is for local runs only).")
  const dir = env.PGLITE_DATA_DIR?.trim() || DEFAULT_PGLITE_DIR
  if (!dir.startsWith("memory://")) mkdirSync(dir, { recursive: true })
  const client = new PGlite(dir)
  return {
    kind: "pglite",
    db: drizzlePglite(client, { schema }) as unknown as Db,
    query: async (text, params) => (await client.query<Record<string, unknown>>(text, params)).rows,
    client,
    close: () => client.close(),
  }
}

// One per process (kept on globalThis so Next's dev reloads don't open a second PGlite on the same files).
const holder = globalThis as typeof globalThis & { __crmDatabase?: Database }

export function database(): Database {
  return (holder.__crmDatabase ??= openDatabase())
}

/** The Drizzle database of this process. */
export const db = (): Db => database().db

/** Closes this process's database (scripts and tests). */
export async function closeDatabase() {
  const d = holder.__crmDatabase
  holder.__crmDatabase = undefined
  await d?.close()
}
