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

/**
 * AUTH (spec §9, §10): access tokens are JWTs from a trusted issuer (the
 * workspace host, or the app's own authorization server), verified with the
 * issuer's JWKS; the `mcpw` claim says who is calling for which
 * installation. A workspace host proves a person's confirmation with a
 * second JWT (`mcpw-confirm+jwt`) bound to the call and its exact arguments.
 *
 * Dev mode: the SDK is its own authorization server with a local key
 * (DevAuthority below), on a loopback address only.
 */

export const CONFIRMATION_TYPE = "mcpw-confirm+jwt"
export const DEV_ISSUER = "mcpw-dev"

export type Person = { id: string; name: string }

/** Who is calling, as every handler sees it (`ctx`). */
export type Caller = {
  installation: string
  person: Person | null
  permissions: ReadonlySet<string>
  locale?: string
  /** `workspace`: a host that confirms writes itself and sends proofs; `plain`: any other MCP host. */
  host: "workspace" | "plain"
  issuer: string
  subject: string
}

/** The `mcpw` claim of an access token. */
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
  /** The issuers whose tokens are accepted. */
  issuers?: Issuer[]
  /** The MCP resource URL this server is known by (also accepted as `aud`). */
  resource?: string
  /** The authorization servers named in the protected-resource metadata (default: the issuers'). */
  authorizationServers?: string[]
  /**
   * Dev mode (spec §9): a local signing key, a minimal authorization server
   * for test people, `app.devToken()`. Only while listening on loopback.
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
  /** Where the dev key is kept so tokens survive a restart (default `.mcpw-dev-key.json` in the working directory). */
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

export class TokenVerifier {
  readonly #issuers = new Map<string, KeySet>()
  readonly #audiences: () => string[]
  #dev: DevAuthority | null = null

  constructor(options: AuthOptions, audiences: () => string[]) {
    this.#audiences = audiences
    for (const i of options.issuers ?? []) {
      if (!i.issuer) throw new Error("auth.issuers: every issuer needs its `issuer`")
      const keys = i.jwks ? createLocalJWKSet(i.jwks) : createRemoteJWKSet(new URL(i.jwksUri ?? `${i.issuer.replace(/\/+$/, "")}/.well-known/jwks.json`), { cooldownDuration: 30_000, cacheMaxAge: 10 * 60_000 })
      this.#issuers.set(i.issuer, keys)
    }
  }

  useDev(dev: DevAuthority) {
    this.#dev = dev
  }

  #keysFor(iss: string | undefined): KeySet | CryptoKey | null {
    if (this.#dev && iss && this.#dev.issues(iss)) return this.#dev.publicKey
    return (iss && this.#issuers.get(iss)) || null
  }

  /** The caller an access token names. Throws AuthError with the reason. */
  async verify(token: string): Promise<Caller & { claims: JWTPayload }> {
    let iss: string | undefined
    try {
      iss = decodeJwt(token).iss
    } catch {
      throw new AuthError("malformed token")
    }
    const keys = this.#keysFor(iss)
    if (!keys) throw new AuthError(`untrusted issuer ${iss ?? "(none)"}`)
    let payload: JWTPayload
    try {
      ;({ payload } = await jwtVerify(token, keys as Parameters<typeof jwtVerify>[1], { audience: this.#audiences(), clockTolerance: 30 }))
    } catch (error) {
      throw new AuthError(error instanceof Error ? error.message : "invalid token")
    }
    const m = payload.mcpw as HostClaim | undefined
    if (!m || typeof m.installation !== "string" || !m.installation) throw new AuthError("the token has no mcpw.installation")
    return {
      installation: m.installation,
      person: m.person && typeof m.person.id === "string" ? { id: m.person.id, name: String(m.person.name ?? "") } : null,
      permissions: new Set(Array.isArray(m.permissions) ? m.permissions.filter((p) => typeof p === "string") : []),
      ...(typeof m.locale === "string" ? { locale: m.locale } : {}),
      host: m.host === "workspace" ? "workspace" : "plain",
      issuer: iss!,
      subject: String(payload.sub ?? ""),
      claims: payload,
    }
  }

  /** Checks a confirmation proof for this caller, tool, arguments and call id. Returns why not, or null when it holds. */
  async checkConfirmation(proof: string, expected: { issuer: string; subject: string; tool: string; args: unknown; call: string | null }): Promise<string | null> {
    const keys = this.#keysFor(expected.issuer)
    if (!keys) return "untrusted issuer"
    try {
      const { payload } = await jwtVerify(proof, keys as Parameters<typeof jwtVerify>[1], { typ: CONFIRMATION_TYPE, issuer: expected.issuer, audience: this.#audiences(), clockTolerance: 30 })
      if (typeof payload.iat !== "number" || typeof payload.exp !== "number" || payload.exp - payload.iat > 300) return "a proof lives 5 minutes at most"
      if (payload.sub !== expected.subject) return "the proof is for someone else"
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
export async function signAccessToken(key: SigningKey, claims: { iss: string; aud: string | string[]; sub: string; mcpw: HostClaim; lifetimeSeconds?: number; scope?: string }): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  return new SignJWT({ mcpw: claims.mcpw, ...(claims.scope ? { scope: claims.scope } : {}) })
    .setProtectedHeader({ alg: "EdDSA", typ: "at+jwt", kid: key.kid })
    .setIssuer(claims.iss)
    .setAudience(claims.aud)
    .setSubject(claims.sub)
    .setIssuedAt(now)
    .setExpirationTime(now + (claims.lifetimeSeconds ?? 3600))
    .setJti(randomUUID())
    .sign(key.privateKey)
}

/** A confirmation proof (spec §10): the person confirmed exactly these arguments for this call. */
export async function signConfirmation(key: SigningKey, claims: { iss: string; aud: string; sub: string; tool: string; args: unknown; call: string; lifetimeSeconds?: number }): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  return new SignJWT({ tool: claims.tool, args: argsHash(claims.args), call: claims.call })
    .setProtectedHeader({ alg: "EdDSA", typ: CONFIRMATION_TYPE, kid: key.kid })
    .setIssuer(claims.iss)
    .setAudience(claims.aud)
    .setSubject(claims.sub)
    .setIssuedAt(now)
    .setExpirationTime(now + Math.min(claims.lifetimeSeconds ?? 120, 300))
    .sign(key.privateKey)
}

// ------------------------------------------------------------ the dev authority

const LOOPBACK = /^(127\.\d+\.\d+\.\d+|::1|localhost)$/

export function isLoopback(host: string): boolean {
  return LOOPBACK.test(host)
}

const html = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!)

/**
 * A minimal OAuth 2.1 authorization server for development (spec §9): dynamic
 * client registration (any client), authorization code with PKCE S256, a
 * sign-in page listing test people that asks for the one-time code printed
 * on the console, refresh tokens. Stateless: codes and refresh tokens are
 * JWTs signed with the dev key. Every token's issuer is the origin the
 * request came to (so a tunnel works); the key is what is checked.
 */
export class DevAuthority {
  readonly code: string
  readonly people: (Person & { permissions?: string[] | "all" })[]
  readonly installation: string
  #key: SigningKey | null = null
  publicKey!: CryptoKey
  readonly #origins = new Set<string>([DEV_ISSUER])

  constructor(readonly options: DevOptions, private readonly app: { name: string; title: string; allPermissions: () => string[] }) {
    this.code = options.code ?? randomBytes(4).toString("hex").toUpperCase()
    this.people = options.people?.length ? options.people : [{ id: "test-person", name: "Test person", permissions: "all" }]
    this.installation = options.installation ?? "dev"
  }

  async start(): Promise<void> {
    const file = this.options.keyFile ?? ".mcpw-dev-key.json"
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
      iss,
      aud: input.audience,
      sub: person.id,
      mcpw: { installation: input.installation ?? this.installation, person: { id: person.id, name: person.name }, permissions, ...(input.locale ? { locale: input.locale } : {}), host: input.host ?? "plain" },
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
        scopes_supported: ["mcpw"],
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
    if (p("code").trim().toUpperCase() !== this.code) return page("Wrong code.")
    const person = this.people.find((x) => x.id === p("person"))
    if (!person) return page("Unknown person.")
    this.#origins.add(origin)
    const code = await new SignJWT({ k: "code", person: person.id, challenge: p("code_challenge"), redirect: p("redirect_uri"), client: p("client_id") })
      .setProtectedHeader({ alg: "EdDSA", kid: this.key.kid })
      .setIssuer(origin)
      .setAudience("mcpw-dev-code")
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
        ;({ payload: claims } = await jwtVerify(form.get("code") ?? "", this.publicKey, { audience: "mcpw-dev-code" }))
      } catch {
        return fail("invalid_grant", "unknown or expired code")
      }
      const verifier = form.get("code_verifier") ?? ""
      if (createHash("sha256").update(verifier).digest("base64url") !== claims.challenge) return fail("invalid_grant", "PKCE check failed")
      if (form.get("redirect_uri") && form.get("redirect_uri") !== claims.redirect) return fail("invalid_grant", "redirect_uri differs")
      person = String(claims.person)
    } else if (form.get("grant_type") === "refresh_token") {
      try {
        const { payload } = await jwtVerify(form.get("refresh_token") ?? "", this.publicKey, { audience: "mcpw-dev-refresh" })
        person = String(payload.person)
      } catch {
        return fail("invalid_grant", "unknown or expired refresh token")
      }
    } else return fail("unsupported_grant_type", "authorization_code or refresh_token")
    const who = this.people.find((x) => x.id === person)
    if (!who) return fail("invalid_grant", "unknown person")
    this.#origins.add(origin)
    const access = await this.token({ person: who.id, audience: resource, issuer: origin })
    const refresh = await new SignJWT({ person: who.id }).setProtectedHeader({ alg: "EdDSA", kid: this.key.kid }).setIssuer(origin).setAudience("mcpw-dev-refresh").setIssuedAt().setExpirationTime("30d").sign(this.key.privateKey)
    return json({ access_token: access, token_type: "Bearer", expires_in: 3600, refresh_token: refresh, scope: "mcpw" })
  }
}
