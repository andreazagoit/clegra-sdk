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
