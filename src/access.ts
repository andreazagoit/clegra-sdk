import type { Grant } from "./define"
import type { ToolHandle } from "./define"
import type { Store } from "./store"

/** The access profile's scopes (§1). OAuth scopes are local to their authorization server: no reverse-DNS. */
export const SCOPES = {
  read: "web.read",
  write: "web.write",
  irreversible: "web.irreversible",
  boundBrowserSession: "bound_browser_session",
  browserSession: "browser_session",
  offline: "offline_access",
} as const

export const WEB_SCOPES: readonly string[] = [SCOPES.read, SCOPES.write, SCOPES.irreversible]
export const ALL_SCOPES: readonly string[] = Object.values(SCOPES)

/** The scope a tool needs (ACC-2): reads `web.read`, confirmed tools `web.irreversible`, other changes `web.write`. */
export function scopeOf(tool: ToolHandle): string {
  if (tool.config.annotations.readOnly) return SCOPES.read
  return tool.config.confirm ? SCOPES.irreversible : SCOPES.write
}

/** Whether a grant holds a scope. A grant with none of the `web.*` scopes can only read (ACC-1). */
export function grantHas(grant: Pick<Grant, "scopes">, scope: string): boolean {
  if (grant.scopes.includes(scope)) return true
  if (scope === SCOPES.read) return true
  return false
}

/** One line of the access log (ACC-7). */
export type AuditEntry = {
  time: string
  /** The person the call was made for. */
  person: string
  grant: string
  client: string
  kind: "call" | "confirmation" | "session-transfer" | "revocation"
  tool?: string
  record?: string
  outcome: string
  confirmation?: { id: string; digest: string; time: string }
  target?: string
}

const pad = (n: number) => String(n).padStart(13, "0")

/** Where the log lives: the store (one key per entry, by person and time), plus the app's own hook. */
export class AccessLog {
  readonly #store: Store
  readonly #hook: ((entry: AuditEntry) => void | Promise<void>) | undefined
  readonly #days: number

  constructor(store: Store, hook: ((entry: AuditEntry) => void | Promise<void>) | undefined, days: number) {
    this.#store = store
    this.#hook = hook
    this.#days = days
  }

  /** How long the log is kept, in days (the app declares it: ACC-7). */
  get days(): number {
    return this.#days
  }

  async write(entry: Omit<AuditEntry, "time">): Promise<void> {
    const full: AuditEntry = { time: new Date().toISOString(), ...entry }
    await this.#store.set(`audit:${encodeURIComponent(full.person)}:${pad(Date.now())}:${crypto.randomUUID().slice(0, 8)}`, full, this.#days * 86400)
    await this.#hook?.(full)
  }

  /** A person's log, oldest first (at most `limit` entries, the newest ones). */
  async of(person: string, limit = 500): Promise<AuditEntry[]> {
    return (await this.#store.list<AuditEntry>(`audit:${encodeURIComponent(person)}:`, limit)).map((e) => e.value)
  }
}

/** Revoked grants: a token, a transferred session or a confirmation of a revoked grant is refused at once (ACC-6). */
export class Revocations {
  readonly #store: Store
  readonly #listeners: ((grant: string) => void | Promise<void>)[] = []

  constructor(store: Store) {
    this.#store = store
  }

  async revoked(grant: string): Promise<boolean> {
    return (await this.#store.get(`revoked:${grant}`)) !== null
  }

  onRevoke(listener: (grant: string) => void | Promise<void>): void {
    this.#listeners.push(listener)
  }

  async revoke(grant: string): Promise<void> {
    // Kept as long as any token, code or session of the grant could live (refresh tokens: the sign-in's own revocation).
    await this.#store.set(`revoked:${grant}`, { at: new Date().toISOString() }, 400 * 86400)
    for (const l of this.#listeners) await l(grant)
  }
}
