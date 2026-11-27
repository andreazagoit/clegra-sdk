/**
 * What the server keeps between requests: confirmations (single use, short), session-transfer codes and transferred
 * sessions, revoked grants, event subscriptions and the access log. Every method is one atomic step. `MemoryStore`
 * keeps it in one process; an app on several instances passes `SqlStore` (one table) or its own.
 */
export type Store = {
  get<T = unknown>(key: string): Promise<T | null>
  /** Sets the value, replacing any; `ttlSeconds` makes it disappear after that long. */
  set(key: string, value: unknown, ttlSeconds?: number): Promise<void>
  /** Sets the value only when the key holds nothing: true when it did (one caller wins). */
  add(key: string, value: unknown, ttlSeconds?: number): Promise<boolean>
  /** Reads and deletes in one step: two callers at once, one gets the value, the other null (single use). */
  take<T = unknown>(key: string): Promise<T | null>
  delete(key: string): Promise<void>
  /** The live entries whose key starts with `prefix`, newest key last (keys sort as text), at most `limit`. */
  list<T = unknown>(prefix: string, limit?: number): Promise<{ key: string; value: T }[]>
}

type Entry = { value: string; expires: number | null }

/** One process's memory. Fine for development and a single instance. */
export class MemoryStore implements Store {
  readonly #map = new Map<string, Entry>()

  #live(key: string): Entry | null {
    const e = this.#map.get(key)
    if (!e) return null
    if (e.expires !== null && e.expires <= Date.now()) {
      this.#map.delete(key)
      return null
    }
    return e
  }

  async get<T>(key: string): Promise<T | null> {
    const e = this.#live(key)
    return e ? (JSON.parse(e.value) as T) : null
  }

  async set(key: string, value: unknown, ttlSeconds?: number): Promise<void> {
    this.#map.set(key, { value: JSON.stringify(value), expires: ttlSeconds ? Date.now() + ttlSeconds * 1000 : null })
  }

  async add(key: string, value: unknown, ttlSeconds?: number): Promise<boolean> {
    if (this.#live(key)) return false
    await this.set(key, value, ttlSeconds)
    return true
  }

  async take<T>(key: string): Promise<T | null> {
    const e = this.#live(key)
    if (!e) return null
    this.#map.delete(key)
    return JSON.parse(e.value) as T
  }

  async delete(key: string): Promise<void> {
    this.#map.delete(key)
  }

  async list<T>(prefix: string, limit = 1000): Promise<{ key: string; value: T }[]> {
    const keys = [...this.#map.keys()].filter((k) => k.startsWith(prefix) && this.#live(k)).sort()
    return keys.slice(-limit).map((key) => ({ key, value: JSON.parse(this.#map.get(key)!.value) as T }))
  }
}

/** Runs one SQL statement with `$1…` parameters and returns its rows (`pg`, `postgres`, PGlite all fit in one line). */
export type SqlQuery = (text: string, params: unknown[]) => Promise<{ rows: Record<string, unknown>[] } | Record<string, unknown>[]>

const rowsOf = (r: { rows: Record<string, unknown>[] } | Record<string, unknown>[]) => (Array.isArray(r) ? r : r.rows)

/**
 * The store in one Postgres table (`SqlStore.schema()` creates it; run it from your migrations). Expired rows are
 * never returned; `SqlStore.sweep()` deletes them (run it from a cron job).
 */
export class SqlStore implements Store {
  readonly #q: SqlQuery
  readonly #table: string

  constructor(query: SqlQuery, options: { table?: string } = {}) {
    const table = options.table ?? "clegra_store"
    if (!/^[a-z_][a-z0-9_]{0,62}$/.test(table)) throw new Error(`SqlStore: table "${table}" must be a lowercase SQL identifier`)
    this.#q = query
    this.#table = table
  }

  /** The table, idempotent (`IF NOT EXISTS`). */
  static schema(table = "clegra_store"): string {
    return `CREATE TABLE IF NOT EXISTS ${table} (key text PRIMARY KEY, value text NOT NULL, expires_at timestamptz);\nCREATE INDEX IF NOT EXISTS ${table}_expires ON ${table} (expires_at);`
  }

  /** Deletes the expired rows: how many. */
  async sweep(): Promise<number> {
    return rowsOf(await this.#q(`DELETE FROM ${this.#table} WHERE expires_at IS NOT NULL AND expires_at <= now() RETURNING key`, [])).length
  }

  #expires(ttl?: number): string | null {
    return ttl ? new Date(Date.now() + ttl * 1000).toISOString() : null
  }

  async get<T>(key: string): Promise<T | null> {
    const row = rowsOf(await this.#q(`SELECT value FROM ${this.#table} WHERE key = $1 AND (expires_at IS NULL OR expires_at > now())`, [key]))[0]
    return row ? (JSON.parse(String(row.value)) as T) : null
  }

  async set(key: string, value: unknown, ttlSeconds?: number): Promise<void> {
    await this.#q(`INSERT INTO ${this.#table} (key, value, expires_at) VALUES ($1, $2, $3) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, expires_at = EXCLUDED.expires_at`, [key, JSON.stringify(value), this.#expires(ttlSeconds)])
  }

  async add(key: string, value: unknown, ttlSeconds?: number): Promise<boolean> {
    await this.#q(`DELETE FROM ${this.#table} WHERE key = $1 AND expires_at IS NOT NULL AND expires_at <= now()`, [key])
    const rows = rowsOf(await this.#q(`INSERT INTO ${this.#table} (key, value, expires_at) VALUES ($1, $2, $3) ON CONFLICT (key) DO NOTHING RETURNING key`, [key, JSON.stringify(value), this.#expires(ttlSeconds)]))
    return rows.length > 0
  }

  async take<T>(key: string): Promise<T | null> {
    const row = rowsOf(await this.#q(`DELETE FROM ${this.#table} WHERE key = $1 RETURNING value, expires_at`, [key]))[0]
    if (!row) return null
    const expires = row.expires_at ? new Date(String(row.expires_at instanceof Date ? row.expires_at.toISOString() : row.expires_at)).getTime() : null
    if (expires !== null && expires <= Date.now()) return null
    return JSON.parse(String(row.value)) as T
  }

  async delete(key: string): Promise<void> {
    await this.#q(`DELETE FROM ${this.#table} WHERE key = $1`, [key])
  }

  async list<T>(prefix: string, limit = 1000): Promise<{ key: string; value: T }[]> {
    const like = `${prefix.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
    const rows = rowsOf(await this.#q(`SELECT key, value FROM (SELECT key, value FROM ${this.#table} WHERE key LIKE $1 AND (expires_at IS NULL OR expires_at > now()) ORDER BY key DESC LIMIT $2) t ORDER BY key ASC`, [like, limit]))
    return rows.map((r) => ({ key: String(r.key), value: JSON.parse(String(r.value)) as T }))
  }
}
