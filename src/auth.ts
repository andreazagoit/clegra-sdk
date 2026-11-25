import { createHash, randomBytes, randomUUID } from "node:crypto"
import { lookup as dnsLookup } from "node:dns/promises"
import { isIP } from "node:net"

import {
  createLocalJWKSet,
  decodeJwt,
  decodeProtectedHeader,
  exportJWK,
  generateKeyPair,
  importJWK,
  jwtVerify,
  SignJWT,
  type CryptoKey,
  type JWK,
  type JWTPayload,
} from "jose"

import { CONFIRMATION_TYPE, OAUTH_SCOPE, PROTOCOL_ID, TOKEN_CLAIM } from "../spec/src/protocol"
import type { ClegraCaller, ClegraOptions } from "./clegra"

/**
 * AUTH (spec §7). Two kinds of access token reach an app:
 *
 * - **its own** (an app with its own users): issued by the app's own authorization server (better-auth, Clerk, …)
 *   to an MCP client such as ChatGPT or Claude. The SDK does not read them: the app verifies them in
 *   `auth.resolve(token, request, { resource })` and says who is calling (tenant, person, permissions).
 * - **Clegra's core's** (`auth.clegra`, clegra.ts): app tokens bound to the caller's key (DPoP), for exactly this
 *   app's address (`auth.resource`), the tenant `<company>@<issuer>`; the person's permissions are the app's own
 *   (roles per person per tenant, the store's `roles`).
 *
 * Dev mode: the SDK is its own authorization server with a local key (DevAuthority below), for callers on a
 * loopback address only. Its tokens carry the `clegra` claim and can stand in for a workspace host (`host:
 * "workspace"`), which confirms writes with a signed proof (`clegra-confirm+jwt`) and calls the installation-level
 * tools (schedules, later runs, lifecycle) with no person: development and tests only.
 */

export { CONFIRMATION_TYPE }
export const DEV_ISSUER = `${PROTOCOL_ID}-dev`
/** The `typ` of an access token (RFC 9068). */
export const ACCESS_TOKEN_TYPE = "at+jwt"
/** How long a dev workspace host's access token may live: it is for one request. */
export const HOST_TOKEN_SECONDS = 60
export const INSTALLATION = /^[A-Za-z0-9._:-]{1,128}$/

/** The tenant of a caller: the installation as its issuer names it, bound to that issuer. */
export const tenantOf = (installation: string, issuer: string) => `${installation}@${issuer}`

export type Person = { id: string; name: string }

/** Who is calling, as every handler sees it (`ctx`). */
export type Caller = {
  /** The tenant: the installation bound to its issuer (`<installation>@<issuer>`). Unique across issuers. */
  installation: string
  /** The installation as the issuer names it (the token's claim; what a confirmation proof repeats). */
  installationId: string
  person: Person | null
  permissions: ReadonlySet<string>
  locale?: string
  /** `workspace`: a host that confirms writes itself and sends proofs; `plain`: any other MCP host. */
  host: "workspace" | "plain"
  issuer: string
  subject: string
  /** A caller from Clegra's core (`auth.clegra`): its company, company role, device key, actor and grant. */
  clegra?: ClegraCaller
  /** A caller with no token (`auth.public`): it reaches only the actions declared `public`. */
  public?: true
}

/** The `clegra` claim of a dev access token. */
export type HostClaim = {
  installation: string
  person?: Person
  permissions?: string[]
  locale?: string
  host?: "workspace" | "plain"
}

/**
 * Who a token of the app's own names, as `auth.resolve` says it. The tenant is
 * the app's to say (an organization, a workspace, an account): never a value a
 * request parameter carries.
 */
export type ResolvedCaller = {
  /** The tenant handlers scope every read and write by: `[A-Za-z0-9._:-]{1,128}` (no `@`: a host's tenants are `<installation>@<issuer>`, so the two can never meet). */
  installation: string
  person: Person | null
  /** What this person may do here, from the app's own roles. */
  permissions: readonly string[] | "all"
  locale?: string
  /** A stable id of who is calling (default the person's id): idempotency is kept per subject. */
  subject?: string
}

/** What `auth.resolve` is told about the request beside the token. */
export type ResolveInfo = {
  /** This server's public MCP address: the audience the token must have been issued for (RFC 8707). */
  resource: string
}

/**
 * Verifies a token of the app's own and names its caller: null when the token is not one (the request is
 * refused with a 401 and the protected-resource metadata), or throws an `AuthError` with the reason. It MUST
 * check the signature, the expiry and that the token's audience is `info.resource`.
 */
export type CallerResolver = (token: string, request: Request, info: ResolveInfo) => Promise<ResolvedCaller | null> | ResolvedCaller | null

export type AuthOptions = {
  /** The app's own access tokens (spec §7, «The app's own tokens»): verified by the app, mapped to a caller. */
  resolve?: CallerResolver
  /**
   * Answers the app's authorization-server paths that live outside its auth library's mount (RFC 8414
   * metadata under `/.well-known/…`), on the same routes as MCP: null for any other path.
   */
  serve?: (request: Request) => Promise<Response | null> | Response | null
  /**
   * Clegra's core as the one trusted issuer (spec §7, «Clegra tokens»): its app tokens with DPoP, the tenant
   * `<company>@<issuer>`, the app's own roles, confirmations, events, CORS. Needs `resource`. `clegraFromEnv()` reads it
   * from `CLEGRA_*` variables.
   */
  clegra?: ClegraOptions
  /**
   * This server's public MCP address, exactly as clients reach it (`https://crm.example.com/mcp`): the only audience
   * (`aud`) accepted, and what the DPoP proofs of Clegra calls must name (`htu`). Required with `clegra`, and in
   * production with `resolve`.
   */
  resource?: string
  /**
   * The authorization servers named in the protected-resource metadata: the app's own (its sign-in), never
   * Clegra's core (whose tokens a client gets from Clegra, not by OAuth). Default none.
   */
  authorizationServers?: string[]
  /**
   * Dev mode: a local signing key, a minimal authorization server for test
   * people, `app.devToken()`. Off unless set here; refused when NODE_ENV is
   * `production`; answers callers on a loopback address only.
   */
  dev?: boolean | DevOptions
  /**
   * Public operations (spec §7 «Public operations»): signing in is not mandatory for an app. A call without a token is
   * served as this installation's public caller, which reaches only the actions declared `public: true` (global, no
   * permission; a public write is always confirmed): no record, page or artifact. Allowed in production.
   */
  public?: { installation: string; locale?: string }
  /** Serve calls without a token as this caller (local demos only). Off by default; refused when NODE_ENV is `production`. */
  anonymous?: { installation: string; person?: Person; permissions: string[] | "all"; locale?: string }
}

export type DevOptions = {
  /** Test people offered on the sign-in page (default one, «Test person»). */
  people?: (Person & { permissions?: string[] | "all" })[]
  /** The installation dev tokens are for (default `dev`). */
  installation?: string
  /**
   * Where the dev key is kept so tokens survive a restart (default `.clegra-dev-key.json` in the working
   * directory); `false` keeps it in memory only. `CLEGRA_DEV_KEY` (a private JWK as JSON) wins over both.
   */
  keyFile?: string | false
  /** The one-time code the sign-in page asks for (default: random, printed on start). */
  code?: string
  /** For tests: how a client's metadata document is fetched and its host resolved (default: the global `fetch` and the system resolver). */
  clientMetadata?: ClientMetadataTransport
}

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

/** base64url SHA-256 of the arguments' canonical JSON (the proof's `args`). */
export function argsHash(args: unknown): string {
  return createHash("sha256").update(canonicalJson(args ?? {})).digest("base64url")
}

// ------------------------------------------------------------ verifying

/** What one request allows: whether dev tokens are accepted (a loopback caller) and the address it came to. */
export type RequestTrust = { dev: boolean; requestResource: string | null }

/** The dev authority's tokens: verified here (Clegra's core's are clegra.ts's, the app's own its `resolve`'s). */
export class TokenVerifier {
  readonly #resource: string | null
  readonly #once: (key: string, ttlMs: number) => Promise<boolean>
  #dev: DevAuthority | null = null

  constructor(options: AuthOptions, once: (key: string, ttlMs: number) => Promise<boolean>) {
    this.#once = once
    this.#resource = options.resource ?? null
    if (this.#resource) {
      let url: URL
      try {
        url = new URL(this.#resource)
      } catch {
        throw new Error(`auth.resource: "${this.#resource}" is not a URL`)
      }
      if (!/^https?:$/.test(url.protocol) || url.hash || url.search) throw new Error(`auth.resource: "${this.#resource}" must be an http(s) URL without query or fragment`)
    }
  }

  useDev(dev: DevAuthority) {
    this.#dev = dev
  }

  /** Whether a token is one this verifier answers for (a JWT whose `iss` is the dev authority's), so it is never handed to `auth.resolve`. */
  knows(token: string): boolean {
    let iss: string | undefined
    try {
      iss = decodeJwt(token).iss
    } catch {
      return false
    }
    return Boolean(iss && this.#dev?.issues(iss))
  }

  /** The keys and the audiences of the dev authority for this request; why not, as an AuthError. */
  #trustOf(iss: string | undefined, trust: RequestTrust): { keys: CryptoKey; audience: string[]; issuer: string } {
    if (this.#dev && iss && this.#dev.issues(iss)) {
      if (!trust.dev) throw new AuthError("dev sign-in answers callers on a loopback address only")
      // Every name the dev authority answers under is one authority, one tenant space.
      return { keys: this.#dev.publicKey, audience: [DEV_ISSUER, ...(trust.requestResource ? [trust.requestResource] : [])], issuer: DEV_ISSUER }
    }
    throw new AuthError(`untrusted issuer ${iss ?? "(none)"}`)
  }

  /** The caller an access token names. Throws AuthError with the reason. */
  async verify(token: string, trust: RequestTrust): Promise<Caller & { claims: JWTPayload }> {
    let iss: string | undefined
    try {
      iss = decodeJwt(token).iss
    } catch {
      throw new AuthError("malformed token")
    }
    const { keys, audience, issuer } = this.#trustOf(iss, trust)
    let payload: JWTPayload
    try {
      ;({ payload } = await jwtVerify(token, keys as Parameters<typeof jwtVerify>[1], { typ: ACCESS_TOKEN_TYPE, audience, clockTolerance: 30, requiredClaims: ["exp", "sub", "aud"] }))
    } catch (error) {
      const message = error instanceof Error ? error.message : "invalid token"
      throw new AuthError(/"aud"/.test(message) ? `the token is for another server (this one is ${audience.join(" or ")})` : message)
    }
    const m = payload[TOKEN_CLAIM] as HostClaim | undefined
    if (!m || typeof m.installation !== "string" || !INSTALLATION.test(m.installation)) throw new AuthError(`the token has no valid ${TOKEN_CLAIM}.installation`)
    const host = m.host === "workspace" ? "workspace" : "plain"
    if (host === "workspace") {
      // A (dev) workspace host signs a token per request: short, with an id, used once.
      if (typeof payload.jti !== "string" || !payload.jti || typeof payload.iat !== "number") throw new AuthError("a workspace host's token needs jti and iat")
      if (payload.exp! - payload.iat > HOST_TOKEN_SECONDS) throw new AuthError(`a workspace host's token lives ${HOST_TOKEN_SECONDS} seconds at most`)
      const left = Math.max(1, payload.exp! + 30 - Math.floor(Date.now() / 1000))
      if (!(await this.#once(`jti:${issuer}:${payload.jti}`, left * 1000))) throw new AuthError("this token was already used (a workspace host's token is for one request)")
    }
    return {
      installation: tenantOf(m.installation, issuer),
      installationId: m.installation,
      person: m.person && typeof m.person.id === "string" ? { id: m.person.id, name: String(m.person.name ?? "") } : null,
      permissions: new Set(Array.isArray(m.permissions) ? m.permissions.filter((p) => typeof p === "string") : []),
      ...(typeof m.locale === "string" ? { locale: m.locale } : {}),
      host,
      issuer: iss!,
      subject: String(payload.sub ?? ""),
      claims: payload,
    }
  }

  /**
   * Checks a confirmation proof for this caller, installation, tool, arguments (as received), call id and, for a
   * later run, its deadline (`until`, epoch seconds). `at`: verify it as of that moment (a stored proof, checked
   * again when its run is due, at its confirmation time). Gives the proof's `iat` when it holds, else why not.
   */
  async checkConfirmation(
    proof: string,
    expected: { issuer: string; subject: string; installation: string; tool: string; args: unknown; call: string | null; until?: number },
    trust: RequestTrust,
    at?: Date,
  ): Promise<{ ok: true; iat: number } | { ok: false; why: string }> {
    const no = (why: string) => ({ ok: false as const, why })
    try {
      const { keys, audience } = this.#trustOf(expected.issuer, trust)
      const { payload } = await jwtVerify(proof, keys as Parameters<typeof jwtVerify>[1], { typ: CONFIRMATION_TYPE, issuer: expected.issuer, audience, clockTolerance: 30, ...(at ? { currentDate: at } : {}) })
      if (typeof payload.iat !== "number" || typeof payload.exp !== "number" || payload.exp - payload.iat > 300) return no("a proof lives 5 minutes at most")
      if (payload.sub !== expected.subject) return no("the proof is for someone else")
      if (payload.installation !== expected.installation) return no("the proof is for another installation")
      if (payload.tool !== expected.tool) return no("the proof is for another tool")
      if (payload.args !== argsHash(expected.args)) return no("the proof is for other arguments")
      if (!expected.call || payload.call !== expected.call) return no("the proof is for another call")
      if (expected.until !== undefined && payload.until !== expected.until) return no("the proof is for another deadline")
      return { ok: true, iat: payload.iat }
    } catch (error) {
      return no(error instanceof Error ? error.message : "invalid proof")
    }
  }
}

// ------------------------------------------------------------ signing (hosts, tests, dev)

/** A later run's deadline, epoch seconds: its `at` (a date-time string) plus `window` minutes, rounded down. NaN when `at` is not a date-time. */
export function laterDeadline(at: string, windowMinutes: number): number {
  return Math.floor(Date.parse(at) / 1000 + windowMinutes * 60)
}

export type SigningKey = { privateKey: CryptoKey; publicJwk: JWK; kid: string }

export async function generateSigningKey(): Promise<SigningKey> {
  const { privateKey, publicKey } = await generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true })
  const publicJwk = await exportJWK(publicKey)
  const kid = createHash("sha256").update(String(publicJwk.x)).digest("base64url").slice(0, 16)
  return { privateKey, publicJwk: { ...publicJwk, kid, alg: "EdDSA", use: "sig" }, kid }
}

/** An access token as a host or the dev authority signs it. */
export async function signAccessToken(key: SigningKey, claims: { iss: string; aud: string | string[]; sub: string; clegra: HostClaim; lifetimeSeconds?: number; scope?: string }): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  return new SignJWT({ [TOKEN_CLAIM]: claims.clegra, ...(claims.scope ? { scope: claims.scope } : {}) })
    .setProtectedHeader({ alg: "EdDSA", typ: ACCESS_TOKEN_TYPE, kid: key.kid })
    .setIssuer(claims.iss)
    .setAudience(claims.aud)
    .setSubject(claims.sub)
    .setIssuedAt(now)
    .setExpirationTime(now + (claims.lifetimeSeconds ?? 3600))
    .setJti(randomUUID())
    .sign(key.privateKey)
}

/**
 * A confirmation proof (spec §7): the person confirmed exactly these arguments, as sent, for this call of this
 * installation. `until` (epoch seconds), for an action with `later`: the run's deadline, `at` + `window` minutes
 * (`laterDeadline`).
 */
export async function signConfirmation(key: SigningKey, claims: { iss: string; aud: string; sub: string; installation: string; tool: string; args: unknown; call: string; until?: number; lifetimeSeconds?: number }): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  return new SignJWT({ installation: claims.installation, tool: claims.tool, args: argsHash(claims.args), call: claims.call, ...(claims.until !== undefined ? { until: claims.until } : {}) })
    .setProtectedHeader({ alg: "EdDSA", typ: CONFIRMATION_TYPE, kid: key.kid })
    .setIssuer(claims.iss)
    .setAudience(claims.aud)
    .setSubject(claims.sub)
    .setIssuedAt(now)
    .setExpirationTime(now + Math.min(claims.lifetimeSeconds ?? 120, 300))
    .sign(key.privateKey)
}

// ------------------------------------------------------------ the dev authority

const LOOPBACK = /^(127\.\d+\.\d+\.\d+|::1|::ffff:127\.\d+\.\d+\.\d+|localhost)$/

export function isLoopback(host: string | null | undefined): boolean {
  return typeof host === "string" && LOOPBACK.test(host)
}

const DEV_CODE_TYPE = `${PROTOCOL_ID}-dev-code+jwt`
const DEV_REFRESH_TYPE = `${PROTOCOL_ID}-dev-refresh+jwt`
/** Wrong sign-in codes before the dev sign-in closes until the app restarts. */
export const DEV_CODE_ATTEMPTS = 5

const html = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!)

// ------------------------------------------------------------ client id metadata documents

/**
 * A client may identify itself with the https URL of a JSON document that
 * describes it (OAuth Client ID Metadata Documents, what MCP clients use
 * since the 2025-11-25 authorization spec). The server fetches a URL that
 * whoever opens the sign-in page chose (through a tunnel that is anyone), so
 * the fetch must never reach this machine or its network: everything below
 * that refuses an address is there for that.
 */

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
  if (url.protocol !== "https:" || !/^https:\/\//i.test(clientId)) return "it must be an https URL"
  if (clientId.includes("#")) return "it must not have a fragment"
  const [authority = "", ...rest] = clientId.slice(8).split(/[?]/)[0]!.split("/")
  if (authority.includes("@") || url.username || url.password) return "it must not carry a user name or password"
  if (url.pathname === "/" || !rest.length) return "it needs a path (https://host/path), not only a host"
  if (rest.some((segment) => /^(\.|%2e){1,2}$/i.test(segment))) return "its path must not contain . or .. segments"
  return hostProblem(url.hostname)
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
    // Fetched like the document itself: https, a public host, no fragment, no user name.
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

const systemLookup = async (host: string) => (await dnsLookup(host, { all: true })).map((a) => a.address)

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

/** A JSON document at a checked https URL `address`, fetched only when every address of its host is public (see fetchClientMetadata). `what` names it in errors. */
async function fetchPublicJson(address: string, transport: ClientMetadataTransport, what: string): Promise<{ value: unknown; cacheSeconds: number }> {
  const host = new URL(address).hostname.replace(/^\[|\]$/g, "")
  if (!isIP(host)) {
    let addresses: string[]
    try {
      addresses = await (transport.lookup ?? systemLookup)(host)
    } catch {
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
  return Buffer.concat(chunks).toString("utf8")
}

/**
 * A minimal OAuth 2.1 authorization server for development (spec §7): clients
 * identify themselves with a Client ID Metadata Document URL (fetched and
 * checked, above) or register dynamically (any client); authorization code
 * with PKCE S256, a sign-in page listing test people that asks for the code
 * printed on the console (five wrong codes close the sign-in until the app
 * restarts), refresh tokens. Stateless but for a small cache of client
 * documents: codes and refresh tokens are JWTs signed with the dev key.
 * Every token's issuer is the origin the request came to (so a tunnel
 * works); the key is what is checked. The server answers it only to callers
 * on a loopback address (server.ts).
 */
export class DevAuthority {
  readonly code: string
  readonly people: (Person & { permissions?: string[] | "all" })[]
  readonly installation: string
  #key: SigningKey | null = null
  #wrongCodes = 0
  publicKey!: CryptoKey
  readonly #origins = new Set<string>([DEV_ISSUER])
  /** Client documents by client_id, oldest first; a failed fetch is kept too, briefly, so a broken client cannot make this server hammer a host. */
  readonly #clients = new Map<string, { until: number; result: Promise<ClientMetadata> }>()
  /** Key sets of private_key_jwt clients by jwks_uri, oldest first (a failure is kept briefly too). */
  readonly #keySets = new Map<string, { fetchedAt: number; until: number; result: Promise<{ keys: JWK[] }> }>()
  /** Client assertion ids already used, until their expiry (ms): an assertion is good for one request. */
  readonly #usedAssertions = new Map<string, number>()

  constructor(readonly options: DevOptions, private readonly app: { name: string; title: string; allPermissions: () => string[] }) {
    this.code = options.code ?? randomBytes(4).toString("hex").toUpperCase()
    this.people = options.people?.length ? options.people : [{ id: "test-person", name: "Test person", permissions: "all" }]
    this.installation = options.installation ?? "dev"
  }

  async start(): Promise<void> {
    const fromJwk = async (jwk: JWK) => {
      const privateKey = (await importJWK(jwk, "EdDSA")) as CryptoKey
      const { d: _d, ...pub } = jwk
      const kid = String(jwk.kid ?? createHash("sha256").update(String(jwk.x)).digest("base64url").slice(0, 16))
      return { privateKey, publicJwk: { ...pub, kid, alg: "EdDSA", use: "sig" }, kid }
    }
    const env = process.env.CLEGRA_DEV_KEY
    const file = this.options.keyFile === false ? null : (this.options.keyFile ?? `.${PROTOCOL_ID}-dev-key.json`)
    if (env) this.#key = await fromJwk(JSON.parse(env) as JWK)
    else if (!file) this.#key = await generateSigningKey()
    else {
      // Loaded only here, in development on Node: nothing else in the SDK touches the disk.
      const fs = await import("node:fs")
      if (fs.existsSync(file)) this.#key = await fromJwk(JSON.parse(fs.readFileSync(file, "utf8")) as JWK)
      else {
        this.#key = await generateSigningKey()
        const priv = await exportJWK(this.#key.privateKey)
        fs.writeFileSync(file, JSON.stringify({ ...priv, kid: this.#key.kid }), { mode: 0o600 })
      }
    }
    this.publicKey = (await importJWK(this.#key.publicJwk, "EdDSA")) as CryptoKey
  }

  get key(): SigningKey {
    if (!this.#key) throw new Error("dev authority not started")
    return this.#key
  }

  /** Whether `iss` is one of the dev authority's (its fixed name or an origin it answered on). */
  issues(iss: string): boolean {
    return this.#origins.has(iss)
  }

  permissionsOf(person: { permissions?: string[] | "all" } | undefined): string[] {
    const p = person?.permissions ?? "all"
    return p === "all" ? this.app.allPermissions() : p
  }

  /**
   * A dev access token. `person: null`: no person — with `host: "workspace"` the installation-level caller (the host
   * calling for the installation itself: schedules, later runs, lifecycle), `sub` = `installation:<installation>`,
   * no permissions unless given.
   */
  async token(input: { person?: string | Person | null; permissions?: string[] | "all"; host?: "workspace" | "plain"; installation?: string; locale?: string; audience: string; issuer?: string }): Promise<string> {
    const installation = input.installation ?? this.installation
    const known = typeof input.person === "string" ? this.people.find((p) => p.id === input.person) : undefined
    const person = input.person === null ? null : typeof input.person === "object" ? input.person : (known ?? this.people[0]!)
    const permissions = input.permissions ? (input.permissions === "all" ? this.app.allPermissions() : input.permissions) : person ? this.permissionsOf(known ?? this.people[0]) : []
    const iss = input.issuer ?? DEV_ISSUER
    this.#origins.add(iss)
    return signAccessToken(this.key, {
      // A workspace host's token is for one request.
      ...(input.host === "workspace" ? { lifetimeSeconds: HOST_TOKEN_SECONDS } : {}),
      iss,
      aud: input.audience,
      sub: person ? person.id : `installation:${installation}`,
      [TOKEN_CLAIM]: { installation, ...(person ? { person: { id: person.id, name: person.name } } : {}), permissions, ...(input.locale ? { locale: input.locale } : {}), host: input.host ?? "plain" },
    })
  }

  /** The checked metadata document of a URL `client_id`, from the cache or fetched. Throws ClientMetadataError. */
  #client(clientId: string): Promise<ClientMetadata> {
    const kept = this.#clients.get(clientId)
    if (kept && kept.until > Date.now()) return kept.result
    this.#clients.delete(clientId)
    // An address that is refused without a request costs nothing to refuse again: only what was fetched is kept.
    if (clientMetadataUrlProblem(clientId)) return fetchClientMetadata(clientId, this.options.clientMetadata).then((r) => r.metadata)
    while (this.#clients.size >= CLIENT_CACHE_ENTRIES) this.#clients.delete(this.#clients.keys().next().value!)
    const entry = { until: Date.now() + CLIENT_CACHE_FAILED_SECONDS * 1000, result: Promise.resolve(null as unknown as ClientMetadata) }
    entry.result = fetchClientMetadata(clientId, this.options.clientMetadata).then(({ metadata, cacheSeconds }) => {
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
    entry.result = fetchClientJwks(uri, this.options.clientMetadata).then(({ jwks, cacheSeconds }) => {
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
  async #authenticate(client: ClientMetadata, form: URLSearchParams, origin: string): Promise<string | null> {
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
    const options = { algorithms: [alg], issuer: client.client_id, subject: client.client_id, audience: [`${origin}/oauth/token`, origin], clockTolerance: CLIENT_ASSERTION_SKEW_SECONDS, requiredClaims: ["exp", "jti"] }
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

  /** Answers the authorization server's paths; null for any other path. */
  async handle(request: Request, origin: string, resource: string): Promise<Response | null> {
    const url = new URL(request.url)
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "access-control-allow-origin": "*", "cache-control": "no-store" } })
    const path = url.pathname
    if (path === "/.well-known/oauth-authorization-server" || path === "/.well-known/openid-configuration") {
      this.#origins.add(origin)
      return json({
        issuer: origin,
        authorization_endpoint: `${origin}/oauth/authorize`,
        token_endpoint: `${origin}/oauth/token`,
        registration_endpoint: `${origin}/oauth/register`,
        client_id_metadata_document_supported: true,
        jwks_uri: `${origin}/.well-known/jwks.json`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        // Public clients, and metadata-document clients that sign a client assertion with a key pair (RFC 7523).
        token_endpoint_auth_methods_supported: ["none", "private_key_jwt"],
        token_endpoint_auth_signing_alg_values_supported: [...CLIENT_ASSERTION_ALGS],
        scopes_supported: [OAUTH_SCOPE],
      })
    }
    if (path === "/.well-known/jwks.json") return json({ keys: [this.key.publicJwk] })
    if (path === "/oauth/register" && request.method === "POST") {
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
      return json({ ...body, client_id: `dev-${randomUUID()}`, client_id_issued_at: Math.floor(Date.now() / 1000), token_endpoint_auth_method: "none" }, 201)
    }
    if (path === "/oauth/authorize") return this.#authorize(request, url, origin, resource)
    if (path === "/oauth/token" && request.method === "POST") return this.#token(request, origin, resource, json)
    return null
  }

  async #authorize(request: Request, url: URL, origin: string, resource: string): Promise<Response> {
    const form = request.method === "POST" ? new URLSearchParams(await request.text()) : url.searchParams
    const p = (k: string) => form.get(k) ?? ""
    const shell = (body: string, status: number) =>
      new Response(
        `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign in · ${html(this.app.title)} (dev)</title>
<style>body{font:15px system-ui,sans-serif;max-width:420px;margin:48px auto;padding:0 16px;color:#1d1d1f}h1{font-size:20px}label{display:block;margin:12px 0 4px}select,input,button{font:inherit;padding:8px;width:100%;box-sizing:border-box}button{margin-top:16px;background:#1d1d1f;color:#fff;border:0;border-radius:8px}.e{color:#b00020}.n{color:#666;font-size:13px}.c{padding:10px 12px;border:1px solid #d2d2d7;border-radius:8px;overflow-wrap:anywhere}</style></head>
<body><h1>${html(this.app.title)} — development sign-in</h1>${body}</body></html>`,
        { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY" } },
      )
    let client: ClientMetadata | null = null
    // Who is asking, as its own metadata document says: shown so the developer sees which client the sign-in is for.
    const asking = () => {
      if (!client) return ""
      const host = html(new URL(client.client_id).host)
      const name = client.client_name ? `<strong>${html(client.client_name.slice(0, 80))}</strong> (${host})` : `<strong>${host}</strong>`
      return `<p class="c">${name} is asking to sign in.<br><span class="n">From the client's metadata document: ${html(client.client_id)}</span></p>`
    }
    const page = (error = "") =>
      shell(
        `<p class="n">Test people only. The code is printed on the app's console.</p>${asking()}${error ? `<p class="e">${html(error)}</p>` : ""}
<form method="post" action="/oauth/authorize">${["client_id", "redirect_uri", "state", "code_challenge", "code_challenge_method", "scope", "resource"].map((k) => `<input type="hidden" name="${k}" value="${html(p(k))}">`).join("")}
<label>Person</label><select name="person">${this.people.map((x) => `<option value="${html(x.id)}">${html(x.name)}</option>`).join("")}</select>
<label>Code</label><input name="code" autocomplete="off" required autofocus>
<button type="submit">Sign in</button></form>`,
        error ? 400 : 200,
      )
    // A client that is not who it says, or a redirect address that is not its own: the answer stays here, nothing is ever sent to that address.
    const refuse = (why: string) => shell(`<p class="e">This client cannot sign in: ${html(why)}.</p><p class="n">Nothing was sent to the client: its redirect address is not trusted.</p>`, 400)
    if (!p("redirect_uri") || !p("code_challenge") || p("code_challenge_method") !== "S256") return new Response("redirect_uri and a S256 code_challenge are required", { status: 400 })
    if (claimsUrl(p("client_id"))) {
      try {
        client = await this.#client(p("client_id"))
      } catch (error) {
        return refuse(error instanceof ClientMetadataError ? error.message : "its metadata document could not be read")
      }
      if (!redirectUriAllowed(p("redirect_uri"), client.redirect_uris)) return refuse("redirect_uri is not one of the redirect_uris of its metadata document (it must match exactly; only the port of a loopback address may differ)")
    }
    if (request.method !== "POST") return page()
    if (this.#wrongCodes >= DEV_CODE_ATTEMPTS) return page("Too many wrong codes: restart the app to sign in again.")
    if (p("code").trim().toUpperCase() !== this.code.toUpperCase()) {
      this.#wrongCodes++
      if (this.#wrongCodes >= DEV_CODE_ATTEMPTS) console.warn(`[${PROTOCOL_ID}] dev sign-in closed after ${DEV_CODE_ATTEMPTS} wrong codes: restart the app to open it again`)
      return page("Wrong code.")
    }
    const person = this.people.find((x) => x.id === p("person"))
    if (!person) return page("Unknown person.")
    this.#origins.add(origin)
    const code = await new SignJWT({ k: "code", person: person.id, challenge: p("code_challenge"), redirect: p("redirect_uri"), client: p("client_id") })
      .setProtectedHeader({ alg: "EdDSA", typ: DEV_CODE_TYPE, kid: this.key.kid })
      .setIssuer(origin)
      .setAudience(`${PROTOCOL_ID}-dev-code`)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(this.key.privateKey)
    const back = new URL(p("redirect_uri"))
    back.searchParams.set("code", code)
    if (p("state")) back.searchParams.set("state", p("state"))
    void resource
    return new Response(null, { status: 302, headers: { location: back.toString() } })
  }

  async #token(request: Request, origin: string, resource: string, json: (b: unknown, s?: number) => Response): Promise<Response> {
    const form = new URLSearchParams(await request.text())
    const fail = (error: string, description: string) => json({ error, error_description: description }, 400)
    let person: string
    let client = ""
    /** The redirect address a code was issued for (authorization_code only). */
    let redirect: string | null = null
    let sent = form.get("client_id") ?? ""
    // A client that authenticates with a signed JWT may leave client_id out (RFC 7523 §3): the assertion names it, and is checked below.
    if (!sent && form.get("client_assertion")) {
      try {
        const sub = decodeJwt(form.get("client_assertion")!).sub
        if (typeof sub === "string") sent = sub
      } catch {
        // Refused below, as an assertion that does not verify.
      }
    }
    if (form.get("grant_type") === "authorization_code") {
      let claims: JWTPayload
      try {
        ;({ payload: claims } = await jwtVerify(form.get("code") ?? "", this.publicKey, { typ: DEV_CODE_TYPE, audience: `${PROTOCOL_ID}-dev-code` }))
      } catch {
        return fail("invalid_grant", "unknown or expired code")
      }
      const verifier = form.get("code_verifier") ?? ""
      if (createHash("sha256").update(verifier).digest("base64url") !== claims.challenge) return fail("invalid_grant", "PKCE check failed")
      if (form.get("redirect_uri") && form.get("redirect_uri") !== claims.redirect) return fail("invalid_grant", "redirect_uri differs")
      // A code is for the client it was given to. A client known by its metadata document must say who it is; others may leave client_id out, as before.
      client = typeof claims.client === "string" ? claims.client : ""
      if (sent ? sent !== client : claimsUrl(client)) return fail("invalid_grant", sent ? "the code was issued to another client_id" : "client_id is required")
      person = String(claims.person)
      redirect = String(claims.redirect ?? "")
    } else if (form.get("grant_type") === "refresh_token") {
      try {
        const { payload } = await jwtVerify(form.get("refresh_token") ?? "", this.publicKey, { typ: DEV_REFRESH_TYPE, audience: `${PROTOCOL_ID}-dev-refresh` })
        person = String(payload.person)
        client = typeof payload.client === "string" ? payload.client : ""
      } catch {
        return fail("invalid_grant", "unknown or expired refresh token")
      }
      // A refresh token stays with the metadata-document client it was issued to.
      if (claimsUrl(client) && sent !== client) return fail("invalid_grant", "the refresh token was issued to another client_id")
    } else return fail("unsupported_grant_type", "authorization_code or refresh_token")
    if (claimsUrl(client)) {
      let metadata: ClientMetadata
      try {
        metadata = await this.#client(client)
      } catch (error) {
        return fail("invalid_client", error instanceof ClientMetadataError ? error.message : "the client's metadata document could not be read")
      }
      if (redirect !== null && !redirectUriAllowed(redirect, metadata.redirect_uris)) return fail("invalid_grant", "redirect_uri is no longer one of the client's redirect_uris")
      // A client with a key pair proves it is itself on every grant; a public client has nothing to prove.
      if (metadata.token_endpoint_auth_method === "private_key_jwt") {
        const why = await this.#authenticate(metadata, form, origin)
        if (why) return json({ error: "invalid_client", error_description: why }, 401)
      }
    }
    const who = this.people.find((x) => x.id === person)
    if (!who) return fail("invalid_grant", "unknown person")
    this.#origins.add(origin)
    const access = await this.token({ person: who.id, audience: resource, issuer: origin })
    const refresh = await new SignJWT({ person: who.id, ...(client ? { client } : {}) }).setProtectedHeader({ alg: "EdDSA", typ: DEV_REFRESH_TYPE, kid: this.key.kid }).setIssuer(origin).setAudience(`${PROTOCOL_ID}-dev-refresh`).setIssuedAt().setExpirationTime("30d").sign(this.key.privateKey)
    return json({ access_token: access, token_type: "Bearer", expires_in: 3600, refresh_token: refresh, scope: OAUTH_SCOPE })
  }
}
