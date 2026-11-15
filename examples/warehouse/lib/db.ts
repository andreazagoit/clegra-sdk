import { resolve } from "node:path"

/**
 * The data layer: plain SQL, on purpose. One `sql(text, params)` for every
 * query of the app (pages, server actions, the MAP handlers, the seed), one
 * `transaction(fn)` for the few writes that must be atomic. No ORM.
 *
 * - DATABASE_URL set: a `pg` Pool (any Postgres: local, Neon, RDS, …).
 * - DATABASE_URL unset, outside production: PGlite (Postgres in WebAssembly) in
 *   PGLITE_DIR (default `.data/`, `memory://` for tests). Same SQL, same driver
 *   shape: PGlite is wrapped as a pool of one connection.
 * - Production without DATABASE_URL: a clear error, never PGlite.
 */

export type Row = Record<string, unknown>
export type QueryResult = { rows: Row[]; rowCount: number | null; command?: string }

/** What `pg`'s Pool offers and the rest of the app (and better-auth's Kysely dialect) relies on. */
export interface PoolClient {
  query(text: string, params?: unknown[]): Promise<QueryResult>
  release(): void
}
export interface Pool {
  query(text: string, params?: unknown[]): Promise<QueryResult>
  connect(): Promise<PoolClient>
  end(): Promise<void>
}

export type Db = {
  kind: "postgres" | "pglite"
  pool: Pool
  /** Runs a script of several statements without parameters (migrations). */
  exec(script: string): Promise<void>
}

/** Runs one statement with positional parameters (`$1`, `$2`, …) and gives back its rows. */
export type Sql = <T = Row>(text: string, params?: unknown[]) => Promise<T[]>

const commandOf = (text: string) => /^\s*(?:with\b[\s\S]*?\)\s*)?([a-z]+)/i.exec(text)?.[1]?.toUpperCase() ?? ""

/** PGlite is one connection: handed out to one user at a time, so a transaction never interleaves with other queries. */
export async function pglitePool(dataDir: string): Promise<{ pool: Pool; exec(script: string): Promise<void> }> {
  const { PGlite } = await import("@electric-sql/pglite")
  const db = dataDir === "memory://" ? new PGlite() : new PGlite(resolve(/* turbopackIgnore: true */ process.cwd(), dataDir))
  let tail: Promise<void> = Promise.resolve()
  const lock = async (): Promise<() => void> => {
    let release!: () => void
    const previous = tail
    tail = new Promise<void>((r) => (release = r))
    await previous
    return release
  }
  const run = async (text: string, params: unknown[] = []): Promise<QueryResult> => {
    const r = await db.query<Row>(text, params)
    return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length, command: commandOf(text) }
  }
  const pool: Pool = {
    async query(text, params) {
      const release = await lock()
      try {
        return await run(text, params)
      } finally {
        release()
      }
    },
    async connect() {
      const release = await lock()
      let released = false
      return {
        query: run,
        release() {
          if (released) return
          released = true
          release()
        },
      }
    },
    async end() {
      await db.close()
    },
  }
  return {
    pool,
    async exec(script) {
      const release = await lock()
      try {
        await db.exec(script)
      } finally {
        release()
      }
    },
  }
}

async function createDb(): Promise<Db> {
  const url = process.env.DATABASE_URL
  if (url) {
    const { default: pg } = await import("pg")
    const pool = new pg.Pool({ connectionString: url, max: Number(process.env.DATABASE_POOL_MAX ?? 5) })
    return { kind: "postgres", pool: pool as unknown as Pool, exec: async (script) => void (await pool.query(script)) }
  }
  if (process.env.NODE_ENV === "production") throw new Error("DATABASE_URL is not set. In production the app needs a Postgres database; PGlite is for local development only.")
  return { kind: "pglite", ...(await pglitePool(process.env.PGLITE_DIR || ".data")) }
}

// One database per process, also across Next's module reloads in development.
const holder = globalThis as unknown as { __warehouseDb?: Promise<Db> }

export function getDb(): Promise<Db> {
  holder.__warehouseDb ??= createDb().catch((error: unknown) => {
    holder.__warehouseDb = undefined
    throw error
  })
  return holder.__warehouseDb
}

/** Closes the database (scripts and tests; the app never does). */
export async function closeDb(): Promise<void> {
  const db = holder.__warehouseDb
  holder.__warehouseDb = undefined
  if (db) await (await db).pool.end()
}

export const sql: Sql = async <T = Row>(text: string, params: unknown[] = []) => (await (await getDb()).pool.query(text, params)).rows as T[]

/** Runs `fn` in one transaction on one connection: committed when it returns, rolled back when it throws. */
export async function transaction<T>(fn: (tx: Sql) => Promise<T>): Promise<T> {
  const client = await (await getDb()).pool.connect()
  try {
    await client.query("BEGIN")
    const tx: Sql = async <R = Row>(text: string, params: unknown[] = []) => (await client.query(text, params)).rows as R[]
    const result = await fn(tx)
    await client.query("COMMIT")
    return result
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}
