/** Where write results are kept for idempotency (spec §11.5). A server on several instances passes a shared one. */
export type IdempotencyStore = {
  get(key: string): Promise<{ args: string; result: unknown } | undefined>
  set(key: string, value: { args: string; result: unknown }, ttlMs: number): Promise<void>
}

export class MemoryStore implements IdempotencyStore {
  readonly #items = new Map<string, { value: { args: string; result: unknown }; until: number }>()

  async get(key: string) {
    const item = this.#items.get(key)
    if (!item) return undefined
    if (item.until < Date.now()) {
      this.#items.delete(key)
      return undefined
    }
    return item.value
  }

  async set(key: string, value: { args: string; result: unknown }, ttlMs: number) {
    if (this.#items.size > 50_000) for (const [k, v] of this.#items) if (v.until < Date.now()) this.#items.delete(k)
    this.#items.set(key, { value, until: Date.now() + ttlMs })
  }
}
