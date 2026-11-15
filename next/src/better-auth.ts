import { oauthProviderAuthServerMetadata, oauthProviderOpenIdConfigMetadata } from "@better-auth/oauth-provider"
import { getBaseURL } from "better-auth"
import { createLocalJWKSet, decodeProtectedHeader, errors as joseErrors, jwtVerify, type JWK, type JWTPayload } from "jose"

import { AuthError, type CallerResolver, type Person, type ResolvedCaller } from "@modelapp/server"

/**
 * `@modelapp/next/better-auth`: better-auth (its MCP plugin) as the app's authorization server, its access tokens
 * verified by the app itself:
 *
 * ```ts
 * const bridge = betterAuthBridge(auth, { caller: ({ roles }) => ({ permissions: roles.includes("owner") ? "all" : ["deals.view"] }) })
 * defineApp({ auth: { ...bridge, resource }, … })
 * ```
 *
 * `resolve` accepts only a JWT access token (`typ: at+jwt`) signed with the instance's own keys (its JWKS, read
 * in-process), issued by its issuer for exactly this server (`aud` = `auth.resource`, RFC 8707), not expired
 * (30 s of clock skew), not sender-bound (`cnf`, DPoP). The person and their membership of the token's
 * organization are then read LIVE from the database: a deleted or banned user, or a membership removed after the
 * token was issued, has no access; a changed role changes the permissions on the next call.
 */

/** The scope MAP apps announce in their protected-resource metadata (`OAUTH_SCOPE` of @modelapp/spec). */
export const MODELAPP_SCOPE = "modelapp"

/** The JWS algorithms better-auth's jwt plugin signs with (all asymmetric). */
const ALGORITHMS = ["EdDSA", "ES256", "ES512", "PS256", "RS256"]
const CLOCK_SKEW_SECONDS = 30
/** The shortest pause between two key-set refetches for an unknown key id (rotation), so random kids can't hammer the database. */
const JWKS_REFETCH_MS = 10_000

type Where = { field: string; value: unknown }
type AuthContextLike = {
  baseURL: string
  adapter: { findOne: <T>(query: { model: string; where: Where[] }) => Promise<T | null> }
  internalAdapter: { findUserById: (id: string) => Promise<BetterAuthUser | null> }
}
type PluginLike = { id: string; options?: Record<string, unknown> }

/** What the bridge needs of a better-auth instance (`betterAuth({ … })`): any instance with the canonical plugins fits. */
export type BetterAuthInstance = {
  options: { baseURL?: unknown; basePath?: string; plugins?: unknown[] }
  $context: Promise<unknown>
  api: {
    getJwks: (...args: never[]) => Promise<unknown>
    getOAuthServerConfig: (...args: never[]) => unknown
    getOpenIdConfig: (...args: never[]) => unknown
  }
}

/** A better-auth user as the database holds it (fields of other plugins included). */
export type BetterAuthUser = { id: string; name: string; email: string; emailVerified?: boolean; image?: string | null; banned?: boolean | null; banExpires?: Date | string | null } & Record<string, unknown>

/** A row of the organization plugin's `member` table. */
export type BetterAuthMember = { id: string; organizationId: string; userId: string; role: string; createdAt?: Date } & Record<string, unknown>

/** What `caller` is told: the verified token and what the database says now. */
export type BridgeCallerInput = {
  /** The access token's verified claims. */
  claims: JWTPayload & { scope?: string; client_id?: string; azp?: string }
  userId: string
  /** The user, loaded now (not from the token). */
  user: BetterAuthUser
  /** The organization the token was issued for (its claim), checked against a live membership. */
  organizationId: string
  /** The membership, loaded now. */
  member: BetterAuthMember
  /** `member.role` split (the organization plugin stores several roles comma-separated). */
  roles: string[]
  /** The OAuth client the person connected (`client_id`; a URL for a metadata-document client). */
  clientId: string | null
  request: Request
}

/** What `caller` answers: null refuses the call. */
export type BridgeCallerResult = {
  /** The tenant handlers scope every read and write by (default: the organization id). */
  installation?: string
  permissions: readonly string[] | "all"
  locale?: string
  /** Default `{ id: user.id, name: user.name }`; null for no person. */
  person?: Person | null
}

export type BetterAuthBridgeOptions = {
  /** Maps the verified caller to what the app allows: typically the permissions of the member's role. */
  caller: (input: BridgeCallerInput) => BridgeCallerResult | null | Promise<BridgeCallerResult | null>
  /** The access-token claim that names the organization (set by `customAccessTokenClaims` in the mcp plugin). Default `org`. */
  organizationClaim?: string
  /**
   * The scope a token must carry (default `modelapp`, the scope the app's protected-resource metadata announces;
   * list it in the mcp plugin's `scopes`). `null`: any scope.
   */
  scope?: string | null
}

export type BetterAuthBridge = {
  resolve: CallerResolver
  /** The better-auth issuer (`<baseURL>/api/auth`, or the jwt plugin's `jwt.issuer`), named in the protected-resource metadata. */
  authorizationServers: string[]
  /** Answers the issuer's metadata at the root (RFC 8414 and OpenID discovery for an issuer with a path); null for any other request. */
  serve: (request: Request) => Promise<Response | null>
}

const pluginOf = (auth: BetterAuthInstance, id: string) => (auth.options.plugins ?? []).find((p): p is PluginLike => typeof p === "object" && p !== null && (p as PluginLike).id === id)

/** The issuer better-auth's access tokens carry, from the configuration (what `getIssuer` of oauth-provider computes at run time). */
function issuerOf(auth: BetterAuthInstance): string {
  const jwtIssuer = (pluginOf(auth, "jwt")?.options?.jwt as { issuer?: unknown } | undefined)?.issuer
  if (typeof jwtIssuer === "string" && jwtIssuer) return jwtIssuer
  if (typeof auth.options.baseURL !== "string" && auth.options.baseURL !== undefined) {
    throw new Error("betterAuthBridge: a dynamic baseURL (allowedHosts) gives tokens no fixed issuer; set baseURL to the public URL, or jwt({ jwt: { issuer } })")
  }
  const base = getBaseURL(auth.options.baseURL as string | undefined, auth.options.basePath)
  if (!base) throw new Error("betterAuthBridge: better-auth has no baseURL (set baseURL or BETTER_AUTH_URL to the site's public URL)")
  return base
}

function checkPlugins(auth: BetterAuthInstance) {
  const missing = [["jwt", "jwt({ disableSettingJwtHeader: true })"], ["oauth-provider", "mcp({ … }) from @better-auth/mcp"], ["organization", "organization()"]].filter(([id]) => !pluginOf(auth, id!))
  if (missing.length) throw new Error(`betterAuthBridge: better-auth needs the plugins ${missing.map(([, how]) => how).join(", ")}`)
  if (pluginOf(auth, "oauth-provider")?.options?.disableJwtPlugin) throw new Error("betterAuthBridge: the mcp plugin has disableJwtPlugin: its access tokens are opaque; the bridge verifies JWT access tokens")
}

export function betterAuthBridge(auth: BetterAuthInstance, options: BetterAuthBridgeOptions): BetterAuthBridge {
  if (typeof options?.caller !== "function") throw new Error("betterAuthBridge: give caller(input) → { permissions, … } | null")
  checkPlugins(auth)
  const issuer = issuerOf(auth)
  const claim = options.organizationClaim ?? "org"
  const scope = options.scope === undefined ? MODELAPP_SCOPE : options.scope
  const provider = pluginOf(auth, "oauth-provider")!.options ?? {}
  const knownResources = new Set(((provider.resources as (string | { identifier: string })[] | undefined) ?? []).map((r) => (typeof r === "string" ? r : r.identifier)))

  // The instance's keys, read in-process and cached; read again (at most every 10 s) when a token names a key id not in them.
  let keys: { set: ReturnType<typeof createLocalJWKSet>; at: number } | null = null
  const loadKeys = async () => {
    const jwks = (await auth.api.getJwks()) as { keys?: JWK[] } | null
    if (!jwks?.keys?.length) throw new Error("betterAuthBridge: the jwt plugin has no keys yet (auth.api.getJwks() is empty)")
    keys = { set: createLocalJWKSet({ keys: jwks.keys }), at: Date.now() }
    return keys
  }
  const verify = async (token: string, resource: string) => {
    const check = (set: ReturnType<typeof createLocalJWKSet>) =>
      jwtVerify(token, set, { issuer, audience: resource, typ: "at+jwt", algorithms: ALGORITHMS, clockTolerance: CLOCK_SKEW_SECONDS, requiredClaims: ["sub", "exp", "iat", "aud"] })
    const current = keys ?? (await loadKeys())
    try {
      return await check(current.set)
    } catch (error) {
      if (!(error instanceof joseErrors.JWKSNoMatchingKey) || Date.now() - current.at < JWKS_REFETCH_MS) throw error
      return await check((await loadKeys()).set)
    }
  }
  let context: Promise<AuthContextLike> | null = null
  const contextOf = () =>
    (context ??= (auth.$context as Promise<AuthContextLike>).then((ctx) => {
      // The issuer better-auth computes at run time must be the one named in the metadata: a mismatch is a configuration error.
      const runtime = ctx.baseURL
      const jwtIssuer = (pluginOf(auth, "jwt")?.options?.jwt as { issuer?: string } | undefined)?.issuer
      if (!jwtIssuer && runtime && runtime !== issuer) throw new Error(`betterAuthBridge: better-auth runs at ${runtime}, the bridge expected ${issuer}`)
      return ctx
    }))

  const resolve: CallerResolver = async (token, request, { resource }) => {
    if (knownResources.size && !knownResources.has(resource)) {
      throw new Error(`betterAuthBridge: this server's resource ${resource} is not the mcp plugin's resource (${[...knownResources].join(", ")}): give the same URL to mcp({ resource }) and defineApp({ auth: { resource } })`)
    }
    let header: ReturnType<typeof decodeProtectedHeader>
    try {
      header = decodeProtectedHeader(token)
    } catch {
      throw new AuthError("not a JWT access token: ask for this server as the resource (RFC 8707) so better-auth issues one")
    }
    if (typeof header.alg !== "string" || !ALGORITHMS.includes(header.alg)) throw new AuthError(`access tokens signed with ${String(header.alg)} are not accepted`)
    let claims: BridgeCallerInput["claims"]
    try {
      claims = (await verify(token, resource)).payload as BridgeCallerInput["claims"]
    } catch (error) {
      if (error instanceof joseErrors.JWTExpired) throw new AuthError("the access token has expired")
      if (error instanceof joseErrors.JWTClaimValidationFailed) throw new AuthError(error.claim === "aud" ? "the access token is for another server" : `the access token's ${error.claim} is not valid here`)
      if (error instanceof joseErrors.JOSEError) throw new AuthError("the access token is not valid")
      throw error
    }
    // RFC 8707: issued for this server alone. A token for several audiences could be replayed here by any of them.
    if (Array.isArray(claims.aud) && claims.aud.length !== 1) throw new AuthError("the access token is for several servers; ask for this one alone")
    if (claims.cnf !== undefined) throw new AuthError("sender-constrained (DPoP) access tokens are not accepted")
    if (scope && !(typeof claims.scope === "string" && claims.scope.split(" ").includes(scope))) throw new AuthError(`the access token lacks the ${scope} scope`)
    const clientId = typeof claims.client_id === "string" ? claims.client_id : typeof claims.azp === "string" ? claims.azp : null
    if (!clientId) throw new AuthError("the access token names no client")
    const userId = claims.sub!
    const organizationId = claims[claim]
    if (typeof organizationId !== "string" || !organizationId) throw new AuthError(`the access token names no organization (claim ${claim})`)

    const ctx = await contextOf()
    const user = await ctx.internalAdapter.findUserById(userId)
    if (!user) throw new AuthError("the user no longer exists")
    if (user.banned === true && (!user.banExpires || new Date(user.banExpires).getTime() > Date.now())) throw new AuthError("the user is banned")
    const member = await ctx.adapter.findOne<BetterAuthMember>({ model: "member", where: [{ field: "organizationId", value: organizationId }, { field: "userId", value: userId }] })
    if (!member) throw new AuthError("the user is not a member of the token's organization")
    const roles = String(member.role ?? "").split(",").map((r) => r.trim()).filter(Boolean)

    const answer = await options.caller({ claims, userId, user, organizationId, member, roles, clientId, request })
    if (!answer) throw new AuthError("the app refused this caller")
    const person = answer.person === undefined ? { id: user.id, name: user.name } : answer.person
    return { installation: answer.installation ?? organizationId, person, permissions: answer.permissions, subject: user.id, ...(answer.locale ? { locale: answer.locale } : {}) } satisfies ResolvedCaller
  }

  const issuerPath = new URL(issuer).pathname.replace(/\/+$/, "")
  const authServerMetadata = oauthProviderAuthServerMetadata(auth as never)
  const openIdMetadata = oauthProviderOpenIdConfigMetadata(auth as never)
  const openid = ((provider.scopes as string[] | undefined) ?? ["openid"]).includes("openid")
  const serve = async (request: Request): Promise<Response | null> => {
    const path = new URL(request.url).pathname
    const asMetadata = path === `/.well-known/oauth-authorization-server${issuerPath}`
    const oidcMetadata = openid && path === `/.well-known/openid-configuration${issuerPath}`
    if (!asMetadata && !oidcMetadata) return null
    if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { status: 405, headers: { allow: "GET, HEAD" } })
    const response = await (asMetadata ? authServerMetadata : openIdMetadata)(request)
    return request.method === "HEAD" ? new Response(null, { status: response.status, headers: response.headers }) : response
  }

  return { resolve, authorizationServers: [issuer], serve }
}
