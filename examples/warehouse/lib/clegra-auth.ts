import { oauthProviderAuthServerMetadata, oauthProviderOpenIdConfigMetadata } from "@better-auth/oauth-provider"
import { createLocalJWKSet, decodeProtectedHeader, errors, jwtVerify, type JWK } from "jose"
import { AuthError, type AuthOptions, type Issuer, type ResolvedCaller } from "clegra"

import { CLEGRA_SCOPE, type Auth } from "./auth"
import { sql } from "./db"
import { permissionsFor } from "./permissions"
import { mcpResource, publicUrl } from "./site"

/**
 * Who an MCP caller is, once its access token is verified: the person, in the organization the token was
 * issued for, with the permissions of their role there — read live, so a deleted user, a removed member or a
 * changed role counts on the next call. Null refuses the call.
 */
export async function callerFor(userId: string, organizationId: string): Promise<ResolvedCaller | null> {
  const [m] = await sql<{ role: string; name: string }>(`SELECT m.role, u.name FROM member m JOIN "user" u ON u.id = m."userId" WHERE m."organizationId" = $1 AND m."userId" = $2`, [organizationId, userId])
  if (!m) return null
  return { installation: organizationId, person: { id: userId, name: m.name }, permissions: permissionsFor(m.role), subject: userId }
}

/**
 * Workspace hosts whose tokens (with the `clegra` claim) are accepted: CLEGRA_ISSUERS, `issuer|jwksUri`,
 * comma-separated. Their tenant is `<installation>@<issuer>`, an installation of that host, never an organization.
 */
export function issuersFromEnv(env: Record<string, string | undefined> = process.env): Issuer[] {
  return (env.CLEGRA_ISSUERS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const [issuer, jwksUri] = entry.split("|").map((s) => s.trim())
      if (!issuer) throw new Error(`CLEGRA_ISSUERS: "${entry}" has no issuer`)
      return { issuer, ...(jwksUri ? { jwksUri } : {}) }
    })
}

/**
 * Clegra apps' `auth` for this app. Workspace hosts from CLEGRA_ISSUERS (`env`): the SDK verifies their tokens itself,
 * for this MCP server alone. The app's own users: better-auth (its mcp plugin) issues the access tokens, the app
 * verifies them here. Such a token counts only when it is a JWT (`typ: at+jwt`) signed by better-auth's own keys, from its issuer, for this
 * MCP server alone (`aud`), not expired (30 s of clock skew), not sender-bound (`cnf`), with the `clegra` scope
 * and the organization (`org`) — and the person is still a member of that organization.
 *
 * better-auth is reached through `getAuth` only when one of its tokens or metadata requests arrives: a host's
 * call never builds it (its mcp plugin accepts an http resource only on loopback, so a host in Docker that
 * reaches the app at http://host.docker.internal:3930 can use the app while its own sign-in needs https).
 */
export function clegraAuth(getAuth: () => Promise<Auth>, env: Record<string, string | undefined> = process.env): AuthOptions {
  const issuer = `${publicUrl()}/api/auth`
  const resource = mcpResource()

  // better-auth's keys, read in-process and cached; read again (at most every 10 s) for a key id not in them (rotation).
  let keys: { set: ReturnType<typeof createLocalJWKSet>; at: number } | null = null
  const loadKeys = async () => {
    const jwks = (await (await getAuth()).api.getJwks()) as { keys: JWK[] }
    keys = { set: createLocalJWKSet(jwks), at: Date.now() }
    return keys
  }
  const verify = async (token: string) => {
    const check = (set: ReturnType<typeof createLocalJWKSet>) => jwtVerify(token, set, { issuer, audience: resource, typ: "at+jwt", algorithms: ["EdDSA", "ES256", "RS256", "PS256"], clockTolerance: 30, requiredClaims: ["sub", "exp", "aud"] })
    const current = keys ?? (await loadKeys())
    try {
      return (await check(current.set)).payload
    } catch (error) {
      if (!(error instanceof errors.JWKSNoMatchingKey) || Date.now() - current.at < 10_000) throw error
      return (await check((await loadKeys()).set)).payload
    }
  }

  return {
    resource,
    authorizationServers: [issuer],
    issuers: issuersFromEnv(env),
    resolve: async (token) => {
      try {
        decodeProtectedHeader(token)
      } catch {
        throw new AuthError("not a JWT access token: ask for this server as the resource (RFC 8707)")
      }
      let claims: Awaited<ReturnType<typeof verify>>
      try {
        claims = await verify(token)
      } catch (error) {
        if (error instanceof errors.JWTExpired) throw new AuthError("the access token has expired")
        if (error instanceof errors.JWTClaimValidationFailed && error.claim === "aud") throw new AuthError("the access token is for another server")
        if (error instanceof errors.JOSEError) throw new AuthError("the access token is not valid")
        throw error
      }
      // Issued for this server alone. better-auth adds its own userinfo endpoint when the client asks for `openid`
      // (ChatGPT and Claude do); any other audience could replay the token here.
      if ([claims.aud].flat().some((aud) => aud !== resource && aud !== `${issuer}/oauth2/userinfo`)) throw new AuthError("the access token is for several servers")
      if (claims.cnf !== undefined) throw new AuthError("sender-constrained (DPoP) access tokens are not accepted")
      if (typeof claims.scope !== "string" || !claims.scope.split(" ").includes(CLEGRA_SCOPE)) throw new AuthError(`the access token lacks the ${CLEGRA_SCOPE} scope`)
      if (typeof claims.org !== "string" || !claims.org) throw new AuthError("the access token names no organization")
      const caller = await callerFor(claims.sub!, claims.org)
      if (!caller) throw new AuthError("the user is no longer a member of the token's organization")
      return caller
    },
    // better-auth's metadata (RFC 8414, OpenID discovery) where clients look for it: under /.well-known at the root.
    serve: async (request) => {
      const path = new URL(request.url).pathname
      const which = path === "/.well-known/oauth-authorization-server/api/auth" ? "oauth" : path === "/.well-known/openid-configuration/api/auth" ? "openid" : null
      if (!which) return null
      const auth = await getAuth()
      const metadata = which === "oauth" ? oauthProviderAuthServerMetadata(auth) : oauthProviderOpenIdConfigMetadata(auth)
      if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { status: 405, headers: { allow: "GET, HEAD" } })
      return metadata(request)
    },
  }
}
