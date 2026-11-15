/**
 * What the server remembers between requests (spec §7): the results of
 * writes, for idempotency, and the ids of tokens that may be used once.
 * Every method is one atomic step. The default keeps it in memory; a server
 * on several instances passes a shared one (a database row with a unique
 * key, Redis SET NX).
 */
export type StoredCall = { args: string; result?: unknown }

export type IdempotencyStore = {
  /**
   * Starts the call `key` with these arguments, in one atomic step: null
   * when nothing was there (the caller now runs it and must `finish` or
   * `abandon` it); else what is there: with `result` when it finished,
   * without while it still runs.
   */
  begin(key: string, args: string, ttlMs: number): Promise<StoredCall | null>
  /** The call's result, kept for `ttlMs`. */
  finish(key: string, value: Required<StoredCall>, ttlMs: number): Promise<void>
  /** The call did not run (refused, or its handler failed): forgotten, so it can be tried again. */
  abandon(key: string): Promise<void>
  /** True the first time `key` is seen within `ttlMs`, false after: atomic. */
  once(key: string, ttlMs: number): Promise<boolean>
}

export class MemoryStore implements IdempotencyStore {
  readonly #items = new Map<string, { value: StoredCall; until: number }>()

  #live(key: string): StoredCall | undefined {
    const item = this.#items.get(key)
    if (!item) return undefined
    if (item.until < Date.now()) {
      this.#items.delete(key)
      return undefined
    }
    return item.value
  }

  #put(key: string, value: StoredCall, ttlMs: number) {
    if (this.#items.size > 50_000) for (const [k, v] of this.#items) if (v.until < Date.now()) this.#items.delete(k)
    this.#items.set(key, { value, until: Date.now() + ttlMs })
  }

  // No await between the read and the write: one step on Node's single thread.
  async begin(key: string, args: string, ttlMs: number) {
    const existing = this.#live(key)
    if (existing) return existing
    this.#put(key, { args }, ttlMs)
    return null
  }

  async finish(key: string, value: Required<StoredCall>, ttlMs: number) {
    this.#put(key, value, ttlMs)
  }

  async abandon(key: string) {
    this.#items.delete(key)
  }

  async once(key: string, ttlMs: number) {
    if (this.#live(key)) return false
    this.#put(key, { args: "" }, ttlMs)
    return true
  }
}

/**
 * Runs one SQL statement with positional parameters (`$1`, `$2`, …) and gives
 * back its rows: whatever the app already talks to its database with
 * (`pg`'s `pool.query`, `postgres`'s `sql.unsafe`, PGlite's `db.query`, a
 * Drizzle `db.execute`). The SDK knows no driver.
 */
export type SqlQuery = (text: string, params: unknown[]) => Promise<{ rows: Record<string, unknown>[] } | Record<string, unknown>[]>

/**
 * A store in the app's own Postgres (one table), for serverless and several
 * instances: every method is a single statement, atomic on its own. Create the
 * table once with `SqlStore.schema()` in a migration (the SDK never migrates).
 * Expired rows are taken over in place and swept now and then.
 */
export class SqlStore implements IdempotencyStore {
  readonly #query: SqlQuery
  readonly #table: string
  #calls = 0

  constructor(query: SqlQuery, options: { table?: string } = {}) {
    const table = options.table ?? "modelapp_store"
    if (!/^[a-z_][a-z0-9_]{0,62}$/.test(table)) throw new Error(`SqlStore: table "${table}" must be a plain lowercase SQL name`)
    this.#query = query
    this.#table = table
  }

  /** The table, as SQL for a migration. */
  static schema(table = "modelapp_store"): string {
    if (!/^[a-z_][a-z0-9_]{0,62}$/.test(table)) throw new Error(`SqlStore: table "${table}" must be a plain lowercase SQL name`)
    return `CREATE TABLE IF NOT EXISTS ${table} (key text PRIMARY KEY, args text NOT NULL, result jsonb, done boolean NOT NULL DEFAULT false, expires_at timestamptz NOT NULL);\nCREATE INDEX IF NOT EXISTS ${table}_expires_at ON ${table} (expires_at);`
  }

  async #rows(text: string, params: unknown[]) {
    const r = await this.#query(text, params)
    return Array.isArray(r) ? r : r.rows
  }

  async #sweep() {
    if (++this.#calls % 200 === 0) await this.#rows(`DELETE FROM ${this.#table} WHERE expires_at < now()`, []).catch(() => undefined)
  }

  /** Claims `key` when it is free or expired, in one statement: a row back means this caller now holds it. */
  async #claim(key: string, args: string, ttlMs: number): Promise<boolean> {
    const rows = await this.#rows(
      `INSERT INTO ${this.#table} (key, args, result, done, expires_at) VALUES ($1, $2, NULL, false, now() + ($3::bigint * interval '1 millisecond'))
       ON CONFLICT (key) DO UPDATE SET args = EXCLUDED.args, result = NULL, done = false, expires_at = EXCLUDED.expires_at WHERE ${this.#table}.expires_at < now()
       RETURNING key`,
      [key, args, Math.max(1, Math.round(ttlMs))],
    )
    return rows.length > 0
  }

  async begin(key: string, args: string, ttlMs: number): Promise<StoredCall | null> {
    await this.#sweep()
    if (await this.#claim(key, args, ttlMs)) return null
    const [row] = await this.#rows(`SELECT args, result, done FROM ${this.#table} WHERE key = $1`, [key])
    // Gone between the two statements (expired and swept): it is free again.
    if (!row) return (await this.#claim(key, args, ttlMs)) ? null : { args }
    const result = typeof row.result === "string" ? (JSON.parse(row.result) as unknown) : row.result
    return row.done ? { args: String(row.args), result } : { args: String(row.args) }
  }

  async finish(key: string, value: Required<StoredCall>, ttlMs: number): Promise<void> {
    await this.#rows(`UPDATE ${this.#table} SET args = $2, result = $3::jsonb, done = true, expires_at = now() + ($4::bigint * interval '1 millisecond') WHERE key = $1`, [key, value.args, JSON.stringify(value.result ?? null), Math.max(1, Math.round(ttlMs))])
  }

  async abandon(key: string): Promise<void> {
    await this.#rows(`DELETE FROM ${this.#table} WHERE key = $1 AND done = false`, [key])
  }

  async once(key: string, ttlMs: number): Promise<boolean> {
    await this.#sweep()
    return this.#claim(key, "", ttlMs)
  }
}
