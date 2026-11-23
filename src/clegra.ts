import { createHash, randomBytes } from "node:crypto"

import { calculateJwkThumbprint, createLocalJWKSet, decodeProtectedHeader, EmbeddedJWK, jwtVerify, type JWK, type JWTPayload } from "jose"

import { APP_TOKEN_TYPE, CONFIRMATION_PROOF_TYPE, CONFIRMATION_TOKEN_TYPE, CORE_APP_KEY_USE, CORE_KEYS_PATH, EVENT_KINDS, EVENT_TYPE } from "../spec/src/protocol"
import { argsHash, AuthError } from "./auth"
import type { IdempotencyStore } from "./store"

/**
 * CLEGRA TOKENS (spec §7, «Clegra tokens»): the app side of Clegra's apps-first model. Clegra's core is the one
 * trusted issuer. It mints, for exactly this app (`aud` = the app's resource):
 *
 * - **app tokens** (`typ` `clegra-app+jwt`, ≤ 10 minutes) for a person using the app from a Clegra client, bound to
 *   the device's key (`cnf.jkt`, DPoP);
 * - **delegated** and **automation run** tokens (≤ 60 seconds, used once) for Clegra's agent acting for the person
 *   (`act: { sub: "server:<id>" }`, `cnf.jkt` the server's key), and **device-agent** tokens
 *   (`act: { sub: "device-agent:<jkt>" }`) for an agent on the person's Mac;
 * - **confirmation tokens** (`typ` `clegra-confirmation+jwt`) for a sensitive tool an agent calls, with a proof
 *   signed by the person's device key;
 * - **events** (`typ` `clegra-event+jwt`) posted to the app's events endpoint.
 *
 * Everything is signed with the core's keys of `use: "app"` (`<issuer>/.well-known/clegra-keys.json`). The tenant is
 * `<company>@<issuer>`, from the token only, never from a request parameter. Nothing here assumes the client and the
 * app share an origin: every browser call is cross-origin (CORS below), and a client frames MCP Apps views from the
 * app's own origin (src/views.ts).
 */

/** A Clegra company role, as the core's token says it. */
export type CompanyRole = "admin" | "member"

/** Who acts for the person, when it is not the person: Clegra's agent on a server, or an agent on the person's device. */
export type Actor = { kind: "server"; id: string } | { kind: "device-agent"; id: string }

/** An event the core sends (spec §7, «Events»). */
export type ClegraEventKind = (typeof EVENT_KINDS)[number]
export type ClegraEvent = {
  /** The event's id (its `jti`): a retry carries the same one. */
  id: string
  kind: ClegraEventKind
  /** When it happened (ISO). */
  at: string
  /** The company's id, as the core names it. */
  company: string
  /** The tenant inside the app: `<company>@<issuer>`. */
  tenant: string
  /** The person's pairwise `sub` (member.removed). */
  sub?: string
  /** The core's installation id (app.installed, app.uninstalled). */
  installation?: string
}

/** What the app does on an event, beside what the SDK does itself (roles dropped, tokens refused). */
export type ClegraEventHandler = (event: ClegraEvent) => Promise<void> | void

export type ClegraOptions = {
  /** The core's issuer (the tokens' `iss`), exactly: `https://core.clegra.com`. */
  issuer: string
  /** The core's key set (default `<issuer>/.well-known/clegra-keys.json`). Only keys with `use: "app"` count. */
  jwksUri?: string
  /** The core's keys given here instead of fetched (tests, a core on the same machine). Only `use: "app"` keys count. */
  jwks?: { keys: JWK[] }
  /** How the key set is fetched (tests; default the global `fetch`). */
  fetch?: typeof fetch
  /** The registration id the core gave this app. Required in production. */
  registrationId?: string
  /** The registration challenge the core gave, served at `/.well-known/clegra-app.json` while the core verifies the app's URL. */
  challenge?: string
  /**
   * The companies (the core's company ids) whose people may use this app: a private app's own list, or `"any"` for
   * a public app. Required in production: an app without it refuses every Clegra token.
   */
  allowedCompanies?: readonly string[] | "any"
  /** The Clegra clients' origins that call the app from a browser, exactly (`https://app.clegra.com`): the CORS allow-list. */
  clientOrigins?: readonly string[]
  /** What a company administrator is inside the app: `"admin"` (every permission; the default) or `"member"` (only what is granted). */
  companyAdmin?: CompanyRole
  /** The app's own reactions to the core's events (after the SDK's: roles dropped, older tokens refused). */
  events?: Partial<Record<ClegraEventKind, ClegraEventHandler>>
}

/**
 * Clegra options from the environment, or null when `CLEGRA_ISSUER` is not set:
 * `CLEGRA_ISSUER`, `CLEGRA_REGISTRATION_ID`, `CLEGRA_REGISTRATION_CHALLENGE`,
 * `CLEGRA_ALLOWED_COMPANIES` (`any`, or company ids separated by commas), `CLEGRA_CLIENT_ORIGINS` (origins separated by commas).
 */
export function clegraFromEnv(env: Record<string, string | undefined> = process.env): ClegraOptions | null {
  const issuer = env.CLEGRA_ISSUER?.trim()
  if (!issuer) return null
  const list = (value: string | undefined) => (value ?? "").split(",").map((s) => s.trim()).filter(Boolean)
  const allowed = env.CLEGRA_ALLOWED_COMPANIES?.trim()
  return {
    issuer,
    ...(env.CLEGRA_REGISTRATION_ID?.trim() ? { registrationId: env.CLEGRA_REGISTRATION_ID.trim() } : {}),
    ...(env.CLEGRA_REGISTRATION_CHALLENGE?.trim() ? { challenge: env.CLEGRA_REGISTRATION_CHALLENGE.trim() } : {}),
    ...(allowed ? { allowedCompanies: allowed === "any" ? ("any" as const) : list(allowed) } : {}),
    ...(list(env.CLEGRA_CLIENT_ORIGINS).length ? { clientOrigins: list(env.CLEGRA_CLIENT_ORIGINS) } : {}),
  }
}

/** The verified Clegra side of a caller: who, for which company, from which device, through whom. */
export type ClegraCaller = {
  company: string
  companyRole: CompanyRole
  email: string | null
  /** The key the call's DPoP proof is signed with (`cnf.jkt`). */
  jkt: string
  /** Who acts for the person (delegated, automation, device agent); null when the person calls from a client. */
  actor: Actor | null
  /** The person's device key (`person_jkt`), on a delegated token. */
  personJkt: string | null
  /** The automation grant a run token is for, and the tools it may call. */
  grant: { id: string; tools: string[] | null } | null
  tokenId: string
  issuedAt: number
  /** An administrator inside the app: a company administrator (unless `companyAdmin: "member"`), or granted it by one. */
  admin: boolean
}

export const DPOP_TYPE = "dpop+jwt"
/** How far a proof's `iat` may be from now without a nonce; the window a DPoP `jti` is remembered. */
export const DPOP_SKEW_SECONDS = 60
/** How long a nonce this app gave stays good. */
export const DPOP_NONCE_SECONDS = 300
export const APP_TOKEN_MAX_SECONDS = 600
export const DELEGATED_TOKEN_MAX_SECONDS = 60
export const CONFIRMATION_MAX_SECONDS = 600
export const EVENT_MAX_SECONDS = 300
/** An unknown `kid` fetches the key set again, at most this often; it is refreshed this often anyway. */
export const KEYS_REFETCH_MS = 60_000
export const KEYS_MAX_AGE_MS = 10 * 60_000
/** How long a removal, an unassignment or a suspension is remembered: longer than any token or site session it must outlive. */
export const REVOCATION_MS = 3_700_000
const ALGS = ["EdDSA", "ES256"]
const SKEW = 30
const COMPANY = /^[A-Za-z0-9._:-]{1,128}$/

const sha256 = (value: string) => createHash("sha256").update(value).digest("base64url")

/** A DPoP failure: `nonce` set when the client should retry with it (`use_dpop_nonce`). */
export class DpopError extends AuthError {
  constructor(
    message: string,
    readonly nonce: string | null = null,
  ) {
    super(message)
    this.name = "DpopError"
  }
}

/** The core's `use: "app"` keys, fetched once and kept; an unknown `kid` fetches them again at most once a minute. */
class CoreKeys {
  #set: ReturnType<typeof createLocalJWKSet> | null = null
  #fetchedAt = 0
  #pending: Promise<void> | null = null

  constructor(
    private readonly uri: string,
    private readonly inline: { keys: JWK[] } | undefined,
    private readonly fetcher: typeof fetch,
  ) {}

  static appKeys(set: { keys?: unknown }): { keys: JWK[] } {
    const keys = Array.isArray(set.keys) ? (set.keys as JWK[]) : []
    // jose takes only `use: "sig"` (or none): the core's app keys are re-labelled once they are chosen by their `use`.
    return { keys: keys.filter((k) => k && k.use === CORE_APP_KEY_USE && typeof k.kid === "string").map(({ use: _use, ...k }) => k) }
  }

  async #load(): Promise<void> {
    if (this.inline) {
      this.#set = createLocalJWKSet(CoreKeys.appKeys(this.inline))
      this.#fetchedAt = Date.now()
      return
    }
    this.#pending ??= (async () => {
      try {
        const response = await this.fetcher(this.uri, { headers: { accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(5000) })
        if (response.status !== 200) throw new AuthError(`the core's keys answered ${response.status} (${this.uri})`)
        this.#set = createLocalJWKSet(CoreKeys.appKeys((await response.json()) as { keys?: unknown }))
        this.#fetchedAt = Date.now()
      } catch (error) {
        this.#fetchedAt = Date.now()
        if (error instanceof AuthError) throw error
        throw new AuthError(`the core's keys could not be fetched (${this.uri})`)
      } finally {
        this.#pending = null
      }
    })()
    return this.#pending
  }

  /** Verifies a JWT with the core's app keys: the set is fetched when missing or old, and again on an unknown `kid` (once a minute at most). */
  async verify(token: string, options: Parameters<typeof jwtVerify>[2]): Promise<JWTPayload> {
    if (!this.#set || Date.now() - this.#fetchedAt > KEYS_MAX_AGE_MS) await this.#load()
    try {
      return (await jwtVerify(token, this.#set!, options)).payload
    } catch (error) {
      if ((error as { code?: string }).code !== "ERR_JWKS_NO_MATCHING_KEY" || Date.now() - this.#fetchedAt < KEYS_REFETCH_MS) throw error
      await this.#load()
      return (await jwtVerify(token, this.#set!, options)).payload
    }
  }
}

const why = (error: unknown, what: string): string => {
  const code = (error as { code?: string }).code
  if (error instanceof AuthError) return error.message
  if (code === "ERR_JWT_EXPIRED") return `the ${what} has expired`
  if (code === "ERR_JWKS_NO_MATCHING_KEY") return `the ${what} is signed by a key the core does not publish for apps`
  if (code === "ERR_JWT_CLAIM_VALIDATION_FAILED") {
    const claim = (error as { claim?: string }).claim
    if (claim === "iss") return `the ${what} is from another issuer`
    if (claim === "typ") return `the ${what} has the wrong typ`
    return `the ${what}'s ${claim ?? "claims"} are not valid`
  }
  if (code === "ERR_JWS_SIGNATURE_VERIFICATION_FAILED") return `the ${what}'s signature does not verify`
  return `the ${what} is not valid`
}

/**
 * A client origin as a browser states it in `Origin`: `https://host[:port]` (http on a development host) serialized
 * exactly, or the desktop app's own scheme (`app://client`: a standard scheme of Electron's, whose origin Node's URL
 * can't serialize), lower case, nothing after the host.
 */
export function isClientOrigin(origin: string): boolean {
  if (/^https?:\/\//.test(origin)) return URL.canParse(origin) && new URL(origin).origin === origin
  return /^[a-z][a-z0-9+.-]*:\/\/[a-z0-9.-]+(:\d{1,5})?$/.test(origin)
}

/** The tenant of a Clegra company inside the app: the company bound to the core that names it. */
export const clegraTenant = (company: string, issuer: string) => `${company}@${issuer}`

/** What every check of one app shares: its configuration, the core's keys and the store (replay, nonces, revocations). */
export class ClegraAuthority {
  readonly issuer: string
  readonly #keys: CoreKeys

  constructor(
    readonly options: ClegraOptions,
    readonly resource: string,
    private readonly store: IdempotencyStore,
  ) {
    if (!options.issuer || !URL.canParse(options.issuer)) throw new Error(`auth.clegra.issuer: "${options.issuer}" is not a URL (the core's issuer, https://core.clegra.com)`)
    this.issuer = options.issuer
    const allowed = options.allowedCompanies
    if (allowed !== undefined && allowed !== "any" && (!Array.isArray(allowed) || !allowed.every((c) => typeof c === "string" && COMPANY.test(c)))) throw new Error('auth.clegra.allowedCompanies: "any", or a list of company ids')
    for (const origin of options.clientOrigins ?? []) if (!isClientOrigin(origin)) throw new Error(`auth.clegra.clientOrigins: "${origin}" is not an origin (scheme://host[:port], nothing after)`)
    if (options.companyAdmin !== undefined && options.companyAdmin !== "admin" && options.companyAdmin !== "member") throw new Error('auth.clegra.companyAdmin: "admin" or "member"')
    this.#keys = new CoreKeys(options.jwksUri ?? `${options.issuer.replace(/\/+$/, "")}${CORE_KEYS_PATH}`, options.jwks, options.fetch ?? fetch)
  }

  /** Why this configuration may not serve in production, or null. */
  productionProblem(): string | null {
    if (!this.options.registrationId) return "auth.clegra.registrationId is required in production (CLEGRA_REGISTRATION_ID): the id the core gave this app when it was registered"
    if (this.options.allowedCompanies === undefined) return 'auth.clegra.allowedCompanies is required in production (CLEGRA_ALLOWED_COMPANIES): the companies that may use this app, or "any" for a public app'
    return null
  }

  /** Whether a token is one of the core's: a JWT whose `iss` is the core. */
  issues(token: string): boolean {
    try {
      const [, body] = token.split(".")
      return (JSON.parse(Buffer.from(body ?? "", "base64url").toString("utf8")) as { iss?: unknown }).iss === this.issuer
    } catch {
      return false
    }
  }

  // ------------------------------------------------------------ revocations

  #revokedKey = (tenant: string, sub: string) => `clegra:revoked:${tenant}:${sub}`
  #closedKey = (tenant: string) => `clegra:closed:${tenant}`

  /**
   * Refuse whatever was issued to this person in this tenant until `at` (member.removed): the event's own time, so an
   * event that arrives late (the core's outbox retries) never refuses what the core issued after it. Never moved back.
   */
  async revokePerson(tenant: string, sub: string, at: Date = new Date()): Promise<void> {
    await this.#raise(this.#revokedKey(tenant, sub), at)
  }

  /** Refuse whatever was issued for this tenant until `at` (app.unassigned, app.uninstalled, company.suspended). */
  async closeTenant(tenant: string, at: Date = new Date()): Promise<void> {
    await this.#raise(this.#closedKey(tenant), at)
  }

  /**
   * Which «life» of this person in this tenant it is: changes when the tenant is closed (uninstalled, unassigned) or
   * the person removed, so what is remembered once per life (the permissions page's «seen») is written again after.
   */
  async lifeOf(tenant: string, sub: string): Promise<string> {
    const [closed, removed] = await Promise.all([this.store.get(this.#closedKey(tenant)), this.store.get(this.#revokedKey(tenant, sub))])
    return `${closed ?? 0}.${removed ?? 0}`
  }

  async #raise(key: string, at: Date): Promise<void> {
    const seconds = Math.floor((Number.isFinite(at.getTime()) ? at.getTime() : Date.now()) / 1000)
    const held = Number(await this.store.get(key))
    if (Number.isFinite(held) && held >= seconds) return
    await this.store.put(key, String(seconds), REVOCATION_MS)
  }

  /** Why something issued at `iat` (epoch seconds) to this person of this tenant no longer counts, or null. */
  async revoked(tenant: string, sub: string | null, iat: number): Promise<string | null> {
    const closed = await this.store.get(this.#closedKey(tenant))
    if (closed && iat <= Number(closed)) return "the app was removed from this company, or the company is suspended"
    const removed = sub ? await this.store.get(this.#revokedKey(tenant, sub)) : null
    if (removed && iat <= Number(removed)) return "this person was removed from the company"
    return null
  }

  // ------------------------------------------------------------ app tokens and DPoP

  /** A new DPoP nonce, good for DPOP_NONCE_SECONDS. */
  async nonce(): Promise<string> {
    const value = randomBytes(18).toString("base64url")
    await this.store.put(`clegra:dpop-nonce:${value}`, "1", DPOP_NONCE_SECONDS * 1000)
    return value
  }

  /**
   * Checks a DPoP proof (RFC 9449) for a call to this app's resource: signed by the key the token is bound to
   * (`jkt`), `htm` the request's method, `htu` this app's configured resource (never the request's own URL or Host:
   * behind a proxy or a tunnel those are not what the client called), `ath` the token's hash, `iat` within 60 seconds
   * unless it carries a nonce this app gave, its `jti` used once. Throws DpopError (with a nonce when the client
   * should retry with one).
   */
  async checkDpop(proof: string | null, input: { method: string; token: string; jkt: string }): Promise<void> {
    if (!proof) throw new DpopError("a DPoP proof is required (the DPoP header)")
    let header: ReturnType<typeof decodeProtectedHeader>
    try {
      header = decodeProtectedHeader(proof)
    } catch {
      throw new DpopError("the DPoP proof is not a JWT")
    }
    const jwk = header.jwk as JWK | undefined
    if (header.typ !== DPOP_TYPE || !jwk || typeof jwk !== "object" || "d" in jwk || jwk.kty === "oct") throw new DpopError("the DPoP proof needs typ dpop+jwt and a public jwk")
    let payload: JWTPayload
    try {
      ;({ payload } = await jwtVerify(proof, EmbeddedJWK, { typ: DPOP_TYPE, algorithms: ALGS, requiredClaims: ["iat", "jti", "htm", "htu"] }))
    } catch (error) {
      throw new DpopError(why(error, "DPoP proof"))
    }
    if ((await calculateJwkThumbprint(jwk, "sha256")) !== input.jkt) throw new DpopError("the DPoP proof is signed by another key than the token is bound to")
    if (payload.htm !== input.method) throw new DpopError(`the DPoP proof is for ${String(payload.htm)}, not ${input.method}`)
    const htu = typeof payload.htu === "string" && URL.canParse(payload.htu) ? new URL(payload.htu) : null
    if (htu) htu.search = htu.hash = ""
    if (!htu || htu.toString() !== new URL(this.resource).toString()) throw new DpopError(`the DPoP proof is for ${String(payload.htu)}, not this app's address ${this.resource}`)
    if (payload.ath !== sha256(input.token)) throw new DpopError("the DPoP proof is for another token (ath)")
    if (typeof payload.jti !== "string" || !payload.jti || payload.jti.length > 200) throw new DpopError("the DPoP proof needs a jti")
    const now = Math.floor(Date.now() / 1000)
    if (payload.nonce !== undefined) {
      if (typeof payload.nonce !== "string" || !(await this.store.get(`clegra:dpop-nonce:${payload.nonce}`))) throw new DpopError("the DPoP nonce is unknown or expired", await this.nonce())
    } else if (Math.abs(now - Number(payload.iat)) > DPOP_SKEW_SECONDS) throw new DpopError("the DPoP proof's iat is too far from now: retry with the nonce given", await this.nonce())
    if (!(await this.store.once(`clegra:dpop:${input.jkt}:${payload.jti}`, (DPOP_NONCE_SECONDS + DPOP_SKEW_SECONDS) * 1000))) throw new DpopError("this DPoP proof was already used")
  }

  /**
   * Verifies an app token (or a delegated, automation run or device-agent token) and its DPoP proof for one request.
   * Throws AuthError (DpopError for the proof) with the reason.
   */
  async verify(token: string, request: { method: string; dpop: string | null }): Promise<{ claims: JWTPayload; caller: ClegraCaller; sub: string; name: string; tenant: string }> {
    let header: ReturnType<typeof decodeProtectedHeader>
    try {
      header = decodeProtectedHeader(token)
    } catch {
      throw new AuthError("malformed token")
    }
    if (header.typ !== APP_TOKEN_TYPE) throw new AuthError(`the token's typ is not ${APP_TOKEN_TYPE}`)
    if (typeof header.kid !== "string" || !header.kid) throw new AuthError("the token has no kid")
    let claims: JWTPayload
    try {
      claims = await this.#keys.verify(token, { typ: APP_TOKEN_TYPE, issuer: this.issuer, algorithms: ALGS, clockTolerance: SKEW, requiredClaims: ["exp", "iat", "sub", "aud", "jti"] })
    } catch (error) {
      throw new AuthError(why(error, "token"))
    }
    if (typeof claims.aud !== "string") throw new AuthError("the token's aud must be this app's address alone (a string, not a list)")
    if (claims.aud !== this.resource) throw new AuthError(`the token is for another app (this one is ${this.resource})`)
    const life = claims.exp! - claims.iat!
    const act = claims.act as { sub?: unknown } | undefined
    const actor = act === undefined ? null : actorOf(act)
    if (act !== undefined && !actor) throw new AuthError("the token's act names no actor this app knows (server:<id> or device-agent:<jkt>)")
    const short = actor?.kind === "server"
    if (life > (short ? DELEGATED_TOKEN_MAX_SECONDS : APP_TOKEN_MAX_SECONDS)) throw new AuthError(`the token lives more than ${short ? DELEGATED_TOKEN_MAX_SECONDS : APP_TOKEN_MAX_SECONDS} seconds`)
    if (claims.iat! > Math.floor(Date.now() / 1000) + SKEW) throw new AuthError("the token is issued in the future")
    const company = claims.company
    if (typeof company !== "string" || !COMPANY.test(company)) throw new AuthError("the token names no valid company")
    const role = claims.company_role
    if (role !== "admin" && role !== "member") throw new AuthError("the token's company_role is not admin or member")
    const jkt = (claims.cnf as { jkt?: unknown } | undefined)?.jkt
    if (typeof jkt !== "string" || !jkt) throw new AuthError("the token is not bound to a key (cnf.jkt)")
    const allowed = this.options.allowedCompanies
    if (allowed === undefined && process.env.NODE_ENV === "production") throw new AuthError("this app has no allowed companies configured")
    if (allowed !== undefined && allowed !== "any" && !allowed.includes(company)) throw new AuthError("this company may not use this app")
    const grantId = typeof claims.grant === "string" && claims.grant ? claims.grant : null
    const personJkt = typeof claims.person_jkt === "string" && claims.person_jkt ? claims.person_jkt : null
    if (short && !grantId && !personJkt) throw new AuthError("a delegated token names the person's device key (person_jkt)")
    const tools = Array.isArray(claims.tools) && claims.tools.every((t) => typeof t === "string") ? (claims.tools as string[]) : null
    await this.checkDpop(request.dpop, { method: request.method, token, jkt })
    // A server's token is for one call.
    if (short && !(await this.store.once(`clegra:jti:${claims.jti}`, (life + SKEW) * 1000))) throw new AuthError("this token was already used (a delegated or automation token is for one call)")
    const tenant = clegraTenant(company, this.issuer)
    const revoked = await this.revoked(tenant, claims.sub!, claims.iat!)
    if (revoked) throw new AuthError(revoked)
    const name = typeof claims.name === "string" && claims.name ? claims.name : typeof claims.email === "string" ? claims.email : ""
    return {
      claims,
      sub: claims.sub!,
      name,
      tenant,
      caller: {
        company,
        companyRole: role,
        email: typeof claims.email === "string" ? claims.email : null,
        jkt,
        actor,
        personJkt,
        grant: grantId ? { id: grantId, tools } : null,
        tokenId: String(claims.jti),
        issuedAt: claims.iat!,
        admin: false,
      },
    }
  }

  // ------------------------------------------------------------ confirmations

  /**
   * Checks the person's confirmation of a sensitive tool an agent calls: the core's confirmation token (app key,
   * `aud` this app, the caller's pairwise `sub` and company, this tool, the SHA-256 of these arguments, the device key
   * in `cnf.jkt`, ≤ 10 minutes, `jti` once) and the proof the device signed over it (its `jwk` the key in `cnf.jkt`,
   * `cth` the token's SHA-256, `iat` within 60 seconds, `jti` once). `deviceJkt`: the device the token must name, when
   * the caller's token says it (a delegated token's `person_jkt`, a device agent's key). Throws AuthError.
   */
  async checkConfirmation(sent: unknown, expected: { sub: string; company: string; tool: string; args: unknown; deviceJkt: string | null }): Promise<void> {
    const c = sent && typeof sent === "object" ? (sent as { token?: unknown; proof?: unknown }) : null
    if (!c || typeof c.token !== "string" || typeof c.proof !== "string") throw new AuthError("no confirmation (a confirmation token and the device's proof)")
    let claims: JWTPayload
    try {
      if (decodeProtectedHeader(c.token).typ !== CONFIRMATION_TOKEN_TYPE) throw new AuthError(`the confirmation's typ is not ${CONFIRMATION_TOKEN_TYPE}`)
      claims = await this.#keys.verify(c.token, { typ: CONFIRMATION_TOKEN_TYPE, issuer: this.issuer, algorithms: ALGS, clockTolerance: SKEW, requiredClaims: ["exp", "iat", "sub", "aud", "jti"] })
    } catch (error) {
      throw new AuthError(why(error, "confirmation"))
    }
    if (claims.aud !== this.resource) throw new AuthError("the confirmation is for another app")
    if (claims.exp! - claims.iat! > CONFIRMATION_MAX_SECONDS) throw new AuthError(`a confirmation lives ${CONFIRMATION_MAX_SECONDS / 60} minutes at most`)
    if (claims.sub !== expected.sub) throw new AuthError("the confirmation is for someone else")
    if (claims.company !== expected.company) throw new AuthError("the confirmation is for another company")
    if (claims.tool !== expected.tool) throw new AuthError("the confirmation is for another tool")
    if (claims.args_sha256 !== argsHash(expected.args)) throw new AuthError("the confirmation is for other arguments")
    const jkt = (claims.cnf as { jkt?: unknown } | undefined)?.jkt
    if (typeof jkt !== "string" || !jkt) throw new AuthError("the confirmation names no device key (cnf.jkt)")
    if (expected.deviceJkt && jkt !== expected.deviceJkt) throw new AuthError("the confirmation is for another device than the call's person")
    let header: ReturnType<typeof decodeProtectedHeader>
    let proof: JWTPayload
    try {
      header = decodeProtectedHeader(c.proof)
      const jwk = header.jwk as JWK | undefined
      if (header.typ !== CONFIRMATION_PROOF_TYPE || !jwk || "d" in jwk || jwk.kty === "oct") throw new AuthError(`the confirmation proof needs typ ${CONFIRMATION_PROOF_TYPE} and a public jwk`)
      ;({ payload: proof } = await jwtVerify(c.proof, EmbeddedJWK, { typ: CONFIRMATION_PROOF_TYPE, algorithms: ALGS, requiredClaims: ["iat", "jti", "cth"] }))
      if ((await calculateJwkThumbprint(jwk, "sha256")) !== jkt) throw new AuthError("the confirmation proof is signed by another key than the person's device")
    } catch (error) {
      throw new AuthError(why(error, "confirmation proof"))
    }
    if (proof.cth !== sha256(c.token)) throw new AuthError("the confirmation proof is for another confirmation")
    if (Math.abs(Math.floor(Date.now() / 1000) - Number(proof.iat)) > DPOP_SKEW_SECONDS) throw new AuthError("the confirmation proof's iat is too far from now")
    if (typeof proof.jti !== "string" || !(await this.store.once(`clegra:confirmation-proof:${jkt}:${proof.jti}`, 2 * DPOP_SKEW_SECONDS * 1000))) throw new AuthError("this confirmation proof was already used")
    if (!(await this.store.once(`clegra:confirmation:${claims.jti}`, (claims.exp! - claims.iat! + SKEW) * 1000))) throw new AuthError("this confirmation was already used")
  }

  // ------------------------------------------------------------ events

  /** Verifies one event the core posted (`clegra-event+jwt`, app key, `aud` this app, ≤ 5 minutes). Throws AuthError. */
  async verifyEvent(body: string): Promise<ClegraEvent> {
    let claims: JWTPayload
    try {
      if (decodeProtectedHeader(body).typ !== EVENT_TYPE) throw new AuthError(`the event's typ is not ${EVENT_TYPE}`)
      claims = await this.#keys.verify(body, { typ: EVENT_TYPE, issuer: this.issuer, algorithms: ALGS, clockTolerance: SKEW, requiredClaims: ["exp", "iat", "aud", "jti"] })
    } catch (error) {
      throw new AuthError(why(error, "event"))
    }
    if (claims.aud !== this.resource) throw new AuthError("the event is for another app")
    if (claims.exp! - claims.iat! > EVENT_MAX_SECONDS) throw new AuthError(`an event lives ${EVENT_MAX_SECONDS / 60} minutes at most`)
    const e = claims.event as Record<string, unknown> | undefined
    if (!e || typeof e !== "object" || !(EVENT_KINDS as readonly unknown[]).includes(e.kind)) throw new AuthError("the event names no kind this app knows")
    if (typeof e.company !== "string" || !COMPANY.test(e.company)) throw new AuthError("the event names no company")
    if (e.kind === "member.removed" && (typeof e.sub !== "string" || !e.sub)) throw new AuthError("member.removed names the person (sub)")
    return {
      id: String(claims.jti),
      kind: e.kind as ClegraEventKind,
      at: typeof e.at === "string" ? e.at : new Date(claims.iat! * 1000).toISOString(),
      company: e.company,
      tenant: clegraTenant(e.company, this.issuer),
      ...(typeof e.sub === "string" ? { sub: e.sub } : {}),
      ...(typeof e.installation === "string" ? { installation: e.installation } : {}),
    }
  }

  // ------------------------------------------------------------ CORS

  /**
   * The CORS headers for a browser call from `origin` (H4): only an exact client origin from `clientOrigins` is
   * answered, with `Authorization`, `DPoP` and `Content-Type` (and MCP's own headers) allowed, `DPoP-Nonce` and
   * `WWW-Authenticate` exposed, and never credentials. Another origin gets no allow header (the browser refuses).
   */
  cors(origin: string | null): Record<string, string> {
    const base = { vary: "origin" }
    if (!origin || !(this.options.clientOrigins ?? []).includes(origin)) return base
    return {
      ...base,
      "access-control-allow-origin": origin,
      "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
      "access-control-allow-headers": "authorization, dpop, content-type, mcp-protocol-version, mcp-session-id, last-event-id",
      "access-control-expose-headers": "dpop-nonce, www-authenticate, mcp-session-id",
      "access-control-max-age": "600",
    }
  }
}

function actorOf(act: { sub?: unknown }): Actor | null {
  const sub = typeof act.sub === "string" ? act.sub : ""
  const m = /^(server|device-agent):([A-Za-z0-9._~-]{1,200})$/.exec(sub)
  return m ? { kind: m[1] as Actor["kind"], id: m[2]! } : null
}
