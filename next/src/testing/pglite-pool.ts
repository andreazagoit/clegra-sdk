import { PGlite } from "@electric-sql/pglite"

/**
 * PGlite (Postgres in WebAssembly, in memory) shaped like a `pg` Pool, so better-auth's Kysely adapter takes it
 * as `database` ("connect" in db → Postgres). Tests only: one connection, no Docker.
 */
export function pglitePool(db = new PGlite()) {
  const client = {
    async query(sql: string, params: unknown[] = []) {
      const result = await db.query<Record<string, unknown>>(sql, params as never[])
      const command = /^\s*(\w+)/.exec(sql)?.[1]?.toUpperCase()
      return { command, rowCount: result.affectedRows ?? result.rows.length, rows: result.rows }
    },
    release() {},
  }
  // No `db` key: better-auth would take the object for a Kysely instance.
  return { pglite: db, connect: async () => client, end: async () => {} }
}
