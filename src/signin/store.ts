import type { SqlQuery } from "../store"

/**
 * Where the sign-in module keeps what it issued: pending consents, codes, delegations (links), refresh tokens,
 * personal keys, sessions and accounts of the password login, used proof ids. Secrets are kept only as hashes.
 * A key–value store with expiry; `take` reads and deletes in one step (a code is used once), `list` reads by prefix.
 * Several instances of the app share one (SqlSignInStore); MemorySignInStore is for tests and one process.
 */
export type SignInStore = {
  get(key: string): Promise<unknown | null>
  /** Writes `value` under `key`; `ttlMs` null keeps it until deleted. */
  set(key: string, value: unknown, ttlMs: number | null): Promise<void>
  /** Reads and deletes in one step: two callers never both get it. */
  take(key: string): Promise<unknown | null>
  delete(key: string): Promise<void>
  /** Every live entry whose key starts with `prefix`. */
  list(prefix: string): Promise<{ key: string; value: unknown }[]>
  /** True the first time `key` is seen within `ttlMs` (replay protection). */
  once(key: string, ttlMs: number): Promise<boolean>
  /** How many times `key` was hit in the current window of `windowMs` (rate limits). */
  hit(key: string, windowMs: number): Promise<number>
}

export class MemorySignInStore implements SignInStore {
  readonly #map = new Map<string, { value: unknown; until: number | null }>()

  #live(key: string) {
    const entry = this.#map.get(key)
    if (!entry) return null
    if (entry.until !== null && entry.until <= Date.now()) {
      this.#map.delete(key)
      return null
    }
    return entry
  }

  async get(key: string) {
    const v = this.#live(key)?.value
    return v === undefined ? null : structuredClone(v)
  }

  async set(key: string, value: unknown, ttlMs: number | null) {
    this.#map.set(key, { value: structuredClone(value), until: ttlMs === null ? null : Date.now() + ttlMs })
  }

  async take(key: string) {
    const entry = this.#live(key)
    if (!entry) return null
    this.#map.delete(key)
    return entry.value
  }

  async delete(key: string) {
    this.#map.delete(key)
  }

  async list(prefix: string) {
    const out: { key: string; value: unknown }[] = []
    for (const key of [...this.#map.keys()]) if (key.startsWith(prefix) && this.#live(key)) out.push({ key, value: structuredClone(this.#map.get(key)!.value) })
    return out.sort((a, b) => (a.key < b.key ? -1 : 1))
  }

  async once(key: string, ttlMs: number) {
    if (this.#live(`#once#${key}`)) return false
    this.#map.set(`#once#${key}`, { value: true, until: Date.now() + ttlMs })
    return true
  }

  async hit(key: string, windowMs: number) {
    const entry = this.#live(`#hit#${key}`)
    if (!entry) {
      this.#map.set(`#hit#${key}`, { value: 1, until: Date.now() + windowMs })
      return 1
    }
    entry.value = (entry.value as number) + 1
    return entry.value as number
  }
}

function checkTable(table: string): string {
  if (!/^[a-z_][a-z0-9_]{0,50}$/.test(table)) throw new Error(`SqlSignInStore: table "${table}" must be a plain lowercase SQL name`)
  return table
}

/** The sign-in store in one Postgres table (`SqlSignInStore.schema()` for the migration). */
export class SqlSignInStore implements SignInStore {
  readonly #query: SqlQuery
  readonly #table: string
  #calls = 0

  constructor(query: SqlQuery, options: { table?: string } = {}) {
    this.#query = query
    this.#table = checkTable(options.table ?? "clegra_signin")
  }

  /** The table, as SQL for a migration: `CREATE … IF NOT EXISTS`, safe to run again. */
  static schema(table = "clegra_signin"): string {
    checkTable(table)
    return [
      `CREATE TABLE IF NOT EXISTS ${table} (key text PRIMARY KEY, value jsonb NOT NULL, expires_at timestamptz);`,
      `CREATE INDEX IF NOT EXISTS ${table}_expires_at ON ${table} (expires_at) WHERE expires_at IS NOT NULL;`,
      `CREATE INDEX IF NOT EXISTS ${table}_prefix ON ${table} (key text_pattern_ops);`,
    ].join("\n")
  }

  async #rows(text: string, params: unknown[]) {
    const r = await this.#query(text, params)
    return Array.isArray(r) ? r : r.rows
  }

  async #sweep() {
    if (++this.#calls % 200 === 0) await this.#rows(`DELETE FROM ${this.#table} WHERE expires_at < now()`, []).catch(() => undefined)
  }

  #value(v: unknown) {
    return typeof v === "string" ? (JSON.parse(v) as unknown) : v
  }

  async get(key: string) {
    const [row] = await this.#rows(`SELECT value FROM ${this.#table} WHERE key = $1 AND (expires_at IS NULL OR expires_at >= now())`, [key])
    return row ? this.#value(row.value) : null
  }

  async set(key: string, value: unknown, ttlMs: number | null) {
    await this.#sweep()
    await this.#rows(
      `INSERT INTO ${this.#table} (key, value, expires_at) VALUES ($1, $2::jsonb, CASE WHEN $3::bigint IS NULL THEN NULL ELSE now() + ($3::bigint * interval '1 millisecond') END)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, expires_at = EXCLUDED.expires_at`,
      [key, JSON.stringify(value), ttlMs === null ? null : Math.max(1, Math.round(ttlMs))],
    )
  }

  async take(key: string) {
    const [row] = await this.#rows(`DELETE FROM ${this.#table} WHERE key = $1 RETURNING value, (expires_at IS NULL OR expires_at >= now()) AS live`, [key])
    return row && (row.live === true || row.live === "t") ? this.#value(row.value) : null
  }

  async delete(key: string) {
    await this.#rows(`DELETE FROM ${this.#table} WHERE key = $1`, [key])
  }

  async list(prefix: string) {
    const pattern = `${prefix.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
    const rows = await this.#rows(`SELECT key, value FROM ${this.#table} WHERE key LIKE $1 AND (expires_at IS NULL OR expires_at >= now()) ORDER BY key`, [pattern])
    return rows.map((r) => ({ key: String(r.key), value: this.#value(r.value) }))
  }

  async once(key: string, ttlMs: number) {
    await this.#sweep()
    const rows = await this.#rows(
      `INSERT INTO ${this.#table} (key, value, expires_at) VALUES ($1, 'true'::jsonb, now() + ($2::bigint * interval '1 millisecond'))
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, expires_at = EXCLUDED.expires_at WHERE ${this.#table}.expires_at < now()
       RETURNING key`,
      [`#once#${key}`, Math.max(1, Math.round(ttlMs))],
    )
    return rows.length > 0
  }

  async hit(key: string, windowMs: number) {
    const [row] = await this.#rows(
      `INSERT INTO ${this.#table} (key, value, expires_at) VALUES ($1, '1'::jsonb, now() + ($2::bigint * interval '1 millisecond'))
       ON CONFLICT (key) DO UPDATE SET
         value = CASE WHEN ${this.#table}.expires_at < now() THEN '1'::jsonb ELSE to_jsonb((${this.#table}.value #>> '{}')::bigint + 1) END,
         expires_at = CASE WHEN ${this.#table}.expires_at < now() THEN EXCLUDED.expires_at ELSE ${this.#table}.expires_at END
       RETURNING value`,
      [`#hit#${key}`, Math.max(1, Math.round(windowMs))],
    )
    return Number(this.#value(row?.value) ?? 1)
  }
}
