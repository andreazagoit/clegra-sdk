// Web Crypto only (Node 20+, Deno, Bun, edge runtimes): random tokens, hashes, password hashes.

const encoder = new TextEncoder()

/** base64url without padding. */
export function base64url(bytes: Uint8Array): string {
  let binary = ""
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

export function fromBase64url(text: string): Uint8Array {
  const b64 = text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4)
  const binary = atob(b64)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

/** `bytes` random bytes as base64url (32 by default: 256 bits). */
export function randomToken(bytes = 32): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)))
}

/** SHA-256 of a UTF-8 string, base64url. */
export async function sha256(text: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text))))
}

/** Equal strings, in time that depends only on their length. */
export function sameText(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/** PBKDF2-SHA256 iterations of a password hash (OWASP's recommendation for PBKDF2-HMAC-SHA256). */
export const PASSWORD_ITERATIONS = 600_000

/** A password hash: `pbkdf2-sha256$<iterations>$<salt>$<hash>`. */
export async function hashPassword(password: string, iterations = PASSWORD_ITERATIONS): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  return `pbkdf2-sha256$${iterations}$${base64url(salt)}$${await derive(password, salt, iterations)}`
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, rounds, salt, hash] = stored.split("$")
  if (scheme !== "pbkdf2-sha256" || !rounds || !salt || !hash) return false
  const iterations = Number(rounds)
  if (!Number.isInteger(iterations) || iterations < 1) return false
  return sameText(await derive(password, fromBase64url(salt), iterations), hash)
}

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(password.normalize("NFKC")), "PBKDF2", false, ["deriveBits"])
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: salt as Uint8Array<ArrayBuffer>, iterations }, key, 256)
  return base64url(new Uint8Array(bits))
}
