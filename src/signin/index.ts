/**
 * THE SIGN-IN MODULE (`@clegra/sdk/signin`, spec §7 «Your sign-in»): the app's own OAuth 2.1 authorization server on
 * top of the app's own login. It is how anyone acts for a person of the app: Clegra, Claude, ChatGPT, any MCP client.
 * The person signs in with the app's own account and consents; the client then holds a **delegation the app issued**
 * (a link), revocable here, and nothing else. An app never signs people in with someone else's accounts.
 *
 * - Authorization code with PKCE S256; clients known by their Client ID Metadata Document (public, or with a key pair:
 *   `private_key_jwt`); no dynamic registration. RFC 8414 metadata, RFC 8707 `resource`, RFC 9207 `iss`.
 * - Access tokens `at+jwt` (RFC 9068), signed with the app's EdDSA key (`jwks_uri`), `aud` = the app's MCP address,
 *   ten minutes; bound to the client's key (`cnf.jkt`, RFC 9449 DPoP) when the token request carries a proof.
 * - Refresh tokens rotated on every use; a used one presented again ends the link (reuse detection). RFC 7009.
 * - `response_mode=web_message`: inside a framing client (Clegra's frame) the answer is posted to the parent, only to
 *   the configured client origins.
 * - Personal keys: an opaque key the person makes in the app for background work (an automation, a script), bound to
 *   them and to scopes, kept as a hash.
 * - Scopes are the app's permissions; what a token allows is read live on every call: the person's permissions now
 *   (`permissionsOf`), narrowed to the link's scopes. A person who left (null) is refused at once.
 *
 * Web APIs only (Fetch, Web Crypto, jose): it runs on Node, Deno, Bun and edge runtimes.
 */
import { calculateJwkThumbprint, createLocalJWKSet, decodeJwt, decodeProtectedHeader, exportJWK, generateKeyPair, importJWK, jwtVerify, SignJWT, type CryptoKey, type JWK, type JWTPayload } from "jose"

import { AuthError, CLIENT_ASSERTION_ALGS, ClientDirectory, ClientMetadataError, isClientMetadataUrl, redirectUriAllowed, type ClientMetadata, type ClientMetadataTransport, type ResolvedCaller } from "../auth"
import { checkDpopProof, DPOP_ALGS, DpopError } from "../dpop"
import { localize, type Label } from "../labels"
import { base64url, randomToken, sha256 } from "./crypto"
import { escapeHtml, hidden, page, pageLocale, textsOf, type PageLocale } from "./pages"
import type { SignInStore } from "./store"

export { MemorySignInStore, SqlSignInStore, type SignInStore } from "./store"
export { hashPassword, verifyPassword } from "./crypto"
export { passwordLogin, type PasswordAccount, type PasswordLogin, type PasswordLoginOptions } from "./password"
export { frameCookie } from "./cookies"

// ------------------------------------------------------------------ types

/** A person of the app, as its own login knows them. `installation` is their tenant in the app (an organization, a workspace). */
export type SignInAccount = { id: string; name: string; email?: string; installation: string }

/** The app's own login, under the module: who is signed in on a request, and where its sign-in page is. */
export type Login = {
  /** Who is signed in on this request (the app's own session), or null. */
  session(request: Request): Promise<SignInAccount | null> | SignInAccount | null
  /** The app's sign-in page, coming back to `returnTo` (a path and query on the app) once signed in. */
  signInUrl(returnTo: string, request: Request): string
  /** The login's own routes, when it serves them (the password login does). */
  fetch?(request: Request): Promise<Response | null> | Response | null
}

/** What the module reads of the app: its name, title and permissions (its definition, `defineApp`). */
export type SignInApp = { name: string; locale: string; manifest(): { title: Record<string, string>; permissions: { id: string; label: Record<string, string>; description?: Record<string, string> }[] } }

export type SignInOptions = {
  /** This authorization server's issuer: the app's public origin (`https://crm.example.com`), https except on a loopback address. */
  issuer: string
  /** The app's MCP address (`https://crm.example.com/mcp`): the one audience of the tokens. */
  resource: string
  login: Login
  /**
   * What the person may do in the app NOW (its permission ids, or "all"), read on every call: null when they may not
   * use the app any more (left, disabled), which refuses every token and key of theirs at once.
   */
  permissionsOf(account: SignInAccount): Promise<readonly string[] | "all" | null> | readonly string[] | "all" | null
  store: SignInStore
  /**
   * The app's signing keys as private JWKs (Ed25519), the first signing, the others still verifying (rotation);
   * `newSignInKey()` makes one. Required in production; without it, in development, a key in memory.
   */
  keys?: JWK[]
  /** The origins of the clients that frame the app (Clegra's web and desktop clients): where a `web_message` answer goes, who may frame the consent. */
  clientOrigins?: string[]
  /** The words of the consent page, default the app's title. */
  title?: Label
  accessTokenSeconds?: number
  refreshTokenDays?: number
  /** For tests: how client metadata documents are fetched. */
  clientMetadata?: ClientMetadataTransport
}

/** A delegation the app issued: one client acting for one person, until revoked. */
export type SignInLink = { id: string; client: string; clientName: string | null; scope: string; createdAt: string; usedAt: string | null; bound: boolean }
/** A personal key, as listed (the key itself is shown once, when made). */
export type PersonalKey = { id: string; name: string; scope: string; createdAt: string; usedAt: string | null; expiresAt: string | null }

export type SignIn = {
  readonly issuer: string
  readonly resource: string
  /** The authorization servers to name in the protected-resource metadata: this one. */
  readonly authorizationServers: string[]
  /** Answers the module's paths (metadata, authorize, token, revoke, keys, the login's own); null for any other. */
  fetch(request: Request): Promise<Response | null>
  /** Verifies a token or a personal key of this module (`serve`'s `auth.signIn` uses it). Null when it is not one. */
  resolve(token: string, request: Request, info: { resource: string; scheme: "Bearer" | "DPoP" }): Promise<ResolvedCaller | null>
  /** Personal keys, for the app's own settings screen. */
  keys: {
    create(account: SignInAccount, input: { name: string; scopes?: string[]; expiresInDays?: number }): Promise<{ key: string; id: string }>
    list(account: SignInAccount): Promise<PersonalKey[]>
    revoke(account: SignInAccount, id: string): Promise<boolean>
  }
  /** The clients that act for a person, for the app's own «connected apps» screen. */
  links: {
    list(account: SignInAccount): Promise<SignInLink[]>
    revoke(account: SignInAccount, id: string): Promise<boolean>
  }
  /** A person who left: every link and key of theirs ends now. */
  forget(account: SignInAccount): Promise<void>
}

// ------------------------------------------------------------------ constants

export const AUTHORIZE_PATH = "/oauth/authorize"
export const TOKEN_PATH = "/oauth/token"
export const REVOKE_PATH = "/oauth/revoke"
export const JWKS_PATH = "/oauth/jwks.json"
export const OFFLINE_SCOPE = "offline_access"
/** Personal keys start with this, so they are never mistaken for a JWT. */
export const PERSONAL_KEY_PREFIX = "cpk_"
const CONSENT_SECONDS = 10 * 60
const CODE_SECONDS = 60
const SKEW = 30

type Pending = { client: string; clientName: string | null; redirect: string; state: string; challenge: string; scope: string; mode: "query" | "web_message"; account: SignInAccount; locale: PageLocale }
type Code = { client: string; redirect: string; challenge: string; scope: string; account: SignInAccount }
type LinkRecord = { id: string; client: string; clientName: string | null; scope: string; account: SignInAccount; refresh: string; jkt: string | null; createdAt: string; usedAt: string | null }
type KeyRecord = { id: string; name: string; scope: string; account: SignInAccount; createdAt: string; usedAt: string | null; expiresAt: string | null }

const enc = encodeURIComponent
const accountKey = (a: Pick<SignInAccount, "installation" | "id">) => `${enc(a.installation)}:${enc(a.id)}`
const isProduction = () => (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.NODE_ENV === "production"
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

// ------------------------------------------------------------------ the module

export function createSignIn(app: SignInApp, options: SignInOptions): SignIn {
  const issuer = checkUrl(options.issuer, "issuer").toString().replace(/\/$/, "")
  const resource = checkUrl(options.resource, "resource").toString()
  if (new URL(resource).origin !== new URL(issuer).origin) throw new Error("signIn: the resource (the MCP address) must be on the issuer's origin: one app, one origin")
  if (isProduction() && !options.keys?.length) throw new Error("signIn.keys: give the app's signing key in production (newSignInKey() makes one); a key in memory would sign everyone out at every restart")
  const clientOrigins = (options.clientOrigins ?? []).map((o) => {
    const u = checkUrl(o, "clientOrigins")
    if (u.pathname !== "/") throw new Error(`signIn clientOrigins: "${o}" must be an origin, without a path`)
    return u.origin
  })
  const issuerPath = new URL(issuer).pathname.replace(/\/$/, "")
  const at = (path: string) => `${issuer}${path}`
  const accessSeconds = options.accessTokenSeconds ?? 600
  const refreshMs = (options.refreshTokenDays ?? 30) * 24 * 3600_000
  const store = options.store
  const directory = new ClientDirectory(options.clientMetadata)
  const memory = { once: (k: string, ttl: number) => store.once(k, ttl), get: (k: string) => store.get(k), set: (k: string, v: unknown, ttl: number | null) => store.set(k, v, ttl) }

  // The keys: imported once.
  type Keys = { signing: { key: CryptoKey; kid: string }; verify: ReturnType<typeof createLocalJWKSet>; public: JWK[] }
  let keys: Promise<Keys> | null = null
  const loadKeys = (): Promise<Keys> =>
    (keys ??= (async () => {
      let given = options.keys ?? []
      if (!given.length) {
        console.warn(`[clegra] signIn.keys is not set: a key in memory signs the tokens (development only; everyone is signed out at restart)`)
        given = [JSON.parse(await newSignInKey()) as JWK]
      }
      const pub: JWK[] = []
      for (const jwk of given) {
        if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || !jwk.d) throw new Error("signIn.keys: each key is a private Ed25519 JWK (newSignInKey())")
        const { d: _d, ...p } = jwk
        pub.push({ ...p, kid: jwk.kid ?? (await calculateJwkThumbprint(p, "sha256")).slice(0, 16), alg: "EdDSA", use: "sig" })
      }
      const first = given[0]!
      return { signing: { key: (await importJWK(first, "EdDSA")) as CryptoKey, kid: pub[0]!.kid! }, verify: createLocalJWKSet({ keys: pub }), public: pub }
    })())

  const permissionScopes = () => app.manifest().permissions.map((p) => p.id)
  const scopesSupported = () => [...permissionScopes(), OFFLINE_SCOPE]
  const title = (locale: string) => (options.title ? localize(options.title, locale, app.locale) : (app.manifest().title[locale] ?? app.manifest().title[app.locale] ?? Object.values(app.manifest().title)[0] ?? app.name))

  /** The scopes asked, checked: the app's permissions (none asked: all of them), plus offline_access. Null when one is unknown. */
  const scopeOf = (asked: string): string | null => {
    const known = new Set(scopesSupported())
    const names = asked.split(" ").filter(Boolean)
    if (names.some((n) => !known.has(n))) return null
    const permissions = names.filter((n) => n !== OFFLINE_SCOPE)
    return [...(permissions.length ? permissions : permissionScopes()), ...(names.includes(OFFLINE_SCOPE) ? [OFFLINE_SCOPE] : [])].join(" ")
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
    response_modes_supported: ["query", "web_message"],
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

  // ---------------------------------------------------------------- authorize

  const errorPage = (locale: PageLocale, why: string, status = 400) => {
    const t = textsOf(locale)
    return page({ title: t.error, locale, status, frameAncestors: clientOrigins, body: `<h1>${escapeHtml(t.error)}</h1><p class="e">${escapeHtml(why)}</p><p class="m">${escapeHtml(t.nothingSent)}</p>` })
  }

  /** The answer to the client: a redirect, or a message posted to the framing client. */
  const answer = (p: Pick<Pending, "redirect" | "state" | "mode" | "clientName" | "client" | "locale">, params: Record<string, string>) => {
    const fields = { ...params, ...(p.state ? { state: p.state } : {}), iss: issuer }
    if (p.mode === "web_message") {
      const t = textsOf(p.locale)
      const message = JSON.stringify({ type: "authorization_response", response: fields }).replace(/</g, "\\u003c")
      const targets = JSON.stringify(clientOrigins)
      const done = params.code ? t.linked(p.clientName ?? new URL(p.client).host) : t.error
      return page({ title: done, locale: p.locale, frameAncestors: clientOrigins, body: `<p>${escapeHtml(done)}</p>`, script: `(()=>{const m=${message};const w=window.opener||window.parent;if(w&&w!==window)for(const o of ${targets})w.postMessage(m,o)})()` })
    }
    const back = new URL(p.redirect)
    for (const [k, v] of Object.entries(fields)) back.searchParams.set(k, v)
    return new Response(null, { status: 303, headers: { location: back.toString(), "cache-control": "no-store" } })
  }

  async function authorize(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (request.method === "POST") return decide(request)
    if (request.method !== "GET") return new Response(null, { status: 405, headers: { allow: "GET, POST" } })
    const q = (k: string) => url.searchParams.get(k) ?? ""
    const locale = pageLocale(request, url.searchParams.get("ui_locales"), app.locale)
    // Who asks, first: until the client and its redirect address are known good, nothing is sent anywhere.
    const clientId = q("client_id")
    if (!isClientMetadataUrl(clientId)) return errorPage(locale, "client_id must be the https address of the client's metadata document (Client ID Metadata Document)")
    let client: ClientMetadata
    try {
      client = await directory.client(clientId)
    } catch (error) {
      return errorPage(locale, error instanceof ClientMetadataError ? error.message : "the client's metadata document could not be read")
    }
    const redirect = q("redirect_uri")
    if (!redirectUriAllowed(redirect, client.redirect_uris)) return errorPage(locale, "redirect_uri is not one of the client's redirect_uris")
    const mode = q("response_mode") === "web_message" ? "web_message" : "query"
    if (q("response_mode") && q("response_mode") !== "query" && mode !== "web_message") return errorPage(locale, "response_mode must be query or web_message")
    if (mode === "web_message" && !clientOrigins.length) return errorPage(locale, "this app frames no client (clientOrigins): web_message is not available")
    const base = { redirect, state: q("state"), mode, clientName: client.client_name ?? null, client: clientId, locale } as const
    const refuse = (error: string, description: string) => answer(base, { error, error_description: description })
    if (q("response_type") !== "code") return refuse("unsupported_response_type", "response_type must be code")
    if (!/^[A-Za-z0-9_-]{43}$/.test(q("code_challenge")) || q("code_challenge_method") !== "S256") return refuse("invalid_request", "a S256 code_challenge is required (PKCE)")
    if (url.searchParams.has("resource") && checkResource(q("resource")) !== resource) return refuse("invalid_target", `the resource must be ${resource}`)
    const scope = scopeOf(q("scope"))
    if (scope === null) return refuse("invalid_scope", `scopes are among ${scopesSupported().join(" ")}`)
    const account = await options.login.session(request)
    if (!account) {
      const returnTo = `${url.pathname}${url.search}`
      return new Response(null, { status: 303, headers: { location: new URL(options.login.signInUrl(returnTo, request), issuer).toString(), "cache-control": "no-store" } })
    }
    if ((await options.permissionsOf(account)) === null) return refuse("access_denied", "this account may not use the app")
    const id = randomToken()
    await store.set(`consent:${await sha256(id)}`, { ...base, challenge: q("code_challenge"), scope, account } satisfies Pending, CONSENT_SECONDS * 1000)
    return consentPage(locale, { id, client, scope, account })
  }

  function consentPage(locale: PageLocale, input: { id: string; client: ClientMetadata; scope: string; account: SignInAccount }): Response {
    const t = textsOf(locale)
    const appTitle = title(locale)
    const clientName = input.client.client_name ?? new URL(input.client.client_id).host
    const labels = new Map(app.manifest().permissions.map((p) => [p.id, p.label[locale] ?? p.label[app.locale] ?? Object.values(p.label)[0] ?? p.id]))
    const asked = input.scope.split(" ").filter((s) => s !== OFFLINE_SCOPE)
    const all = asked.length === labels.size
    const list = all ? `<li>${escapeHtml(t.everything)}</li>` : asked.map((s) => `<li>${escapeHtml(labels.get(s) ?? s)}</li>`).join("")
    return page({
      title: t.consentTitle(clientName, appTitle),
      locale,
      frameAncestors: clientOrigins,
      body: `<h1>${escapeHtml(t.consentTitle(clientName, appTitle))}</h1><p class="m">${escapeHtml(t.signedInAs(input.account.name))}</p>
<p>${escapeHtml(t.consentLead(appTitle))}</p><ul>${list}</ul>
<p class="c"><span class="m">${escapeHtml(t.consentFrom)}</span><br>${escapeHtml(input.client.client_id)}</p>
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
    const account = await options.login.session(request)
    if (!account || account.id !== pending.account.id || account.installation !== pending.account.installation) return errorPage(pending.locale, "the consent was opened by someone else", 403)
    if (form.get("decision") !== "allow") return answer(pending, { error: "access_denied", error_description: "the person did not allow it" })
    const code = randomToken()
    await store.set(`code:${await sha256(code)}`, { client: pending.client, redirect: pending.redirect, challenge: pending.challenge, scope: pending.scope, account } satisfies Code, CODE_SECONDS * 1000)
    return answer(pending, { code })
  }

  const checkResource = (value: string) => {
    try {
      return new URL(value).toString()
    } catch {
      return null
    }
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

  async function issue(link: LinkRecord): Promise<Response> {
    const k = await loadKeys()
    const now = Math.floor(Date.now() / 1000)
    const permissions = link.scope.split(" ").filter((s) => s !== OFFLINE_SCOPE).join(" ")
    const access = await new SignJWT({ client_id: link.client, scope: permissions, sid: link.id, installation: link.account.installation, name: link.account.name, ...(link.jkt ? { cnf: { jkt: link.jkt } } : {}) })
      .setProtectedHeader({ alg: "EdDSA", typ: "at+jwt", kid: k.signing.kid })
      .setIssuer(issuer)
      .setSubject(link.account.id)
      .setAudience(resource)
      .setIssuedAt(now)
      .setExpirationTime(now + accessSeconds)
      .setJti(randomToken(16))
      .sign(k.signing.key)
    const refresh = randomToken()
    const hash = await sha256(refresh)
    await store.set(`link:${accountKey(link.account)}:${link.id}`, { ...link, refresh: hash }, refreshMs)
    await store.set(`refresh:${hash}`, { link: link.id, account: link.account }, refreshMs)
    return json({ access_token: access, token_type: link.jkt ? "DPoP" : "Bearer", expires_in: accessSeconds, refresh_token: refresh, scope: permissions })
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
      if ((await options.permissionsOf(code.account)) === null) return oauthError("invalid_grant", "this account may not use the app")
      const link: LinkRecord = { id: randomToken(12), client: client.client_id, clientName: client.client_name ?? null, scope: code.scope, account: code.account, refresh: "", jkt, createdAt: new Date().toISOString(), usedAt: null }
      return issue(link)
    }
    if (grant === "refresh_token") {
      const presented = form.get("refresh_token") ?? ""
      const hash = await sha256(presented)
      const entry = (await store.get(`refresh:${hash}`)) as { link: string; account: SignInAccount } | null
      if (!entry) return oauthError("invalid_grant", "unknown or expired refresh token")
      const key = `link:${accountKey(entry.account)}:${entry.link}`
      const link = (await store.get(key)) as LinkRecord | null
      if (!link) return oauthError("invalid_grant", "this link was removed")
      if (link.client !== client.client_id) return oauthError("invalid_grant", "the refresh token was issued to another client")
      if (link.refresh !== hash) {
        // A refresh token used twice: someone else holds a copy. The link ends for both.
        await endLink(link)
        return oauthError("invalid_grant", "this refresh token was already used: the link is revoked")
      }
      if (link.jkt && jkt !== link.jkt) return oauthError("invalid_grant", "the refresh token is bound to the client's DPoP key: send a proof signed by it")
      // Two requests with the same refresh token: the first wins, the second is reuse. The old hash stays known,
      // pointing at the link, so a later use is detected too.
      if (!(await store.once(`refreshed:${hash}`, refreshMs))) {
        await endLink(link)
        return oauthError("invalid_grant", "this refresh token was already used: the link is revoked")
      }
      if ((await options.permissionsOf(link.account)) === null) {
        await endLink(link)
        return oauthError("invalid_grant", "this account may not use the app any more")
      }
      return issue({ ...link, usedAt: new Date().toISOString() })
    }
    return oauthError("unsupported_grant_type", "authorization_code or refresh_token")
  }

  async function endLink(link: Pick<LinkRecord, "id" | "account">) {
    const key = `link:${accountKey(link.account)}:${link.id}`
    const kept = (await store.get(key)) as LinkRecord | null
    await store.delete(key)
    if (kept?.refresh) await store.delete(`refresh:${kept.refresh}`)
  }

  async function revoke(request: Request): Promise<Response> {
    if (request.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } })
    const form = new URLSearchParams(await request.text())
    const client = await clientOf(form)
    if (client instanceof Response) return client
    const value = form.get("token") ?? ""
    // RFC 7009 §2.2: unknown tokens are answered 200 as well.
    const entry = (await store.get(`refresh:${await sha256(value)}`)) as { link: string; account: SignInAccount } | null
    if (entry) {
      const link = (await store.get(`link:${accountKey(entry.account)}:${entry.link}`)) as LinkRecord | null
      if (link && link.client === client.client_id) await endLink(link)
    } else if (value.split(".").length === 3) {
      try {
        const { payload } = await jwtVerify(value, (await loadKeys()).verify, { issuer, audience: resource, typ: "at+jwt" })
        if (payload.client_id === client.client_id && typeof payload.sid === "string") await endLink({ id: payload.sid, account: { id: String(payload.sub), installation: String(payload.installation), name: "" } })
      } catch {}
    }
    return new Response(null, { status: 200, headers: { "cache-control": "no-store" } })
  }

  // ---------------------------------------------------------------- the resource's side

  async function resolve(tokenValue: string, request: Request, info: { resource: string; scheme: "Bearer" | "DPoP" }): Promise<ResolvedCaller | null> {
    if (tokenValue.startsWith(PERSONAL_KEY_PREFIX)) {
      if (info.scheme !== "Bearer") throw new AuthError("a personal key is sent as Authorization: Bearer")
      const record = (await store.get(`pkey:${await sha256(tokenValue)}`)) as KeyRecord | null
      if (!record) throw new AuthError("unknown or revoked personal key")
      if (record.expiresAt && Date.parse(record.expiresAt) <= Date.now()) throw new AuthError("this personal key has expired")
      const caller = await callerOf(record.account, record.scope)
      if (!record.usedAt || Date.now() - Date.parse(record.usedAt) > 3600_000) {
        const hash = await sha256(tokenValue)
        await store.set(`pkey:${hash}`, { ...record, usedAt: new Date().toISOString() }, record.expiresAt ? Math.max(1, Date.parse(record.expiresAt) - Date.now()) : null)
      }
      return caller
    }
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
    const account: SignInAccount = { id: String(payload.sub), installation: String(payload.installation ?? ""), name: String(payload.name ?? "") }
    // The link must still exist: revoking it in the app ends its tokens at once, not in ten minutes.
    const link = (await store.get(`link:${accountKey(account)}:${String(payload.sid)}`)) as LinkRecord | null
    if (!link) throw new AuthError("this access was revoked")
    return callerOf(link.account, typeof payload.scope === "string" ? payload.scope : "")
  }

  async function callerOf(account: SignInAccount, scope: string): Promise<ResolvedCaller> {
    const now = await options.permissionsOf(account)
    if (now === null) throw new AuthError("this account may not use the app any more")
    const granted = new Set(scope.split(" ").filter(Boolean))
    const permissions = (now === "all" ? permissionScopes() : [...now]).filter((p) => granted.has(p))
    return { installation: account.installation, person: { id: account.id, name: account.name }, permissions, subject: account.id }
  }

  // ---------------------------------------------------------------- keys and links

  const keysApi: SignIn["keys"] = {
    async create(account, input) {
      const name = input.name.trim().slice(0, 80)
      if (!name) throw new Error("a personal key needs a name")
      const scope = scopeOf((input.scopes ?? []).join(" "))
      if (scope === null) throw new Error(`scopes are among ${permissionScopes().join(" ")}`)
      const key = `${PERSONAL_KEY_PREFIX}${randomToken()}`
      const hash = await sha256(key)
      const id = randomToken(9)
      const ttl = input.expiresInDays ? input.expiresInDays * 24 * 3600_000 : null
      const record: KeyRecord = { id, name, scope: scope.split(" ").filter((s) => s !== OFFLINE_SCOPE).join(" "), account, createdAt: new Date().toISOString(), usedAt: null, expiresAt: ttl ? new Date(Date.now() + ttl).toISOString() : null }
      await store.set(`pkey:${hash}`, record, ttl)
      await store.set(`pkeys:${accountKey(account)}:${id}`, hash, ttl)
      return { key, id }
    },
    async list(account) {
      const out: PersonalKey[] = []
      for (const { value } of await store.list(`pkeys:${accountKey(account)}:`)) {
        const r = (await store.get(`pkey:${String(value)}`)) as KeyRecord | null
        if (r) out.push({ id: r.id, name: r.name, scope: r.scope, createdAt: r.createdAt, usedAt: r.usedAt, expiresAt: r.expiresAt })
      }
      return out
    },
    async revoke(account, id) {
      const hash = (await store.take(`pkeys:${accountKey(account)}:${id}`)) as string | null
      if (!hash) return false
      await store.delete(`pkey:${hash}`)
      return true
    },
  }

  const linksApi: SignIn["links"] = {
    async list(account) {
      return (await store.list(`link:${accountKey(account)}:`)).map(({ value }) => {
        const l = value as LinkRecord
        return { id: l.id, client: l.client, clientName: l.clientName, scope: l.scope, createdAt: l.createdAt, usedAt: l.usedAt, bound: Boolean(l.jkt) }
      })
    },
    async revoke(account, id) {
      const key = `link:${accountKey(account)}:${id}`
      if (!(await store.get(key))) return false
      await endLink({ id, account })
      return true
    },
  }

  return {
    issuer,
    resource,
    authorizationServers: [issuer],
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
      return (await options.login.fetch?.(request)) ?? null
    },
    resolve,
    keys: keysApi,
    links: linksApi,
    async forget(account) {
      for (const l of await linksApi.list(account)) await endLink({ id: l.id, account })
      for (const k of await keysApi.list(account)) await keysApi.revoke(account, k.id)
    },
  }
}

/** For hosts and tests: base64url SHA-256 of a PKCE verifier (the S256 challenge). */
export const pkceChallenge = (verifier: string) => sha256(verifier)
export { base64url }
