import { oauthProviderAuthServerMetadata, oauthProviderOpenIdConfigMetadata } from "@better-auth/oauth-provider"
import { createLocalJWKSet, decodeProtectedHeader, errors, jwtVerify, type JWK } from "jose"
import { AuthError, type AuthOptions, type ResolvedCaller } from "modelapp"

import { MODELAPP_SCOPE, type Auth } from "./auth"
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
 * MAP's `auth` for this app: better-auth (its mcp plugin) issues the access tokens, the app verifies them here.
 * A token counts only when it is a JWT (`typ: at+jwt`) signed by better-auth's own keys, from its issuer, for this
 * MCP server alone (`aud`), not expired (30 s of clock skew), not sender-bound (`cnf`), with the `modelapp` scope
 * and the organization (`org`) — and the person is still a member of that organization.
 */
export function modelAppAuth(auth: Auth): AuthOptions {
  const issuer = `${publicUrl()}/api/auth`
  const resource = mcpResource()

  // better-auth's keys, read in-process and cached; read again (at most every 10 s) for a key id not in them (rotation).
  let keys: { set: ReturnType<typeof createLocalJWKSet>; at: number } | null = null
  const loadKeys = async () => {
    const jwks = (await auth.api.getJwks()) as { keys: JWK[] }
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
      // Issued for this server alone: a token for several audiences could be replayed here by any of them.
      if (Array.isArray(claims.aud) && claims.aud.length !== 1) throw new AuthError("the access token is for several servers")
      if (claims.cnf !== undefined) throw new AuthError("sender-constrained (DPoP) access tokens are not accepted")
      if (typeof claims.scope !== "string" || !claims.scope.split(" ").includes(MODELAPP_SCOPE)) throw new AuthError(`the access token lacks the ${MODELAPP_SCOPE} scope`)
      if (typeof claims.org !== "string" || !claims.org) throw new AuthError("the access token names no organization")
      const caller = await callerFor(claims.sub!, claims.org)
      if (!caller) throw new AuthError("the user is no longer a member of the token's organization")
      return caller
    },
    // better-auth's metadata (RFC 8414, OpenID discovery) where clients look for it: under /.well-known at the root.
    serve: async (request) => {
      const path = new URL(request.url).pathname
      const metadata = path === "/.well-known/oauth-authorization-server/api/auth" ? oauthProviderAuthServerMetadata(auth) : path === "/.well-known/openid-configuration/api/auth" ? oauthProviderOpenIdConfigMetadata(auth) : null
      if (!metadata) return null
      if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { status: 405, headers: { allow: "GET, HEAD" } })
      return metadata(request)
    },
  }
}
