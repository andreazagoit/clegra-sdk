/**
 * THE SIGN-IN MODULE (`@clegra/sdk/signin`): the app's own OAuth 2.1 authorization server on top of the app's own
 * login (MCP authorization, the access profile). It is how anyone acts for a person of the app: any MCP client. The
 * person signs in with the app's own account, in their system browser, and consents; the client then holds a **grant
 * the app issued**, revocable here, and nothing else.
 *
 * - Authorization code with PKCE S256; clients known by their Client ID Metadata Document (public, or with a key pair:
 *   `private_key_jwt`); no dynamic registration. RFC 8414 metadata, RFC 8707 `resource`, RFC 9207 `iss`.
 * - Scopes are the access profile's (`web.read`, `web.write`, `web.irreversible`, `bound_browser_session`,
 *   `browser_session` when the app offers the link mode, `offline_access`), each on its own consent line (ACC-1); a
 *   request with none gets `web.read`. Sign-in and consent are never framed and never remembered (ACC-4).
 * - Access tokens `at+jwt` (RFC 9068), EdDSA (`jwks_uri`), `aud` = the app's MCP address, ten minutes; bound to the
 *   client's key (`cnf.jkt`, RFC 9449 DPoP) when the token request carries a proof (ACC-5).
 * - Refresh tokens rotated on every use; a used one presented again revokes the whole grant. They live
 *   `refreshTokenDays` only with `offline_access`, else 12 hours from the grant (ACC-5). RFC 7009 revocation.
 * - The grants page (`/oauth/grants`): each grant with its scopes and a button to revoke (ACC-6). Every revocation is
 *   told to `onRevoke` listeners (`serve` ends transferred sessions, confirmations and subscriptions).
 *
 * Web APIs only (Fetch, Web Crypto, jose): it runs on Node, Deno, Bun and edge runtimes.
 */
import { calculateJwkThumbprint, createLocalJWKSet, decodeJwt, decodeProtectedHeader, exportJWK, generateKeyPair, importJWK, jwtVerify, SignJWT, type CryptoKey, type JWK, type JWTPayload } from "jose"

import { ALL_SCOPES, SCOPES } from "../access"
import type { App } from "../app"
import { AuthError, CLIENT_ASSERTION_ALGS, ClientDirectory, ClientMetadataError, clientMetadataUrlProblem, isClientMetadataUrl, redirectUriAllowed, type ClientMetadata, type ClientMetadataTransport } from "../auth"
import { randomToken, sha256 } from "../crypto"
import type { Grant, Person } from "../define"
import { checkDpopProof, DPOP_ALGS, DpopError } from "../dpop"
import { isProduction } from "../env"
import { localize, type Label } from "../labels"
import type { DevTools } from "./dev"
import { escapeHtml, formActionSource, hidden, page, pageLocale, textsOf, type PageLocale } from "./pages"
import type { SignInStore } from "./store"

// ------------------------------------------------------------------ types

/** The app's own login, under the module: who is signed in on a request (from their own credentials), and where its sign-in page is. */
export type Login = {
  session(request: Request): Promise<Person | null> | Person | null
  /** The app's sign-in page, coming back to `returnTo` (a path and query on the app) once signed in. */
  signInUrl(returnTo: string, request: Request): string
  /** The login's own routes, when it serves them (the password login does). */
  fetch?(request: Request): Promise<Response | null> | Response | null
}

export type SignInOptions = {
  /** This authorization server's issuer: the app's public origin (`https://jobs.example.com`), https except on a loopback address. */
  issuer: string
  /** The app's MCP address (`https://jobs.example.com/mcp`): the one audience of the tokens. */
  resource: string
  login: Login
  /** Whether the person may still use the app, read on every call: false (they left, were disabled) refuses every token of theirs at once. Default true. */
  active?(person: Person): Promise<boolean> | boolean
  store: SignInStore
  /** The app's signing keys as private JWKs (Ed25519), the first signing, the others still verifying (rotation). Required in production. */
  keys?: JWK[]
  /** The words of the consent page, default the app's title. */
  title?: Label
  accessTokenSeconds?: number
  /** How long a refresh token lives with `offline_access` (default 30 days); without it, 12 hours from the grant. */
  refreshTokenDays?: number
  /** For tests: how client metadata documents are fetched. */
  clientMetadata?: ClientMetadataTransport
}

/** A grant as the grants page and `grants.list` show it. */
export type GrantInfo = { id: string; client: string; clientName: string | null; scopes: string[]; createdAt: string; usedAt: string | null; bound: boolean; offline: boolean; browserSessions: boolean }

export type SignIn = {
  readonly issuer: string
  readonly resource: string
  /** The authorization servers to name in the protected-resource metadata: this one. */
  readonly authorizationServers: string[]
  readonly login: Login
  /** Answers the module's paths (metadata, authorize, token, revoke, keys, grants page, the login's own); null for any other. */
  fetch(request: Request): Promise<Response | null>
  /** Verifies an access token of this module for `resource`: the grant, or null when it is not one; throws AuthError with the reason when it is refused. */
  verify(token: string, request: Request, info: { resource: string; scheme: "Bearer" | "DPoP" }): Promise<Grant | null>
  /** Told of every revoked grant (by the person, by reuse, by the client, by `revokeGrant`). */
  onRevoke(listener: (grant: string) => void | Promise<void>): void
  /** Revokes a grant by its id (idempotent): refresh tokens end, access tokens are refused. */
  revokeGrant(grant: string): Promise<void>
  /** The grants of a person, for the app's own screens (the module also serves `/oauth/grants`). */
  grants: {
    list(person: Person): Promise<GrantInfo[]>
    revoke(person: Person, id: string): Promise<boolean>
  }
  /** A person who left: every grant of theirs ends now. */
  forget(person: Person): Promise<void>
  /** The development side (`devSignIn` only). */
  readonly dev?: DevTools
}

// ------------------------------------------------------------------ constants

export const AUTHORIZE_PATH = "/oauth/authorize"
export const TOKEN_PATH = "/oauth/token"
export const REVOKE_PATH = "/oauth/revoke"
export const JWKS_PATH = "/oauth/jwks.json"
export const GRANTS_PATH = "/oauth/grants"
export const OFFLINE_SCOPE = SCOPES.offline
const CONSENT_SECONDS = 10 * 60
const CODE_SECONDS = 60
const SHORT_REFRESH_MS = 12 * 3600_000
const SKEW = 30

type Pending = { client: string; clientName: string | null; redirect: string; state: string; challenge: string; scope: string; person: Person; locale: PageLocale }
type Code = { client: string; redirect: string; challenge: string; scope: string; person: Person }
type LinkRecord = { id: string; client: string; clientName: string | null; scope: string; person: Person; refresh: string; jkt: string | null; createdAt: string; usedAt: string | null }
type RefreshEntry = { link: string; person: Person; until: number }

const enc = encodeURIComponent
const personKey = (p: Pick<Person, "tenant" | "id">) => `${enc(p.tenant ?? "")}:${enc(p.id)}`
const LOOPBACK = /^(localhost|127\.0\.0\.1|\[::1\]|[a-z0-9-]+\.localhost)$/i

/** A new signing key for `keys` (a private Ed25519 JWK with its `kid`), as JSON for an environment variable. */
export async function newSignInKey(): Promise<string> {
  const { privateKey } = await generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true })
  const jwk = await exportJWK(privateKey)
  return JSON.stringify({ ...jwk, kid: (await calculateJwkThumbprint(jwk, "sha256")).slice(0, 16), alg: "EdDSA" })
}

function checkUrl(value: string, what: string): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`signIn ${what}: "${value}" is not a URL`)
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK.test(url.hostname))) throw new Error(`signIn ${what}: "${value}" must be https (http only on a loopback address)`)
  if (url.search || url.hash) throw new Error(`signIn ${what}: "${value}" has a query or a fragment`)
  return url
}

/** A redirect the person cannot verify (ACC-4): a loopback address or a custom scheme. */
export function unverifiedRedirect(redirect: string): boolean {
  try {
    const u = new URL(redirect)
    return u.protocol !== "https:" || LOOPBACK.test(u.hostname)
  } catch {
    return true
  }
}

// ------------------------------------------------------------------ the module

export function createSignIn(app: App, options: SignInOptions): SignIn {
  return buildSignIn(app, options, false)
}

/** The module; `memoryKey`: a development sign-in, whose key lives in memory by design (`devSignIn`). */
export function buildSignIn(app: App, options: SignInOptions, memoryKey: boolean): SignIn {
  if (app?.kind !== "app") throw new Error("createSignIn: give it the app defineApp returned")
  const issuer = checkUrl(options.issuer, "issuer").toString().replace(/\/$/, "")
  const resource = checkUrl(options.resource, "resource").toString()
  if (new URL(resource).origin !== new URL(issuer).origin) throw new Error("signIn: the resource (the MCP address) must be on the issuer's origin: one app, one origin")
  if (isProduction() && !options.keys?.length) throw new Error("signIn.keys: give the app's signing key in production (newSignInKey() makes one); a key in memory would sign everyone out at every restart")
  const issuerPath = new URL(issuer).pathname.replace(/\/$/, "")
  const at = (path: string) => `${issuer}${path}`
  const accessSeconds = options.accessTokenSeconds ?? 600
  const longRefreshMs = (options.refreshTokenDays ?? 30) * 24 * 3600_000
  const store = options.store
  const directory = new ClientDirectory(options.clientMetadata)
  const memory = { once: (k: string, ttl: number) => store.once(k, ttl), get: (k: string) => store.get(k), set: (k: string, v: unknown, ttl: number | null) => store.set(k, v, ttl) }
  const listeners: ((grant: string) => void | Promise<void>)[] = []
  const active = async (p: Person) => (options.active ? await options.active(p) : true)

  type Keys = { signing: { key: CryptoKey; kid: string }; verify: ReturnType<typeof createLocalJWKSet>; public: JWK[] }
  let keys: Promise<Keys> | null = null
  const loadKeys = (): Promise<Keys> =>
    (keys ??= (async () => {
      let given = options.keys ?? []
      if (!given.length) {
        if (!memoryKey) console.warn(`[clegra] signIn.keys is not set: a key in memory signs the tokens (development only; everyone is signed out at restart)`)
        given = [JSON.parse(await newSignInKey()) as JWK]
      }
      const pub: JWK[] = []
      for (const jwk of given) {
        if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || !jwk.d) throw new Error("signIn.keys: each key is a private Ed25519 JWK (newSignInKey())")
        const { d: _d, ...p } = jwk
        pub.push({ ...p, kid: jwk.kid ?? (await calculateJwkThumbprint(p, "sha256")).slice(0, 16), alg: "EdDSA", use: "sig" })
      }
      return { signing: { key: (await importJWK(given[0]!, "EdDSA")) as CryptoKey, kid: pub[0]!.kid! }, verify: createLocalJWKSet({ keys: pub }), public: pub }
    })())

  const scopesSupported = () => ALL_SCOPES.filter((s) => s !== SCOPES.browserSession || Boolean(app.config.sessionTransfer?.link))
  const title = (locale: string) => localize(options.title ?? app.config.title, locale, app.locale)

  /** The scopes asked, checked (ACC-1: only what was asked; none asked: `web.read`). Null when one is not offered. */
  const scopeOf = (asked: string): string | null => {
    const known = new Set(scopesSupported())
    const names = [...new Set(asked.split(" ").filter(Boolean))]
    if (names.some((n) => !known.has(n))) return null
    return (names.length ? names : [SCOPES.read]).join(" ")
  }

  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } })
  const oauthError = (error: string, description: string, status = 400, headers: Record<string, string> = {}) => json({ error, error_description: description }, status, headers)

  const metadata = () => ({
    issuer,
    authorization_endpoint: at(AUTHORIZE_PATH),
    token_endpoint: at(TOKEN_PATH),
    revocation_endpoint: at(REVOKE_PATH),
    jwks_uri: at(JWKS_PATH),
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "private_key_jwt"],
    token_endpoint_auth_signing_alg_values_supported: [...CLIENT_ASSERTION_ALGS],
    revocation_endpoint_auth_methods_supported: ["none", "private_key_jwt"],
    revocation_endpoint_auth_signing_alg_values_supported: [...CLIENT_ASSERTION_ALGS],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
    dpop_signing_alg_values_supported: [...DPOP_ALGS],
    scopes_supported: scopesSupported(),
    ui_locales_supported: ["en", "it"],
  })

  // ---------------------------------------------------------------- grants

  const linkKey = (p: Pick<Person, "tenant" | "id">, id: string) => `link:${personKey(p)}:${id}`

  async function endLink(link: Pick<LinkRecord, "id" | "person">): Promise<boolean> {
    const kept = (await store.take(linkKey(link.person, link.id))) as LinkRecord | null
    await store.delete(`grant:${link.id}`)
    if (!kept) return false
    if (kept.refresh) await store.delete(`refresh:${kept.refresh}`)
    for (const l of listeners) await l(link.id)
    return true
  }

  const infoOf = (l: LinkRecord): GrantInfo => {
    const scopes = l.scope.split(" ").filter(Boolean)
    return { id: l.id, client: l.client, clientName: l.clientName, scopes, createdAt: l.createdAt, usedAt: l.usedAt, bound: Boolean(l.jkt), offline: scopes.includes(SCOPES.offline), browserSessions: scopes.includes(SCOPES.boundBrowserSession) || scopes.includes(SCOPES.browserSession) }
  }

  const grantsApi: SignIn["grants"] = {
    async list(person) {
      return (await store.list(`link:${personKey(person)}:`)).map(({ value }) => infoOf(value as LinkRecord))
    },
    async revoke(person, id) {
      return endLink({ id, person })
    },
  }

  async function revokeGrant(id: string): Promise<void> {
    const key = (await store.get(`grant:${id}`)) as string | null
    if (!key) return
    const link = (await store.get(`link:${key}:${id}`)) as LinkRecord | null
    if (link) await endLink(link)
    else await store.delete(`grant:${id}`)
  }

  // ---------------------------------------------------------------- authorize

  const errorPage = (locale: PageLocale, why: string, status = 400) => {
    const t = textsOf(locale)
    return page({ title: t.error, locale, status, frameAncestors: [], body: `<h1>${escapeHtml(t.error)}</h1><p class="e">${escapeHtml(why)}</p><p class="m">${escapeHtml(t.nothingSent)}</p>` })
  }

  const answer = (p: Pick<Pending, "redirect" | "state">, params: Record<string, string>) => {
    const back = new URL(p.redirect)
    for (const [k, v] of Object.entries({ ...params, ...(p.state ? { state: p.state } : {}), iss: issuer })) back.searchParams.set(k, v)
    return new Response(null, { status: 303, headers: { location: back.toString(), "cache-control": "no-store" } })
  }

  const checkResource = (value: string) => {
    try {
      return new URL(value).toString()
    } catch {
      return null
    }
  }

  async function authorize(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (request.method === "POST") return decide(request)
    if (request.method !== "GET") return new Response(null, { status: 405, headers: { allow: "GET, POST" } })
    const q = (k: string) => url.searchParams.get(k) ?? ""
    const locale = pageLocale(request, url.searchParams.get("ui_locales"), app.locale)
    // Who asks, first: until the client and its redirect address are known good, nothing is sent anywhere.
    const clientId = q("client_id")
    const problem = clientMetadataUrlProblem(clientId)
    if (problem) return errorPage(locale, `client_id must be the address of the client's metadata document (Client ID Metadata Document): ${problem}`)
    let client: ClientMetadata
    try {
      client = await directory.client(clientId)
    } catch (error) {
      return errorPage(locale, error instanceof ClientMetadataError ? error.message : "the client's metadata document could not be read")
    }
    const redirect = q("redirect_uri")
    if (!redirectUriAllowed(redirect, client.redirect_uris)) return errorPage(locale, "redirect_uri is not one of the client's redirect_uris")
    if (q("response_mode") && q("response_mode") !== "query") return errorPage(locale, "response_mode must be query")
    const base = { redirect, state: q("state") }
    const refuse = (error: string, description: string) => answer(base, { error, error_description: description })
    if (q("response_type") !== "code") return refuse("unsupported_response_type", "response_type must be code")
    if (!/^[A-Za-z0-9_-]{43}$/.test(q("code_challenge")) || q("code_challenge_method") !== "S256") return refuse("invalid_request", "a S256 code_challenge is required (PKCE)")
    if (url.searchParams.has("resource") && checkResource(q("resource")) !== resource) return refuse("invalid_target", `the resource must be ${resource}`)
    const scope = scopeOf(q("scope"))
    if (scope === null) return refuse("invalid_scope", `scopes are among ${scopesSupported().join(" ")}`)
    const person = await options.login.session(request)
    if (!person) {
      const returnTo = `${url.pathname}${url.search}`
      return new Response(null, { status: 303, headers: { location: new URL(options.login.signInUrl(returnTo, request), issuer).toString(), "cache-control": "no-store" } })
    }
    if (!(await active(person))) return refuse("access_denied", "this account may not use the app")
    const id = randomToken()
    await store.set(`consent:${await sha256(id)}`, { ...base, client: clientId, clientName: client.client_name ?? null, challenge: q("code_challenge"), scope, person, locale } satisfies Pending, CONSENT_SECONDS * 1000)
    return consentPage(locale, { id, client, scope, person, redirect })
  }

  function consentPage(locale: PageLocale, input: { id: string; client: ClientMetadata; scope: string; person: Person; redirect: string }): Response {
    const t = textsOf(locale)
    const appTitle = title(locale)
    const host = new URL(input.client.client_id).host
    const clientName = input.client.client_name ?? host
    const list = input.scope
      .split(" ")
      .map((s) => `<li>${escapeHtml(t.scope[s] ?? s)}</li>`)
      .join("")
    const warning = unverifiedRedirect(input.redirect) ? `<p class="e">${escapeHtml(t.unverified)}</p>` : ""
    // «Allow» and «Deny» are answered by a 303 to the client's redirect_uri (already checked against its metadata):
    // the CSP lets the form's navigation end there, and nowhere else.
    const target = formActionSource(input.redirect)
    return page({
      title: t.consentTitle(clientName, appTitle),
      locale,
      frameAncestors: [],
      formTargets: target ? [target] : [],
      body: `<h1>${escapeHtml(t.consentTitle(clientName, appTitle))}</h1><p class="m">${escapeHtml(t.signedInAs(input.person.name))}</p>
<p>${escapeHtml(t.consentLead(appTitle))}</p><ul>${list}</ul>
<p class="c"><span class="m">${escapeHtml(t.consentFrom)}</span><br><strong>${escapeHtml(host)}</strong> · ${escapeHtml(input.client.client_id)}<br><span class="m">${escapeHtml(t.consentRedirect)}</span><br>${escapeHtml(input.redirect)}</p>${warning}
<form method="post" action="${escapeHtml(at(AUTHORIZE_PATH))}">${hidden({ request: input.id })}<div class="b"><button class="p" name="decision" value="allow" type="submit">${escapeHtml(t.allow)}</button><button name="decision" value="deny" type="submit">${escapeHtml(t.deny)}</button></div></form>
<p class="m">${escapeHtml(t.consentFoot(appTitle))}</p>`,
    })
  }

  async function decide(request: Request): Promise<Response> {
    const locale = pageLocale(request, null, app.locale)
    // The consent is posted from this page only: a form of another site is refused before anything is read.
    const origin = request.headers.get("origin")
    if (origin && origin !== new URL(issuer).origin) return errorPage(locale, "the consent comes from another site", 403)
    const form = new URLSearchParams(await request.text())
    const id = form.get("request") ?? ""
    const pending = id ? ((await store.take(`consent:${await sha256(id)}`)) as Pending | null) : null
    if (!pending) return errorPage(locale, "this consent has expired or was already answered: start again from the client")
    const person = await options.login.session(request)
    if (!person || person.id !== pending.person.id || (person.tenant ?? "") !== (pending.person.tenant ?? "")) return errorPage(pending.locale, "the consent was opened by someone else", 403)
    if (form.get("decision") !== "allow") return answer(pending, { error: "access_denied", error_description: "the person did not allow it" })
    const code = randomToken()
    await store.set(`code:${await sha256(code)}`, { client: pending.client, redirect: pending.redirect, challenge: pending.challenge, scope: pending.scope, person } satisfies Code, CODE_SECONDS * 1000)
    return answer(pending, { code })
  }

  // ---------------------------------------------------------------- token

  /** The client of a token request, authenticated as its metadata document says; a Response when it is refused. */
  async function clientOf(form: URLSearchParams): Promise<ClientMetadata | Response> {
    let id = form.get("client_id") ?? ""
    if (!id && form.get("client_assertion")) {
      try {
        id = String(decodeJwt(form.get("client_assertion")!).sub ?? "")
      } catch {}
    }
    if (!isClientMetadataUrl(id)) return oauthError("invalid_client", "client_id must be the address of the client's metadata document", 401)
    let client: ClientMetadata
    try {
      client = await directory.client(id)
    } catch (error) {
      return oauthError("invalid_client", error instanceof ClientMetadataError ? error.message : "the client's metadata document could not be read", 401)
    }
    if (client.token_endpoint_auth_method === "private_key_jwt") {
      const why = await directory.authenticate(client, form, [at(TOKEN_PATH), issuer, at(REVOKE_PATH)])
      if (why) return oauthError("invalid_client", why, 401)
    }
    return client
  }

  const refreshMsOf = (scope: string) => (scope.split(" ").includes(SCOPES.offline) ? longRefreshMs : SHORT_REFRESH_MS)

  async function issue(link: LinkRecord, refreshUntil: number): Promise<Response> {
    const k = await loadKeys()
    const now = Math.floor(Date.now() / 1000)
    const access = await new SignJWT({ client_id: link.client, scope: link.scope, sid: link.id, name: link.person.name, ...(link.person.tenant ? { tenant: link.person.tenant } : {}), ...(link.jkt ? { cnf: { jkt: link.jkt } } : {}) })
      .setProtectedHeader({ alg: "EdDSA", typ: "at+jwt", kid: k.signing.kid })
      .setIssuer(issuer)
      .setSubject(link.person.id)
      .setAudience(resource)
      .setIssuedAt(now)
      .setExpirationTime(now + accessSeconds)
      .setJti(randomToken(16))
      .sign(k.signing.key)
    const refresh = randomToken()
    const hash = await sha256(refresh)
    // Rotation never extends the grant: without offline_access it ends 12 hours after it was made (ACC-5).
    const ttl = Math.max(1, refreshUntil - Date.now())
    await store.set(linkKey(link.person, link.id), { ...link, refresh: hash }, ttl)
    await store.set(`grant:${link.id}`, personKey(link.person), ttl)
    await store.set(`refresh:${hash}`, { link: link.id, person: link.person, until: refreshUntil } satisfies RefreshEntry, ttl)
    return json({ access_token: access, token_type: link.jkt ? "DPoP" : "Bearer", expires_in: accessSeconds, refresh_token: refresh, scope: link.scope })
  }

  async function token(request: Request): Promise<Response> {
    if (request.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } })
    const form = new URLSearchParams(await request.text())
    const client = await clientOf(form)
    if (client instanceof Response) return client
    // A proof with the request binds the tokens to the client's key (RFC 9449 §5).
    let jkt: string | null = null
    if (request.headers.get("dpop")) {
      try {
        jkt = await checkDpopProof(request.headers.get("dpop"), { method: "POST", htu: at(TOKEN_PATH), memory })
      } catch (error) {
        const nonce = error instanceof DpopError ? error.nonce : null
        return oauthError(nonce ? "use_dpop_nonce" : "invalid_dpop_proof", error instanceof Error ? error.message : "invalid DPoP proof", 400, nonce ? { "dpop-nonce": nonce } : {})
      }
    }
    if (form.has("resource") && checkResource(form.get("resource")!) !== resource) return oauthError("invalid_target", `the resource must be ${resource}`)
    const grant = form.get("grant_type")
    if (grant === "authorization_code") {
      const code = (await store.take(`code:${await sha256(form.get("code") ?? "")}`)) as Code | null
      if (!code) return oauthError("invalid_grant", "unknown, expired or used code")
      if (code.client !== client.client_id) return oauthError("invalid_grant", "the code was issued to another client")
      if ((form.get("redirect_uri") ?? "") !== code.redirect) return oauthError("invalid_grant", "redirect_uri is not the one the code was issued for")
      if ((await sha256(form.get("code_verifier") ?? "")) !== code.challenge) return oauthError("invalid_grant", "the PKCE check failed (code_verifier)")
      if (!(await active(code.person))) return oauthError("invalid_grant", "this account may not use the app")
      const link: LinkRecord = { id: randomToken(12), client: client.client_id, clientName: client.client_name ?? null, scope: code.scope, person: code.person, refresh: "", jkt, createdAt: new Date().toISOString(), usedAt: null }
      return issue(link, Date.now() + refreshMsOf(code.scope))
    }
    if (grant === "refresh_token") {
      const hash = await sha256(form.get("refresh_token") ?? "")
      const entry = (await store.get(`refresh:${hash}`)) as RefreshEntry | null
      if (!entry) return oauthError("invalid_grant", "unknown or expired refresh token")
      const link = (await store.get(linkKey(entry.person, entry.link))) as LinkRecord | null
      if (!link) return oauthError("invalid_grant", "this grant was revoked")
      if (link.client !== client.client_id) return oauthError("invalid_grant", "the refresh token was issued to another client")
      if (link.refresh !== hash) {
        // A refresh token used twice: someone else holds a copy. The grant ends for both.
        await endLink(link)
        return oauthError("invalid_grant", "this refresh token was already used: the grant is revoked")
      }
      if (link.jkt && jkt !== link.jkt) return oauthError("invalid_grant", "the refresh token is bound to the client's DPoP key: send a proof signed by it")
      // Two requests with the same refresh token: the first wins, the second is reuse.
      if (!(await store.once(`refreshed:${hash}`, Math.max(1, entry.until - Date.now())))) {
        await endLink(link)
        return oauthError("invalid_grant", "this refresh token was already used: the grant is revoked")
      }
      if (!(await active(link.person))) {
        await endLink(link)
        return oauthError("invalid_grant", "this account may not use the app any more")
      }
      return issue({ ...link, usedAt: new Date().toISOString() }, entry.until)
    }
    return oauthError("unsupported_grant_type", "authorization_code or refresh_token")
  }

  async function revoke(request: Request): Promise<Response> {
    if (request.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } })
    const form = new URLSearchParams(await request.text())
    const client = await clientOf(form)
    if (client instanceof Response) return client
    const value = form.get("token") ?? ""
    // RFC 7009 §2.2: unknown tokens are answered 200 as well.
    const entry = (await store.get(`refresh:${await sha256(value)}`)) as RefreshEntry | null
    if (entry) {
      const link = (await store.get(linkKey(entry.person, entry.link))) as LinkRecord | null
      if (link && link.client === client.client_id) await endLink(link)
    } else if (value.split(".").length === 3) {
      try {
        const { payload } = await jwtVerify(value, (await loadKeys()).verify, { issuer, audience: resource, typ: "at+jwt" })
        if (payload.client_id === client.client_id && typeof payload.sid === "string") await revokeGrant(payload.sid)
      } catch {}
    }
    return new Response(null, { status: 200, headers: { "cache-control": "no-store" } })
  }

  // ---------------------------------------------------------------- the resource's side

  async function verify(tokenValue: string, request: Request, info: { resource: string; scheme: "Bearer" | "DPoP" }): Promise<Grant | null> {
    let header: ReturnType<typeof decodeProtectedHeader>
    let iss: unknown
    try {
      header = decodeProtectedHeader(tokenValue)
      iss = decodeJwt(tokenValue).iss
    } catch {
      return null
    }
    if (iss !== issuer) return null
    if (header.typ !== "at+jwt") throw new AuthError("not an access token (typ at+jwt)")
    let payload: JWTPayload
    try {
      ;({ payload } = await jwtVerify(tokenValue, (await loadKeys()).verify, { issuer, audience: info.resource, typ: "at+jwt", algorithms: ["EdDSA"], clockTolerance: SKEW, requiredClaims: ["sub", "exp", "aud", "sid"] }))
    } catch (error) {
      const message = error instanceof Error ? error.message : "invalid token"
      throw new AuthError(/"aud"/.test(message) ? "the token is for another server" : /"exp"/.test(message) ? "the access token has expired" : "the access token does not verify")
    }
    const jkt = (payload.cnf as { jkt?: unknown } | undefined)?.jkt
    if (typeof jkt === "string") {
      if (info.scheme !== "DPoP") throw new AuthError("this token is bound to a key: send it as Authorization: DPoP with its proof")
      await checkDpopProof(request.headers.get("dpop"), { method: request.method, htu: info.resource, token: tokenValue, jkt, memory })
    } else if (info.scheme === "DPoP") throw new AuthError("this token is not bound to a key: send it as Authorization: Bearer")
    const claimed = { id: String(payload.sub), ...(typeof payload.tenant === "string" ? { tenant: payload.tenant } : {}) }
    // The grant must still exist: revoking it ends its tokens at once, not in ten minutes.
    const link = (await store.get(linkKey(claimed, String(payload.sid)))) as LinkRecord | null
    if (!link) throw new AuthError("this access was revoked")
    if (!(await active(link.person))) throw new AuthError("this account may not use the app any more")
    return { id: link.id, clientId: link.client, ...(link.clientName ? { clientName: link.clientName } : {}), person: link.person, scopes: link.scope.split(" ").filter(Boolean) }
  }

  // ---------------------------------------------------------------- the grants page (ACC-6)

  async function grantsPage(request: Request): Promise<Response> {
    const locale = pageLocale(request, null, app.locale)
    const t = textsOf(locale)
    if (request.method !== "GET" && request.method !== "POST") return new Response(null, { status: 405, headers: { allow: "GET, POST" } })
    const person = await options.login.session(request)
    if (!person) return new Response(null, { status: 303, headers: { location: new URL(options.login.signInUrl(GRANTS_PATH, request), issuer).toString(), "cache-control": "no-store" } })
    const nonceKey = `grants-nonce:${personKey(person)}`
    let notice = ""
    if (request.method === "POST") {
      const origin = request.headers.get("origin")
      const site = request.headers.get("sec-fetch-site")
      if ((origin && origin !== new URL(issuer).origin) || (site && site !== "same-origin")) return errorPage(locale, "the request comes from another site", 403)
      const form = new URLSearchParams(await request.text())
      const nonce = (await store.get(nonceKey)) as string | null
      if (!nonce || form.get("nonce") !== nonce) return errorPage(locale, "this page has expired: open it again", 403)
      if (await grantsApi.revoke(person, form.get("grant") ?? "")) notice = `<p class="m">${escapeHtml(t.revoked)}</p>`
    }
    const nonce = randomToken(16)
    await store.set(nonceKey, nonce, 3600_000)
    const grants = await grantsApi.list(person)
    const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString(locale === "it" ? "it-IT" : "en-GB") : t.grantsNever)
    const items = grants
      .map((g) => {
        const host = new URL(g.client).host
        return `<div class="c"><strong>${escapeHtml(g.clientName ?? host)}</strong> <span class="m">${escapeHtml(host)}</span>
<p class="m">${escapeHtml(t.grantsScopes)}:</p><ul>${g.scopes.map((s) => `<li>${escapeHtml(t.scope[s] ?? s)}</li>`).join("")}</ul>
<p class="m">${escapeHtml(t.grantsCreated)} ${escapeHtml(day(g.createdAt))} · ${escapeHtml(t.grantsUsed)} ${escapeHtml(day(g.usedAt))}<br>${escapeHtml(t.grantsBackground)}: ${g.offline ? t.yes : t.no} · ${escapeHtml(t.grantsBrowser)}: ${g.browserSessions ? t.yes : t.no}</p>
<form method="post" action="${escapeHtml(at(GRANTS_PATH))}">${hidden({ nonce, grant: g.id })}<button type="submit">${escapeHtml(t.revoke)}</button></form></div>`
      })
      .join("")
    return page({
      title: t.grantsTitle(title(locale)),
      locale,
      frameAncestors: [],
      body: `<h1>${escapeHtml(t.grantsTitle(title(locale)))}</h1><p class="m">${escapeHtml(t.signedInAs(person.name))}</p>${notice}${items || `<p>${escapeHtml(t.grantsNone)}</p>`}<p><a href="/access/log">${escapeHtml(t.accessLog)}</a></p>`,
    })
  }

  return {
    issuer,
    resource,
    authorizationServers: [issuer],
    login: options.login,
    async fetch(request) {
      const path = new URL(request.url).pathname
      if (path === `/.well-known/oauth-authorization-server${issuerPath}` || path === `/.well-known/openid-configuration${issuerPath}` || (issuerPath && path === `${issuerPath}/.well-known/openid-configuration`)) {
        if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { status: 405, headers: { allow: "GET, HEAD" } })
        return json(metadata(), 200, { "cache-control": "public, max-age=300", "access-control-allow-origin": "*" })
      }
      const local = issuerPath && path.startsWith(`${issuerPath}/`) ? path.slice(issuerPath.length) : issuerPath ? null : path
      if (local === JWKS_PATH) return json({ keys: (await loadKeys()).public }, 200, { "cache-control": "public, max-age=300", "access-control-allow-origin": "*" })
      if (local === AUTHORIZE_PATH) return authorize(request)
      if (local === TOKEN_PATH) return token(request)
      if (local === REVOKE_PATH) return revoke(request)
      if (local === GRANTS_PATH) return grantsPage(request)
      return (await options.login.fetch?.(request)) ?? null
    },
    verify,
    onRevoke(listener) {
      listeners.push(listener)
    },
    revokeGrant,
    grants: grantsApi,
    async forget(person) {
      for (const g of await grantsApi.list(person)) await endLink({ id: g.id, person })
    },
  }
}

/** For hosts and tests: base64url SHA-256 of a PKCE verifier (the S256 challenge). */
export const pkceChallenge = (verifier: string) => sha256(verifier)
