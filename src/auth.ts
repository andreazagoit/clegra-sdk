import { createHash, randomBytes, randomUUID } from "node:crypto"
import { existsSync, readFileSync, writeFileSync } from "node:fs"

import {
  createLocalJWKSet,
  createRemoteJWKSet,
  decodeJwt,
  exportJWK,
  generateKeyPair,
  importJWK,
  jwtVerify,
  SignJWT,
  type CryptoKey,
  type JWK,
  type JWTPayload,
} from "jose"

import { CONFIRMATION_TYPE, OAUTH_SCOPE, PROTOCOL_ID, TOKEN_CLAIM } from "@modelapp/spec/protocol"

/**
 * AUTH (spec §7): access tokens are JWTs (`typ: at+jwt`) from a trusted
 * issuer (the workspace host, or the app's own authorization server),
 * verified with the issuer's JWKS. Their audience is this server's own
 * public MCP address (`auth.resource`, RFC 8707): a token signed for another
 * app is refused whatever that app calls itself. The `modelapp` claim says
 * who is calling for which installation; the tenant handlers see is the
 * installation of that issuer (`<installation>@<issuer>`), so one issuer
 * can never name another's. A workspace host's token is for one request
 * (60 seconds, used once). A workspace host proves a person's confirmation
 * with a second JWT (`modelapp-confirm+jwt`) bound to the installation, the
 * call and the arguments as sent.
 *
 * Dev mode: the SDK is its own authorization server with a local key
 * (DevAuthority below), for callers on a loopback address only.
 */

export { CONFIRMATION_TYPE }
export const DEV_ISSUER = `${PROTOCOL_ID}-dev`
/** The `typ` of an access token (RFC 9068). */
export const ACCESS_TOKEN_TYPE = "at+jwt"
/** How long a workspace host's access token may live: it is for one request. */
export const HOST_TOKEN_SECONDS = 60
const INSTALLATION = /^[A-Za-z0-9._:-]{1,128}$/

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
}

/** The `modelapp` claim of an access token. */
export type HostClaim = {
  installation: string
  person?: Person
  permissions?: string[]
  locale?: string
  host?: "workspace" | "plain"
}

export type Issuer = {
  /** The token's `iss`, exactly. */
  issuer: string
  /** Its key set; default `<issuer>/.well-known/jwks.json`. */
  jwksUri?: string
  /** Its keys given here instead (tests, a host on the same machine). */
  jwks?: { keys: JWK[] }
}

export type AuthOptions = {
  /** The issuers whose tokens are accepted. With issuers, `resource` is required. */
  issuers?: Issuer[]
  /**
   * This server's public MCP address, exactly as hosts and clients reach it
   * (`https://crm.example.com/mcp`): the only audience (`aud`) accepted from
   * the issuers, and what a host must have installed the app from.
   */
  resource?: string
  /** The authorization servers named in the protected-resource metadata (default: the issuers'). */
  authorizationServers?: string[]
  /**
   * Dev mode: a local signing key, a minimal authorization server for test
   * people, `app.devToken()`. Off unless set here; refused when NODE_ENV is
   * `production`; answers callers on a loopback address only.
   */
  dev?: boolean | DevOptions
  /** Serve calls without a token as this caller (local demos only). Off by default. */
  anonymous?: { installation: string; person?: Person; permissions: string[] | "all"; locale?: string }
}

export type DevOptions = {
  /** Test people offered on the sign-in page (default one, «Test person»). */
  people?: (Person & { permissions?: string[] | "all" })[]
  /** The installation dev tokens are for (default `dev`). */
  installation?: string
  /** Where the dev key is kept so tokens survive a restart (default `.modelapp-dev-key.json` in the working directory). */
  keyFile?: string
  /** The one-time code the sign-in page asks for (default: random, printed on start). */
  code?: string
}

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

type KeySet = ReturnType<typeof createRemoteJWKSet> | ReturnType<typeof createLocalJWKSet>

/** What one request allows: whether dev tokens are accepted (a loopback caller) and the address it came to. */
export type RequestTrust = { dev: boolean; requestResource: string | null }

export class TokenVerifier {
  readonly #issuers = new Map<string, KeySet>()
  readonly #resource: string | null
  readonly #once: (key: string, ttlMs: number) => Promise<boolean>
  #dev: DevAuthority | null = null

  constructor(options: AuthOptions, once: (key: string, ttlMs: number) => Promise<boolean>) {
    this.#once = once
    this.#resource = options.resource ?? null
    for (const i of options.issuers ?? []) {
      if (!i.issuer) throw new Error("auth.issuers: every issuer needs its `issuer`")
      const keys = i.jwks ? createLocalJWKSet(i.jwks) : createRemoteJWKSet(new URL(i.jwksUri ?? `${i.issuer.replace(/\/+$/, "")}/.well-known/jwks.json`), { cooldownDuration: 30_000, cacheMaxAge: 10 * 60_000 })
      this.#issuers.set(i.issuer, keys)
    }
    if (this.#issuers.size && !this.#resource) throw new Error("auth.resource: with issuers, give this server's public MCP address (https://…/mcp); it is the only audience their tokens are accepted for")
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

  /** The keys and the audiences of an issuer for this request; why not, as an AuthError. */
  #trustOf(iss: string | undefined, trust: RequestTrust): { keys: KeySet | CryptoKey; audience: string[]; issuer: string } {
    // A configured issuer always keeps its own keys: the dev authority's names come from request headers and must never shadow one.
    const configured = iss ? this.#issuers.get(iss) : undefined
    if (configured) return { keys: configured, audience: [this.#resource!], issuer: iss! }
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
      // A workspace host signs a token per request: short, with an id, used once.
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

  /** Checks a confirmation proof for this caller, installation, tool, arguments (as received) and call id. Returns why not, or null when it holds. */
  async checkConfirmation(proof: string, expected: { issuer: string; subject: string; installation: string; tool: string; args: unknown; call: string | null }, trust: RequestTrust): Promise<string | null> {
    try {
      const { keys, audience } = this.#trustOf(expected.issuer, trust)
      const { payload } = await jwtVerify(proof, keys as Parameters<typeof jwtVerify>[1], { typ: CONFIRMATION_TYPE, issuer: expected.issuer, audience, clockTolerance: 30 })
      if (typeof payload.iat !== "number" || typeof payload.exp !== "number" || payload.exp - payload.iat > 300) return "a proof lives 5 minutes at most"
      if (payload.sub !== expected.subject) return "the proof is for someone else"
      if (payload.installation !== expected.installation) return "the proof is for another installation"
      if (payload.tool !== expected.tool) return "the proof is for another tool"
      if (payload.args !== argsHash(expected.args)) return "the proof is for other arguments"
      if (!expected.call || payload.call !== expected.call) return "the proof is for another call"
      return null
    } catch (error) {
      return error instanceof Error ? error.message : "invalid proof"
    }
  }
}

// ------------------------------------------------------------ signing (hosts, tests, dev)

export type SigningKey = { privateKey: CryptoKey; publicJwk: JWK; kid: string }

export async function generateSigningKey(): Promise<SigningKey> {
  const { privateKey, publicKey } = await generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true })
  const publicJwk = await exportJWK(publicKey)
  const kid = createHash("sha256").update(String(publicJwk.x)).digest("base64url").slice(0, 16)
  return { privateKey, publicJwk: { ...publicJwk, kid, alg: "EdDSA", use: "sig" }, kid }
}

/** An access token as a host or the dev authority signs it. */
export async function signAccessToken(key: SigningKey, claims: { iss: string; aud: string | string[]; sub: string; modelapp: HostClaim; lifetimeSeconds?: number; scope?: string }): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  return new SignJWT({ [TOKEN_CLAIM]: claims.modelapp, ...(claims.scope ? { scope: claims.scope } : {}) })
    .setProtectedHeader({ alg: "EdDSA", typ: ACCESS_TOKEN_TYPE, kid: key.kid })
    .setIssuer(claims.iss)
    .setAudience(claims.aud)
    .setSubject(claims.sub)
    .setIssuedAt(now)
    .setExpirationTime(now + (claims.lifetimeSeconds ?? 3600))
    .setJti(randomUUID())
    .sign(key.privateKey)
}

/** A confirmation proof (spec §7): the person confirmed exactly these arguments, as sent, for this call of this installation. */
export async function signConfirmation(key: SigningKey, claims: { iss: string; aud: string; sub: string; installation: string; tool: string; args: unknown; call: string; lifetimeSeconds?: number }): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  return new SignJWT({ installation: claims.installation, tool: claims.tool, args: argsHash(claims.args), call: claims.call })
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

/**
 * A minimal OAuth 2.1 authorization server for development (spec §7): dynamic
 * client registration (any client), authorization code with PKCE S256, a
 * sign-in page listing test people that asks for the code printed on the
 * console (five wrong codes close the sign-in until the app restarts),
 * refresh tokens. Stateless: codes and refresh tokens are JWTs signed with
 * the dev key. Every token's issuer is the origin the request came to (so a
 * tunnel works); the key is what is checked. The server answers it only to
 * callers on a loopback address (server.ts).
 */
export class DevAuthority {
  readonly code: string
  readonly people: (Person & { permissions?: string[] | "all" })[]
  readonly installation: string
  #key: SigningKey | null = null
  #wrongCodes = 0
  publicKey!: CryptoKey
  readonly #origins = new Set<string>([DEV_ISSUER])

  constructor(readonly options: DevOptions, private readonly app: { name: string; title: string; allPermissions: () => string[] }) {
    this.code = options.code ?? randomBytes(4).toString("hex").toUpperCase()
    this.people = options.people?.length ? options.people : [{ id: "test-person", name: "Test person", permissions: "all" }]
    this.installation = options.installation ?? "dev"
  }

  async start(): Promise<void> {
    const file = this.options.keyFile ?? `.${PROTOCOL_ID}-dev-key.json`
    if (existsSync(file)) {
      const jwk = JSON.parse(readFileSync(file, "utf8")) as JWK
      const privateKey = (await importJWK(jwk, "EdDSA")) as CryptoKey
      const { d: _d, ...pub } = jwk
      this.#key = { privateKey, publicJwk: { ...pub, alg: "EdDSA", use: "sig" }, kid: String(jwk.kid) }
    } else {
      this.#key = await generateSigningKey()
      const priv = await exportJWK(this.#key.privateKey)
      writeFileSync(file, JSON.stringify({ ...priv, kid: this.#key.kid }), { mode: 0o600 })
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

  async token(input: { person?: string | Person; permissions?: string[] | "all"; host?: "workspace" | "plain"; installation?: string; locale?: string; audience: string; issuer?: string }): Promise<string> {
    const known = typeof input.person === "string" ? this.people.find((p) => p.id === input.person) : undefined
    const person = typeof input.person === "object" ? input.person : known ?? this.people[0]!
    const permissions = input.permissions ? (input.permissions === "all" ? this.app.allPermissions() : input.permissions) : this.permissionsOf(known ?? this.people[0])
    const iss = input.issuer ?? DEV_ISSUER
    this.#origins.add(iss)
    return signAccessToken(this.key, {
      // A workspace host's token is for one request.
      ...(input.host === "workspace" ? { lifetimeSeconds: HOST_TOKEN_SECONDS } : {}),
      iss,
      aud: input.audience,
      sub: person.id,
      [TOKEN_CLAIM]: { installation: input.installation ?? this.installation, person: { id: person.id, name: person.name }, permissions, ...(input.locale ? { locale: input.locale } : {}), host: input.host ?? "plain" },
    })
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
        jwks_uri: `${origin}/.well-known/jwks.json`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
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
    const page = (error = "") =>
      new Response(
        `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign in · ${html(this.app.title)} (dev)</title>
<style>body{font:15px system-ui,sans-serif;max-width:420px;margin:48px auto;padding:0 16px;color:#1d1d1f}h1{font-size:20px}label{display:block;margin:12px 0 4px}select,input,button{font:inherit;padding:8px;width:100%;box-sizing:border-box}button{margin-top:16px;background:#1d1d1f;color:#fff;border:0;border-radius:8px}.e{color:#b00020}.n{color:#666;font-size:13px}</style></head>
<body><h1>${html(this.app.title)} — development sign-in</h1><p class="n">Test people only. The code is printed on the app's console.</p>${error ? `<p class="e">${html(error)}</p>` : ""}
<form method="post" action="/oauth/authorize">${["client_id", "redirect_uri", "state", "code_challenge", "code_challenge_method", "scope", "resource"].map((k) => `<input type="hidden" name="${k}" value="${html(p(k))}">`).join("")}
<label>Person</label><select name="person">${this.people.map((x) => `<option value="${html(x.id)}">${html(x.name)}</option>`).join("")}</select>
<label>Code</label><input name="code" autocomplete="off" required autofocus>
<button type="submit">Sign in</button></form></body></html>`,
        { status: error ? 400 : 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY" } },
      )
    if (!p("redirect_uri") || !p("code_challenge") || p("code_challenge_method") !== "S256") return new Response("redirect_uri and a S256 code_challenge are required", { status: 400 })
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
      person = String(claims.person)
    } else if (form.get("grant_type") === "refresh_token") {
      try {
        const { payload } = await jwtVerify(form.get("refresh_token") ?? "", this.publicKey, { typ: DEV_REFRESH_TYPE, audience: `${PROTOCOL_ID}-dev-refresh` })
        person = String(payload.person)
      } catch {
        return fail("invalid_grant", "unknown or expired refresh token")
      }
    } else return fail("unsupported_grant_type", "authorization_code or refresh_token")
    const who = this.people.find((x) => x.id === person)
    if (!who) return fail("invalid_grant", "unknown person")
    this.#origins.add(origin)
    const access = await this.token({ person: who.id, audience: resource, issuer: origin })
    const refresh = await new SignJWT({ person: who.id }).setProtectedHeader({ alg: "EdDSA", typ: DEV_REFRESH_TYPE, kid: this.key.kid }).setIssuer(origin).setAudience(`${PROTOCOL_ID}-dev-refresh`).setIssuedAt().setExpirationTime("30d").sign(this.key.privateKey)
    return json({ access_token: access, token_type: "Bearer", expires_in: 3600, refresh_token: refresh, scope: OAUTH_SCOPE })
  }
}
