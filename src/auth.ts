import { createLocalJWKSet, decodeProtectedHeader, jwtVerify, type JWK, type JWTPayload } from "jose"

import { sha256 } from "./crypto"
import { isProduction } from "./env"
import { hostLookup } from "./platform"

/**
 * The OAuth helpers the sign-in module and the server share: errors, canonical JSON, loopback hosts, and Client ID
 * Metadata Documents (fetched with every address checked, so a client's URL never reaches the app's own network).
 */

/** How a Client ID Metadata Document is reached: `fetch` gets it, `lookup` gives every address of its host. */
export type ClientMetadataTransport = { fetch?: typeof fetch; lookup?: (host: string) => Promise<string[]> }

export class AuthError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "AuthError"
  }
}

// ------------------------------------------------------------ hashing

/** JSON with object keys sorted at every depth: what `args` hashes. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null"
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v === undefined ? null : v)).join(",")}]`
  const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`
}

/** base64url SHA-256 of a value's canonical JSON. */
export function argsHash(args: unknown): Promise<string> {
  return sha256(canonicalJson(args ?? {}))
}

const LOOPBACK = /^(127\.\d+\.\d+\.\d+|::1|::ffff:127\.\d+\.\d+\.\d+|localhost)$/

export function isLoopback(host: string | null | undefined): boolean {
  return typeof host === "string" && LOOPBACK.test(host)
}

// ------------------------------------------------------------ client id metadata documents

/**
 * A client may identify itself with the https URL of a JSON document that
 * describes it (OAuth Client ID Metadata Documents, what MCP clients use
 * since the 2025-11-25 authorization spec). The server fetches a URL that
 * whoever opens the sign-in page chose (through a tunnel that is anyone), so
 * the fetch must never reach this machine or its network: everything below
 * that refuses an address is there for that.
 *
 * Outside production (NODE_ENV is not `production`, read from the app's own
 * environment, never from the request) one exception: a URL on a loopback
 * name (localhost, *.localhost, 127.0.0.1, [::1]) may be http, and it is
 * fetched without the public-address check, so a client on a local stack
 * (its document at http://core.localhost:3000/...) can sign in to an app on
 * the same machine. In production the rule stays https on a public host,
 * with no option to relax it.
 */

/** The loopback names a client document may live on outside production, as `URL.hostname` spells them (the sign-in's issuer rule). */
const LOCAL_CLIENT_HOST = /^(localhost|127\.0\.0\.1|\[::1\]|[a-z0-9-]+\.localhost)$/i

/** Whether a client document URL is a local one: outside production only, http or https on a loopback name. */
function isLocalClientUrl(url: URL): boolean {
  return !isProduction() && (url.protocol === "http:" || url.protocol === "https:") && LOCAL_CLIENT_HOST.test(url.hostname)
}

/** How a client with a key pair may sign its `client_assertion` (RFC 7523): asymmetric only, never `none` or a shared-secret HMAC. */
export const CLIENT_ASSERTION_ALGS = ["RS256", "ES256", "PS256"] as const
export type ClientAssertionAlg = (typeof CLIENT_ASSERTION_ALGS)[number]
/** The `client_assertion_type` of a signed-JWT client authentication (RFC 7523 §2.2). */
export const CLIENT_ASSERTION_TYPE = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer"
/** How long a client assertion may live (exp − now, and exp − iat), and the clock skew allowed on top. */
export const CLIENT_ASSERTION_MAX_SECONDS = 300
const CLIENT_ASSERTION_SKEW_SECONDS = 30
const CLIENT_JWKS_MAX_KEYS = 20
/** A fetched client key set is kept this long; an unknown `kid` fetches it again, but not more often than every 10 seconds. */
const CLIENT_JWKS_CACHE_SECONDS = 300
const CLIENT_JWKS_REFETCH_MS = 10_000

/**
 * What the dev authorization server keeps of a client's metadata document. A
 * public client has only the first three; a client that authenticates with a
 * key pair (`private_key_jwt`, RFC 7523) also has its signing algorithm and
 * its keys, as a `jwks_uri` or inline `jwks`.
 */
export type ClientMetadata = {
  client_id: string
  client_name?: string
  redirect_uris: string[]
  token_endpoint_auth_method?: "private_key_jwt"
  token_endpoint_auth_signing_alg?: ClientAssertionAlg
  jwks_uri?: string
  jwks?: { keys: JWK[] }
}

/** Why a client's metadata document, or its address, is refused. */
export class ClientMetadataError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ClientMetadataError"
  }
}

export const CLIENT_METADATA_MAX_BYTES = 64 * 1024
export const CLIENT_METADATA_TIMEOUT_MS = 5000
const CLIENT_CACHE_ENTRIES = 100
const CLIENT_CACHE_DEFAULT_SECONDS = 300
const CLIENT_CACHE_MIN_SECONDS = 60
const CLIENT_CACHE_MAX_SECONDS = 24 * 3600
const CLIENT_CACHE_FAILED_SECONDS = 30

/** A `client_id` that claims to be a URL: it is handled as a metadata document address (and refused when it is not a valid one), never as an opaque id. */
const claimsUrl = (clientId: string) => /^https?:\/\//i.test(clientId)

function publicV4(a: number, b: number, c: number): boolean {
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false // "this network", private, loopback, multicast and reserved
  if (a === 100 && b >= 64 && b <= 127) return false // carrier-grade NAT
  if (a === 169 && b === 254) return false // link-local (cloud metadata services live here)
  if (a === 172 && b >= 16 && b <= 31) return false
  if (a === 192 && b === 168) return false
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false // protocol assignments, documentation
  if (a === 198 && (b === 18 || b === 19)) return false // benchmarking
  if ((a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113)) return false // documentation
  return true
}

const V4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/

/** 4 for an IPv4 address, 6 for an IPv6 one (a zone allowed), 0 for anything else (as Node's `isIP`). */
export function isIP(value: string): 0 | 4 | 6 {
  if (V4.test(value)) return 4
  const [address = "", zone, ...more] = value.split("%")
  if (more.length || zone === "" || (zone !== undefined && !/^[\w.-]+$/.test(zone))) return 0
  let s = address
  let groups = 8
  if (s.includes(".")) {
    const cut = s.lastIndexOf(":")
    if (cut < 0 || !V4.test(s.slice(cut + 1))) return 0
    s = s.slice(0, cut + 1) + "0"
    groups = 7
  }
  const halves = s.split("::")
  if (halves.length > 2) return 0
  const parts = (h: string) => (h === "" ? [] : h.split(":"))
  const left = parts(halves[0]!)
  const right = halves.length === 2 ? parts(halves[1]!) : []
  if (![...left, ...right].every((g) => /^[0-9a-f]{1,4}$/i.test(g))) return 0
  const count = left.length + right.length
  return (halves.length === 2 ? count < groups : count === groups) ? 6 : 0
}

/** The eight 16-bit groups of an IPv6 address `isIP` accepted. */
function v6Groups(ip: string): number[] {
  let s = ip.split("%")[0]!
  if (s.includes(".")) {
    const cut = s.lastIndexOf(":")
    const [a = 0, b = 0, c = 0, d = 0] = s.slice(cut + 1).split(".").map(Number)
    s = `${s.slice(0, cut + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`
  }
  const [head = "", tail] = s.split("::")
  const parse = (part: string) => part.split(":").filter(Boolean).map((g) => parseInt(g, 16))
  const left = parse(head)
  const right = tail === undefined ? [] : parse(tail)
  return [...left, ...new Array<number>(Math.max(0, 8 - left.length - right.length)).fill(0), ...right]
}

/**
 * Whether an IP address (v4 or v6, brackets allowed) is one on the public
 * internet. False for loopback, private, link-local, carrier-grade NAT,
 * unique-local, multicast, unspecified, documentation and reserved ranges,
 * for an IPv6 address that carries one of those IPv4 addresses (mapped,
 * NAT64, 6to4), and for anything that is not an IP address.
 */
export function isPublicAddress(address: string): boolean {
  const ip = address.replace(/^\[|\]$/g, "")
  const kind = isIP(ip)
  if (kind === 4) {
    const [a = 0, b = 0, c = 0] = ip.split(".").map(Number)
    return publicV4(a, b, c)
  }
  if (kind !== 6) return false
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = v6Groups(ip)
  const embedded = (hi: number, lo: number) => publicV4(hi >> 8, hi & 255, lo >> 8)
  // ::ffff:a.b.c.d (IPv4-mapped) and the old ::a.b.c.d: the IPv4 address decides (so `::` and `::1` are refused too).
  if (!g0 && !g1 && !g2 && !g3 && !g4 && (g5 === 0xffff || g5 === 0)) return embedded(g6, g7)
  if (g0 === 0x64 && g1 === 0xff9b) return !g2 && !g3 && !g4 && !g5 && embedded(g6, g7) // NAT64; its local-use prefix is refused
  if (g0 === 0x2002) return embedded(g1, g2) // 6to4
  if (g0 === 0x2001 && (g1 === 0 || g1 === 0xdb8)) return false // Teredo, documentation
  // What is left is public only inside global unicast (2000::/3): unique-local fc00::/7, link-local fe80::/10 and multicast ff00::/8 are outside it.
  return (g0 & 0xe000) === 0x2000
}

/** Why a host may not be fetched from, before any DNS: a non-public IP literal, or a name that is local by definition. Null when it may. */
function hostProblem(hostname: string): string | null {
  const host = hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase()
  if (isIP(host)) return isPublicAddress(host) ? null : `${host} is not a public address`
  if (!host.includes(".") || /(^|\.)(localhost|local|internal)$/.test(host)) return `${host || "(no host)"} is not a public host name`
  return null
}

/** Why a `client_id` is not a valid Client ID Metadata Document URL; null when it is one. */
export function clientMetadataUrlProblem(clientId: string): string | null {
  // Checked on the text as sent: the URL parser would quietly drop spaces and resolve dot segments.
  if (/[\s\x00-\x1f\\]/.test(clientId)) return "it contains spaces, control characters or backslashes"
  let url: URL
  try {
    url = new URL(clientId)
  } catch {
    return "it is not a URL"
  }
  const local = isLocalClientUrl(url)
  const scheme = /^https:\/\//i.test(clientId) ? 8 : local && /^http:\/\//i.test(clientId) ? 7 : 0
  if (!scheme || (url.protocol !== "https:" && !local)) return isProduction() ? "it must be an https URL" : "it must be an https URL (http only on a loopback host: localhost, *.localhost, 127.0.0.1, [::1])"
  if (clientId.includes("#")) return "it must not have a fragment"
  const [authority = "", ...rest] = clientId.slice(scheme).split(/[?]/)[0]!.split("/")
  if (authority.includes("@") || url.username || url.password) return "it must not carry a user name or password"
  if (url.pathname === "/" || !rest.length) return "it needs a path (https://host/path), not only a host"
  if (rest.some((segment) => /^(\.|%2e){1,2}$/i.test(segment))) return "its path must not contain . or .. segments"
  return local ? null : hostProblem(url.hostname)
}

export const isClientMetadataUrl = (clientId: string) => clientMetadataUrlProblem(clientId) === null

/** A client's key set, checked: 1–20 public keys (no private or symmetric key material). Throws ClientMetadataError. */
export function validateClientJwks(value: unknown, where = "jwks"): { keys: JWK[] } {
  const keys = value && typeof value === "object" && !Array.isArray(value) ? (value as { keys?: unknown }).keys : undefined
  if (!Array.isArray(keys) || !keys.length || keys.length > CLIENT_JWKS_MAX_KEYS) throw new ClientMetadataError(`the client's ${where} must be a key set ({ "keys": [...] }) with 1 to ${CLIENT_JWKS_MAX_KEYS} keys`)
  for (const key of keys) {
    if (!key || typeof key !== "object" || Array.isArray(key) || typeof (key as JWK).kty !== "string") throw new ClientMetadataError(`a key of the client's ${where} is not a JWK`)
    if ((key as JWK).kty === "oct" || ["d", "p", "q", "dp", "dq", "qi", "k"].some((f) => f in key)) throw new ClientMetadataError(`the client's ${where} must hold public keys only`)
  }
  return { keys: keys as JWK[] }
}

/** A fetched metadata document, checked: it must be the document of exactly this `client_id`, of a public client or of one that signs with a key pair (`private_key_jwt`). Throws ClientMetadataError. */
export function validateClientMetadata(clientId: string, document: unknown): ClientMetadata {
  if (!document || typeof document !== "object" || Array.isArray(document)) throw new ClientMetadataError("the metadata document is not a JSON object")
  const d = document as Record<string, unknown>
  if (d.client_id !== clientId) throw new ClientMetadataError("the metadata document's client_id is not the URL it was fetched from (they must be the same string)")
  if (!Array.isArray(d.redirect_uris) || !d.redirect_uris.length || !d.redirect_uris.every((u) => typeof u === "string" && u)) throw new ClientMetadataError("the metadata document needs redirect_uris, a non-empty array of strings")
  for (const uri of d.redirect_uris as string[]) {
    let scheme: string
    try {
      scheme = new URL(uri).protocol
    } catch {
      throw new ClientMetadataError("a redirect_uri of the metadata document is not an absolute URL")
    }
    if (uri.includes("#") || /^(javascript|data|vbscript|file|blob|about):$/.test(scheme)) throw new ClientMetadataError("a redirect_uri of the metadata document has a fragment or a scheme a browser must not be sent to")
  }
  if (d.client_name !== undefined && typeof d.client_name !== "string") throw new ClientMetadataError("the metadata document's client_name must be a string")
  // A document anyone can read cannot hold a shared secret (the draft forbids it); a client may prove itself with a key pair instead (private_key_jwt).
  if ("client_secret" in d || "client_secret_expires_at" in d) throw new ClientMetadataError("the metadata document must not carry client_secret or client_secret_expires_at")
  const method = d.token_endpoint_auth_method
  if (method !== undefined && method !== "none" && method !== "private_key_jwt") throw new ClientMetadataError(`token_endpoint_auth_method must be "none" (a public client), "private_key_jwt" (with jwks_uri or jwks) or absent: client secrets are not supported`)
  const base: ClientMetadata = { client_id: clientId, redirect_uris: [...(d.redirect_uris as string[])], ...(typeof d.client_name === "string" && d.client_name.trim() ? { client_name: d.client_name.trim() } : {}) }
  if (method !== "private_key_jwt") return base
  const alg = d.token_endpoint_auth_signing_alg ?? "RS256"
  if (!(CLIENT_ASSERTION_ALGS as readonly unknown[]).includes(alg)) throw new ClientMetadataError(`token_endpoint_auth_signing_alg must be one of ${CLIENT_ASSERTION_ALGS.join(", ")} (default RS256)`)
  if ((d.jwks_uri === undefined) === (d.jwks === undefined)) throw new ClientMetadataError("a private_key_jwt client needs its keys: jwks_uri or jwks (exactly one of them)")
  const keys: Pick<ClientMetadata, "jwks_uri" | "jwks"> = {}
  if (d.jwks_uri !== undefined) {
    // Fetched like the document itself: https, a public host (a loopback one outside production), no fragment, no user name.
    const problem = typeof d.jwks_uri === "string" ? clientMetadataUrlProblem(d.jwks_uri) : "it is not a string"
    if (problem) throw new ClientMetadataError(`the metadata document's jwks_uri is not a valid key set URL: ${problem}`)
    keys.jwks_uri = d.jwks_uri as string
  } else keys.jwks = validateClientJwks(d.jwks, "jwks")
  return { ...base, token_endpoint_auth_method: "private_key_jwt", token_endpoint_auth_signing_alg: alg as ClientAssertionAlg, ...keys }
}

const LOOPBACK_REDIRECT = /^(127\.0\.0\.1|localhost|\[::1\])$/

/**
 * Whether `redirect` is one of a client's registered redirect URIs: the same
 * string, with one exception (RFC 8252 §7.3): for `http://127.0.0.1`,
 * `http://localhost` and `http://[::1]` the port may differ, because a native
 * client listens on whatever port the system gives it.
 */
export function redirectUriAllowed(redirect: string, registered: readonly string[]): boolean {
  if (!redirect) return false
  if (registered.includes(redirect)) return true
  let asked: URL
  try {
    asked = new URL(redirect)
  } catch {
    return false
  }
  if (asked.protocol !== "http:" || !LOOPBACK_REDIRECT.test(asked.hostname) || redirect.includes("#") || /[\s\\]/.test(redirect)) return false
  asked.port = ""
  return registered.some((r) => {
    try {
      const known = new URL(r)
      if (known.protocol !== "http:" || !LOOPBACK_REDIRECT.test(known.hostname)) return false
      known.port = ""
      return known.href === asked.href
    } catch {
      return false
    }
  })
}

/** How long a fetched document may be kept, in seconds, from its `Cache-Control`: 0 for `no-store`/`no-cache`, else `max-age` held between a minute and a day, five minutes without one. */
export function clientMetadataCacheSeconds(cacheControl: string | null): number {
  const value = (cacheControl ?? "").toLowerCase()
  if (/(^|[\s,])no-(store|cache)\b/.test(value)) return 0
  const age = /(?:^|[\s,])max-age\s*=\s*"?(\d{1,12})/.exec(value)
  return age ? Math.min(CLIENT_CACHE_MAX_SECONDS, Math.max(CLIENT_CACHE_MIN_SECONDS, Number(age[1]))) : CLIENT_CACHE_DEFAULT_SECONDS
}

/** The runtime's resolver (an adapter's); without one a host name is refused, never fetched unchecked. */
function systemLookup(host: string): Promise<string[]> {
  const lookup = hostLookup()
  if (!lookup) throw new ClientMetadataError(`this runtime gave the SDK no DNS resolver, so ${host} can't be checked before it is fetched: serve the app through an adapter (@clegra/sdk/node, /next, /express) or give the sign-in's clientMetadata.lookup`)
  return lookup(host)
}

/**
 * Fetches and checks the metadata document of a URL `client_id`. Nothing is
 * requested unless the URL is valid and every address its host resolves to
 * is public; redirects are not followed; the answer must be 200, JSON, at
 * most 64 KB, within 5 seconds. Throws ClientMetadataError.
 *
 * The limit of this: the addresses are checked, then `fetch` resolves the
 * name again, so a DNS server that answers differently the second time (DNS
 * rebinding) gets the request sent to an address that was not checked. What
 * it can do with that is small (https only, so the internal host would have
 * to hold a certificate for the attacker's name; no redirects; the body is
 * only ever parsed as a metadata document), but it is not nothing: a
 * production authorization server should pin the connection to the address
 * it checked.
 */
export async function fetchClientMetadata(clientId: string, transport: ClientMetadataTransport = {}): Promise<{ metadata: ClientMetadata; cacheSeconds: number }> {
  const problem = clientMetadataUrlProblem(clientId)
  if (problem) throw new ClientMetadataError(`client_id is not a valid metadata document URL: ${problem}`)
  const { value, cacheSeconds } = await fetchPublicJson(clientId, transport, "metadata document")
  return { metadata: validateClientMetadata(clientId, value), cacheSeconds }
}

/** Fetches and checks the key set of a `private_key_jwt` client from its `jwks_uri`, with the same protections as the metadata document. Throws ClientMetadataError. */
export async function fetchClientJwks(jwksUri: string, transport: ClientMetadataTransport = {}): Promise<{ jwks: { keys: JWK[] }; cacheSeconds: number }> {
  const problem = clientMetadataUrlProblem(jwksUri)
  if (problem) throw new ClientMetadataError(`jwks_uri is not a valid key set URL: ${problem}`)
  const { value, cacheSeconds } = await fetchPublicJson(jwksUri, transport, "key set (jwks_uri)")
  return { jwks: validateClientJwks(value, "key set (jwks_uri)"), cacheSeconds }
}

/** A JSON document at a checked URL `address`, fetched only when every address of its host is public, or when it is a local one outside production (see fetchClientMetadata). `what` names it in errors. */
async function fetchPublicJson(address: string, transport: ClientMetadataTransport, what: string): Promise<{ value: unknown; cacheSeconds: number }> {
  const url = new URL(address)
  const host = url.hostname.replace(/^\[|\]$/g, "")
  if (!isIP(host) && !isLocalClientUrl(url)) {
    let addresses: string[]
    try {
      addresses = await (transport.lookup ?? systemLookup)(host)
    } catch (error) {
      if (error instanceof ClientMetadataError) throw error
      throw new ClientMetadataError(`the client's host ${host} does not resolve`)
    }
    if (!addresses.length) throw new ClientMetadataError(`the client's host ${host} does not resolve`)
    // One private address among public ones is enough to refuse: which one the connection would use is not ours to choose.
    const inside = addresses.find((a) => !isPublicAddress(a))
    if (inside) throw new ClientMetadataError(`the client's host ${host} resolves to ${inside}, which is not a public address`)
  }
  let response: Response
  let text: string
  try {
    response = await (transport.fetch ?? fetch)(address, { method: "GET", redirect: "error", credentials: "omit", headers: { accept: "application/json" }, signal: AbortSignal.timeout(CLIENT_METADATA_TIMEOUT_MS) })
    // A redirect could lead inside the network after the host was checked. `redirect: "error"` already refuses it; this is for a fetch that does not.
    if (response.redirected || response.status !== 200) {
      void response.body?.cancel().catch(() => {})
      throw new ClientMetadataError(`the client's ${what} answered ${response.redirected ? "with a redirect" : response.status} (it must answer 200, without redirects)`)
    }
    if (!/^application\/([\w.!#$&^-]+\+)?json\s*(;|$)/i.test(response.headers.get("content-type") ?? "")) {
      void response.body?.cancel().catch(() => {})
      throw new ClientMetadataError(`the client's ${what} is not served as JSON (content-type application/json)`)
    }
    text = await readCapped(response, CLIENT_METADATA_MAX_BYTES, what)
  } catch (error) {
    if (error instanceof ClientMetadataError) throw error
    throw new ClientMetadataError(`the client's ${what} could not be fetched (${error instanceof Error && error.name === "TimeoutError" ? "no answer in time" : "network error or redirect"})`)
  }
  let document: unknown
  try {
    document = JSON.parse(text)
  } catch {
    throw new ClientMetadataError(`the client's ${what} is not valid JSON`)
  }
  return { value: document, cacheSeconds: clientMetadataCacheSeconds(response.headers.get("cache-control")) }
}

/** The body as text, read piece by piece and dropped as soon as it passes `max` bytes (a Content-Length can lie, so the bytes are counted). */
async function readCapped(response: Response, max: number, what: string): Promise<string> {
  const tooLarge = () => new ClientMetadataError(`the client's ${what} is larger than ${max / 1024} KB`)
  if (Number(response.headers.get("content-length") ?? 0) > max) {
    void response.body?.cancel().catch(() => {})
    throw tooLarge()
  }
  if (!response.body) return ""
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > max) {
      void reader.cancel().catch(() => {})
      throw tooLarge()
    }
    chunks.push(value)
  }
  const all = new Uint8Array(size)
  let at = 0
  for (const c of chunks) {
    all.set(c, at)
    at += c.byteLength
  }
  return new TextDecoder().decode(all)
}

/**
 * Clients known by their Client ID Metadata Document (fetched, checked, cached by its Cache-Control) and, for a client
 * with a key pair, its `private_key_jwt` assertions (RFC 7523: its keys, one use per `jti`). Shared by the dev
 * authority and the sign-in module (`@clegra/sdk/signin`).
 */
export class ClientDirectory {
  /** Client documents by client_id, oldest first; a failed fetch is kept too, briefly, so a broken client cannot make this server hammer a host. */
  readonly #clients = new Map<string, { until: number; result: Promise<ClientMetadata> }>()
  /** Key sets of private_key_jwt clients by jwks_uri, oldest first (a failure is kept briefly too). */
  readonly #keySets = new Map<string, { fetchedAt: number; until: number; result: Promise<{ keys: JWK[] }> }>()
  /** Client assertion ids already used, until their expiry (ms): an assertion is good for one request. */
  readonly #usedAssertions = new Map<string, number>()

  constructor(readonly transport: ClientMetadataTransport = {}) {}

  /** The checked metadata document of a URL `client_id`, from the cache or fetched. Throws ClientMetadataError. */
  client(clientId: string): Promise<ClientMetadata> {
    const kept = this.#clients.get(clientId)
    if (kept && kept.until > Date.now()) return kept.result
    this.#clients.delete(clientId)
    // An address that is refused without a request costs nothing to refuse again: only what was fetched is kept.
    if (clientMetadataUrlProblem(clientId)) return fetchClientMetadata(clientId, this.transport).then((r) => r.metadata)
    while (this.#clients.size >= CLIENT_CACHE_ENTRIES) this.#clients.delete(this.#clients.keys().next().value!)
    const entry = { until: Date.now() + CLIENT_CACHE_FAILED_SECONDS * 1000, result: Promise.resolve(null as unknown as ClientMetadata) }
    entry.result = fetchClientMetadata(clientId, this.transport).then(({ metadata, cacheSeconds }) => {
      // `no-store`: requests already waiting share this answer, the next one fetches again.
      if (!cacheSeconds) {
        if (this.#clients.get(clientId) === entry) this.#clients.delete(clientId)
      } else entry.until = Date.now() + cacheSeconds * 1000
      return metadata
    })
    entry.result.catch(() => {})
    this.#clients.set(clientId, entry)
    return entry.result
  }

  /** The key set of a private_key_jwt client: inline, or from its jwks_uri (kept a few minutes; `fresh` fetches again unless it was fetched in the last 10 seconds). */
  #clientKeys(client: ClientMetadata, fresh = false): Promise<{ keys: JWK[] }> {
    if (client.jwks) return Promise.resolve(client.jwks)
    const uri = client.jwks_uri!
    const now = Date.now()
    const kept = this.#keySets.get(uri)
    if (kept && (fresh ? now - kept.fetchedAt < CLIENT_JWKS_REFETCH_MS : kept.until > now)) return kept.result
    this.#keySets.delete(uri)
    while (this.#keySets.size >= CLIENT_CACHE_ENTRIES) this.#keySets.delete(this.#keySets.keys().next().value!)
    const entry = { fetchedAt: now, until: now + CLIENT_CACHE_FAILED_SECONDS * 1000, result: Promise.resolve({ keys: [] as JWK[] }) }
    entry.result = fetchClientJwks(uri, this.transport).then(({ jwks, cacheSeconds }) => {
      entry.until = Date.now() + Math.min(cacheSeconds, CLIENT_JWKS_CACHE_SECONDS) * 1000
      return jwks
    })
    entry.result.catch(() => {})
    this.#keySets.set(uri, entry)
    return entry.result
  }

  /** Whether an assertion id is new (and from now on used, until `untilMs`). */
  #firstUse(key: string, untilMs: number): boolean {
    const now = Date.now()
    for (const [k, until] of this.#usedAssertions) if (until <= now) this.#usedAssertions.delete(k)
    if (this.#usedAssertions.has(key)) return false
    this.#usedAssertions.set(key, untilMs)
    return true
  }

  /**
   * Client authentication with a signed JWT (RFC 7523 §2.2, `private_key_jwt`):
   * signed with the client's algorithm by a key of its key set, `iss` = `sub`
   * = its client_id, `aud` this server's token endpoint or issuer, short-lived,
   * with a `jti` that is used once. Returns why not, or null when it holds.
   */
  async authenticate(client: ClientMetadata, form: URLSearchParams, audiences: string[]): Promise<string | null> {
    const assertion = form.get("client_assertion") ?? ""
    if (!assertion) return "this client authenticates with private_key_jwt: client_assertion is required"
    if (form.get("client_assertion_type") !== CLIENT_ASSERTION_TYPE) return `client_assertion_type must be ${CLIENT_ASSERTION_TYPE}`
    const alg = client.token_endpoint_auth_signing_alg ?? "RS256"
    let header: ReturnType<typeof decodeProtectedHeader>
    try {
      header = decodeProtectedHeader(assertion)
    } catch {
      return "client_assertion is not a JWT"
    }
    if (header.alg !== alg) return `client_assertion must be signed with ${alg} (the client's token_endpoint_auth_signing_alg)`
    const options = { algorithms: [alg], issuer: client.client_id, subject: client.client_id, audience: audiences, clockTolerance: CLIENT_ASSERTION_SKEW_SECONDS, requiredClaims: ["exp", "jti"] }
    let payload: JWTPayload
    try {
      try {
        ;({ payload } = await jwtVerify(assertion, createLocalJWKSet(await this.#clientKeys(client)), options))
      } catch (error) {
        // A key the cached set does not have: the client may have rotated its keys, so its jwks_uri is asked once more.
        if (!client.jwks_uri || (error as { code?: string }).code !== "ERR_JWKS_NO_MATCHING_KEY") throw error
        ;({ payload } = await jwtVerify(assertion, createLocalJWKSet(await this.#clientKeys(client, true)), options))
      }
    } catch (error) {
      if (error instanceof ClientMetadataError) return error.message
      return `client_assertion: ${(error as { code?: string }).code === "ERR_JWKS_NO_MATCHING_KEY" ? "no key of the client's key set matches it" : error instanceof Error ? error.message : "invalid"}`
    }
    const now = Math.floor(Date.now() / 1000)
    const exp = payload.exp!
    if (exp - now > CLIENT_ASSERTION_MAX_SECONDS + CLIENT_ASSERTION_SKEW_SECONDS || (typeof payload.iat === "number" && exp - payload.iat > CLIENT_ASSERTION_MAX_SECONDS)) return `a client_assertion lives ${CLIENT_ASSERTION_MAX_SECONDS / 60} minutes at most`
    if (typeof payload.jti !== "string" || !payload.jti) return "client_assertion needs a jti"
    if (!this.#firstUse(`${client.client_id}\n${payload.jti}`, (exp + CLIENT_ASSERTION_SKEW_SECONDS) * 1000)) return "this client_assertion was already used (its jti is for one request)"
    return null
  }

}
