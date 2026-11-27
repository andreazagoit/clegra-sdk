import { isProduction } from "../env"

/**
 * Whether cookies for `origin` can be `Secure`: https, or, outside production only, http on a loopback host
 * (`localhost`, `*.localhost`, `127.0.0.1`, `[::1]`), which browsers treat as secure contexts, so a local stack gets the
 * same `Secure; SameSite=None; Partitioned` cookie a framing client needs. In production: https only.
 */
export function secureContext(origin: string): boolean {
  const u = new URL(origin)
  if (u.protocol === "https:") return true
  return u.protocol === "http:" && !isProduction() && /^(localhost|[a-z0-9-]+(\.[a-z0-9-]+)*\.localhost|127\.0\.0\.1|\[::1\])$/i.test(u.hostname)
}

/**
 * A session cookie that also works inside a framing client (Clegra's frame shows the app's own site): over https it is
 * `Secure; SameSite=None; Partitioned` (CHIPS), so it lives in the frame's partition and never travels to the app
 * from another site's top-level pages (and so on a loopback host outside production, `secureContext`); over other
 * plain http (a LAN address) `SameSite=Lax`, the browser's only choice there. `HttpOnly`, `Path=/` always; `__Host-`
 * prefixed when secure.
 */
export function frameCookie(input: { name: string; value: string; secure: boolean; maxAgeSeconds?: number }): string {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(input.name)) throw new Error(`cookie name "${input.name}": letters, digits, _ and -`)
  const name = input.secure ? `__Host-${input.name}` : input.name
  const age = input.maxAgeSeconds === undefined ? "" : `; Max-Age=${Math.max(0, Math.floor(input.maxAgeSeconds))}`
  return `${name}=${input.value}; Path=/; HttpOnly${age}${input.secure ? "; Secure; SameSite=None; Partitioned" : "; SameSite=Lax"}`
}

/** The cookie's name as it is sent back (with its `__Host-` prefix over https). */
export const frameCookieName = (name: string, secure: boolean) => (secure ? `__Host-${name}` : name)

/** A cookie's value from a request, or undefined. */
export function readCookie(request: Request, name: string): string | undefined {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const eq = part.indexOf("=")
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim()
  }
  return undefined
}
