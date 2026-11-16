// The database: Postgres (postgres.js) when DATABASE_URL is set; locally, without it, an embedded Postgres
// (PGlite) in .data/. Opened on first use, never at import, and never migrated here (`npm run db:migrate`).
import { mkdirSync } from "node:fs"
import { createRequire } from "node:module"

import type { PGlite } from "@electric-sql/pglite"
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core"
import type { drizzle as drizzlePgliteType } from "drizzle-orm/pglite"
import { drizzle as drizzlePostgres } from "drizzle-orm/postgres-js"
import postgres from "postgres"

import * as schema from "@/db/schema"

export type Db = PgDatabase<PgQueryResultHKT, typeof schema>
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0]

/** One SQL statement with `$1…` parameters: for code that takes plain SQL (the clegra store). */
export type RawQuery = (text: string, params: unknown[]) => Promise<Record<string, unknown>[]>

export type Database = { kind: "postgres" | "pglite"; db: Db; query: RawQuery; close(): Promise<void> }

/** Where PGlite keeps its files when DATABASE_URL is not set (`memory://` keeps nothing: tests). */
const DEFAULT_PGLITE_DIR = ".data/pglite"

export function openDatabase(env: Record<string, string | undefined> = process.env): Database {
  const url = env.DATABASE_URL?.trim()
  if (url) {
    const host = new URL(url).hostname
    const client = postgres(url, {
      max: Number(env.DATABASE_POOL_MAX ?? 5),
      idle_timeout: 20,
      // A transaction-mode pooler (Neon's `-pooler` host, PgBouncer) can't keep prepared statements between queries.
      prepare: !host.includes("-pooler"),
      // TLS from the URL (`sslmode=require`, what Neon gives); a remote database without it is refused rather than read in clear.
      ...(/sslmode=/.test(url) || ["localhost", "127.0.0.1", "::1"].includes(host) ? {} : { ssl: "require" as const }),
      onnotice: () => undefined,
    })
    return {
      kind: "postgres",
      db: drizzlePostgres(client, { schema }) as unknown as Db,
      query: async (text, params) => [...(await client.unsafe(text, params as postgres.ParameterOrJSON<never>[]))],
      close: () => client.end(),
    }
  }
  // `process.env.NODE_ENV` as such: a production build replaces it and drops this branch, so PGlite (26 MB) never
  // reaches the server bundle. Loaded here only (local runs, tests), never imported by the module.
  if (process.env.NODE_ENV !== "production") {
    const load = createRequire(import.meta.url)
    const { PGlite: Pglite } = load("@electric-sql/pglite") as { PGlite: typeof PGlite }
    const { drizzle } = load("drizzle-orm/pglite") as { drizzle: typeof drizzlePgliteType }
    const dir = env.PGLITE_DATA_DIR?.trim() || DEFAULT_PGLITE_DIR
    if (!dir.startsWith("memory://")) mkdirSync(dir, { recursive: true })
    const client = new Pglite(dir)
    return {
      kind: "pglite",
      db: drizzle(client, { schema }) as unknown as Db,
      query: async (text, params) => (await client.query<Record<string, unknown>>(text, params)).rows,
      close: () => client.close(),
    }
  }
  throw new Error("DATABASE_URL is not set. In production the CRM needs a Postgres database (the embedded PGlite is for local runs only).")
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
