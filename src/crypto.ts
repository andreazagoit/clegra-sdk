// Web Crypto only (Node 20+, Deno, Bun, edge runtimes): random tokens, hashes, base64url, password hashes.

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** Standard base64, with padding. */
export function base64(bytes: Uint8Array): string {
  let binary = ""
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}

/** base64url without padding. */
export function base64url(bytes: Uint8Array): string {
  return base64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

export function fromBase64url(text: string): Uint8Array {
  const b64 = text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4)
  const binary = atob(b64)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

/** A UTF-8 string as base64url. */
export const textToBase64url = (text: string) => base64url(encoder.encode(text))
/** base64url back to its UTF-8 string. */
export const base64urlToText = (text: string) => decoder.decode(fromBase64url(text))

/** `bytes` random bytes as base64url (32 by default: 256 bits). */
export function randomToken(bytes = 32): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)))
}

/** SHA-256 of a UTF-8 string, base64url. */
export async function sha256(text: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text))))
}

/** SHA-256 of bytes, lowercase hex. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>))
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("")
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
