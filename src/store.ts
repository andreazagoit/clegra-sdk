/**
 * What the server remembers between requests (spec §7): the results of
 * writes, for idempotency, and the ids of tokens that may be used once.
 * Every method is one atomic step. The default keeps it in memory; a server
 * on several instances passes a shared one (a database row with a unique
 * key, Redis SET NX).
 */
export type StoredCall = { args: string; result?: unknown }

/**
 * A confirmed call kept to run later («approve now, act later»), exactly as the person confirmed it: its
 * arguments as received and their hash, when (`at`, as given) and until when (`until`, epoch seconds) it may
 * run, its author and the permissions it runs with, and the host's signed proof (null when a plain client
 * confirmed it: no proof exists then) with what re-verifies it (`issuer`, `subject`, `installation`, `call`).
 */
export type LaterRun = {
  id: string
  /** The tenant (`<installation>@<issuer>`, or the app's own). */
  tenant: string
  tool: string
  args: Record<string, unknown>
  argsHash: string
  at: string
  until: number
  author: { id: string; name: string } | null
  permissions: string[]
  proof: string | null
  issuer: string
  subject: string
  /** The installation as its issuer names it (the proof's `installation`). */
  installation: string
  call: string | null
  /** When the person confirmed it, epoch seconds (the proof's `iat`). */
  confirmedAt: number
}

/** How a later run ended. */
export type LaterOutcome = { status: "done" | "failed" | "expired" | "refused"; message: string }

/**
 * The store's part for later runs. `claim` is the single-use step: it takes a pending run in one atomic step
 * (two callers at the same moment: one gets the run, the other null), and a claimed run is never given again.
 */
export type LaterStore = {
  add(run: LaterRun): Promise<void>
  /** Pending runs of the tenant whose `at` is not after `now`, oldest first, at most `limit`. */
  due(tenant: string, now: Date, limit: number): Promise<LaterRun[]>
  claim(id: string, tenant: string): Promise<LaterRun | null>
  finish(id: string, outcome: LaterOutcome): Promise<void>
  /** Cancels a pending run of the tenant: false when there is none (unknown, another tenant's, claimed or finished). */
  cancel(id: string, tenant: string): Promise<boolean>
  /** Deletes every run of the tenant, whatever its state (the app's data deletion): how many. */
  clear(tenant: string): Promise<number>
}

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
  /** Keeps a short value under `key` for `ttlMs` (DPoP nonces, revocation marks), replacing what was there. */
  put(key: string, value: string, ttlMs: number): Promise<void>
  /** The value `put` under `key`, null when there is none or it expired. */
  get(key: string): Promise<string | null>
  /** Counts one more hit on `key` in a fixed window of `windowMs` that starts with the first hit: the count, this one included (rate limits). */
  hit(key: string, windowMs: number): Promise<number>
  /** Later runs (needed by actions with `later`). */
  later?: LaterStore
}

type KeptRun = { run: LaterRun; status: "pending" | "running" | "cancelled" | LaterOutcome["status"]; message?: string }

/** Later runs in memory: what MemoryStore keeps (one process, lost on restart). */
export class MemoryLater implements LaterStore {
  readonly #runs = new Map<string, KeptRun>()
  async add(run: LaterRun) {
    if (this.#runs.has(run.id)) throw new Error(`later run ${run.id} exists`)
    this.#runs.set(run.id, { run: structuredClone(run), status: "pending" })
  }
  async due(tenant: string, now: Date, limit: number) {
    return [...this.#runs.values()]
      .filter((k) => k.status === "pending" && k.run.tenant === tenant && Date.parse(k.run.at) <= now.getTime())
      .sort((a, b) => Date.parse(a.run.at) - Date.parse(b.run.at))
      .slice(0, limit)
      .map((k) => structuredClone(k.run))
  }
  // No await between the read and the write: one step on Node's single thread.
  async claim(id: string, tenant: string) {
    const k = this.#runs.get(id)
    if (!k || k.run.tenant !== tenant || k.status !== "pending") return null
    k.status = "running"
    return structuredClone(k.run)
  }
  async finish(id: string, outcome: LaterOutcome) {
    const k = this.#runs.get(id)
    if (k) Object.assign(k, { status: outcome.status, message: outcome.message })
  }
  async cancel(id: string, tenant: string) {
    const k = this.#runs.get(id)
    if (!k || k.run.tenant !== tenant || k.status !== "pending") return false
    k.status = "cancelled"
    return true
  }
  async clear(tenant: string) {
    let n = 0
    for (const [id, k] of this.#runs) if (k.run.tenant === tenant && this.#runs.delete(id)) n++
    return n
  }
  /** For tests: a run as kept, its state included. */
  inspect(id: string): (LaterRun & { status: string; message?: string }) | undefined {
    const k = this.#runs.get(id)
    return k ? { ...structuredClone(k.run), status: k.status, ...(k.message !== undefined ? { message: k.message } : {}) } : undefined
  }
}

export class MemoryStore implements IdempotencyStore {
  readonly #items = new Map<string, { value: StoredCall; until: number }>()
  readonly later = new MemoryLater()

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

  async put(key: string, value: string, ttlMs: number) {
    this.#put(`#v#${key}`, { args: value, result: true }, ttlMs)
  }

  async get(key: string) {
    return this.#live(`#v#${key}`)?.args ?? null
  }

  async hit(key: string, windowMs: number) {
    const k = `#h#${key}`
    const item = this.#items.get(k)
    if (!item || item.until < Date.now()) {
      this.#put(k, { args: "1" }, windowMs)
      return 1
    }
    item.value = { args: String(Number(item.value.args) + 1) }
    return Number(item.value.args)
  }
}

/**
 * Runs one SQL statement with positional parameters (`$1`, `$2`, …) and gives
 * back its rows: whatever the app already talks to its database with
 * (`pg`'s `pool.query`, `postgres`'s `sql.unsafe`, PGlite's `db.query`, a
 * Drizzle `db.execute`). The SDK knows no driver.
 */
export type SqlQuery = (text: string, params: unknown[]) => Promise<{ rows: Record<string, unknown>[] } | Record<string, unknown>[]>

/** A table name SqlStore accepts: a plain lowercase SQL name that leaves room for `_later` (and its index names). */
function checkTable(table: string): string {
  if (!/^[a-z_][a-z0-9_]{0,44}$/.test(table)) throw new Error(`SqlStore: table "${table}" must be a plain lowercase SQL name, at most 45 characters`)
  return table
}

const RUN_COLUMNS = "id, tenant, tool, args, args_hash, at, until, author, permissions, proof, issuer, subject, installation, call, confirmed_at"

function runOf(row: Record<string, unknown>): LaterRun {
  const json = (v: unknown) => (typeof v === "string" ? (JSON.parse(v) as unknown) : v)
  return {
    id: String(row.id),
    tenant: String(row.tenant),
    tool: String(row.tool),
    // Kept as the exact text received: its hash is checked again before it runs.
    args: JSON.parse(String(row.args)) as Record<string, unknown>,
    argsHash: String(row.args_hash),
    at: String(row.at),
    until: Number(row.until),
    author: (json(row.author) ?? null) as LaterRun["author"],
    permissions: (json(row.permissions) ?? []) as string[],
    proof: row.proof === null || row.proof === undefined ? null : String(row.proof),
    issuer: String(row.issuer),
    subject: String(row.subject),
    installation: String(row.installation),
    call: row.call === null || row.call === undefined ? null : String(row.call),
    confirmedAt: Number(row.confirmed_at),
  }
}

/** Later runs in the app's Postgres (`<table>_later`): each method one statement; `claim` takes a pending run atomically. */
class SqlLater implements LaterStore {
  constructor(
    private readonly rows: (text: string, params: unknown[]) => Promise<Record<string, unknown>[]>,
    private readonly table: string,
  ) {}
  async add(run: LaterRun) {
    await this.rows(
      `INSERT INTO ${this.table} (${RUN_COLUMNS}, due_at, status) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11, $12, $13, $14, $15, $16::timestamptz, 'pending')`,
      [run.id, run.tenant, run.tool, JSON.stringify(run.args), run.argsHash, run.at, run.until, JSON.stringify(run.author), JSON.stringify(run.permissions), run.proof, run.issuer, run.subject, run.installation, run.call, run.confirmedAt, new Date(Date.parse(run.at)).toISOString()],
    )
  }
  async due(tenant: string, now: Date, limit: number) {
    const rows = await this.rows(`SELECT ${RUN_COLUMNS} FROM ${this.table} WHERE tenant = $1 AND status = 'pending' AND due_at <= $2::timestamptz ORDER BY due_at LIMIT $3`, [tenant, now.toISOString(), Math.max(1, Math.floor(limit))])
    return rows.map(runOf)
  }
  async claim(id: string, tenant: string) {
    const [row] = await this.rows(`UPDATE ${this.table} SET status = 'running', claimed_at = now() WHERE id = $1 AND tenant = $2 AND status = 'pending' RETURNING ${RUN_COLUMNS}`, [id, tenant])
    return row ? runOf(row) : null
  }
  async finish(id: string, outcome: LaterOutcome) {
    await this.rows(`UPDATE ${this.table} SET status = $2, message = $3, finished_at = now() WHERE id = $1`, [id, outcome.status, outcome.message])
  }
  async cancel(id: string, tenant: string) {
    return (await this.rows(`UPDATE ${this.table} SET status = 'cancelled', finished_at = now() WHERE id = $1 AND tenant = $2 AND status = 'pending' RETURNING id`, [id, tenant])).length > 0
  }
  async clear(tenant: string) {
    return (await this.rows(`DELETE FROM ${this.table} WHERE tenant = $1 RETURNING id`, [tenant])).length
  }
}

/**
 * A store in the app's own Postgres (two tables), for serverless and several
 * instances: every method is a single statement, atomic on its own. Create the
 * tables once with `SqlStore.schema()` in a migration (the SDK never migrates;
 * the SQL is idempotent, so a new migration may run it again).
 * Expired rows are taken over in place and swept now and then.
 */
export class SqlStore implements IdempotencyStore {
  readonly #query: SqlQuery
  readonly #table: string
  readonly later: LaterStore
  #calls = 0

  constructor(query: SqlQuery, options: { table?: string } = {}) {
    const table = checkTable(options.table ?? "clegra_store")
    this.#query = query
    this.#table = table
    this.later = new SqlLater((text, params) => this.#rows(text, params), `${table}_later`)
  }

  /** The tables (`<table>` and `<table>_later`), as SQL for a migration: `CREATE … IF NOT EXISTS`, safe to run again. */
  static schema(table = "clegra_store"): string {
    checkTable(table)
    const later = `${table}_later`
    return [
      `CREATE TABLE IF NOT EXISTS ${table} (key text PRIMARY KEY, args text NOT NULL, result jsonb, done boolean NOT NULL DEFAULT false, expires_at timestamptz NOT NULL);`,
      `CREATE INDEX IF NOT EXISTS ${table}_expires_at ON ${table} (expires_at);`,
      `CREATE TABLE IF NOT EXISTS ${later} (id text PRIMARY KEY, tenant text NOT NULL, tool text NOT NULL, args text NOT NULL, args_hash text NOT NULL, at text NOT NULL, due_at timestamptz NOT NULL, until bigint NOT NULL, author jsonb, permissions jsonb NOT NULL, proof text, issuer text NOT NULL, subject text NOT NULL, installation text NOT NULL, call text, confirmed_at bigint NOT NULL, status text NOT NULL DEFAULT 'pending', message text, created_at timestamptz NOT NULL DEFAULT now(), claimed_at timestamptz, finished_at timestamptz);`,
      `CREATE INDEX IF NOT EXISTS ${later}_due ON ${later} (tenant, due_at) WHERE status = 'pending';`,
    ].join("\n")
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

  async put(key: string, value: string, ttlMs: number): Promise<void> {
    await this.#rows(
      `INSERT INTO ${this.#table} (key, args, result, done, expires_at) VALUES ($1, $2, 'true'::jsonb, true, now() + ($3::bigint * interval '1 millisecond'))
       ON CONFLICT (key) DO UPDATE SET args = EXCLUDED.args, result = EXCLUDED.result, done = true, expires_at = EXCLUDED.expires_at`,
      [`#v#${key}`, value, Math.max(1, Math.round(ttlMs))],
    )
  }

  async get(key: string): Promise<string | null> {
    const [row] = await this.#rows(`SELECT args FROM ${this.#table} WHERE key = $1 AND done AND expires_at >= now()`, [`#v#${key}`])
    return row ? String(row.args) : null
  }

  async hit(key: string, windowMs: number): Promise<number> {
    await this.#sweep()
    const [row] = await this.#rows(
      `INSERT INTO ${this.#table} (key, args, result, done, expires_at) VALUES ($1, '1', NULL, false, now() + ($2::bigint * interval '1 millisecond'))
       ON CONFLICT (key) DO UPDATE SET
         args = CASE WHEN ${this.#table}.expires_at < now() THEN '1' ELSE (${this.#table}.args::bigint + 1)::text END,
         expires_at = CASE WHEN ${this.#table}.expires_at < now() THEN EXCLUDED.expires_at ELSE ${this.#table}.expires_at END
       RETURNING args`,
      [`#h#${key}`, Math.max(1, Math.round(windowMs))],
    )
    return Number(row?.args ?? 1)
  }
}
