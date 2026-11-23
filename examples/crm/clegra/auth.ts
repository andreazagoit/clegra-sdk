// Who may call the CRM's MCP server: its own users, with access tokens from better-auth (the CRM's OAuth
// authorization server, lib/auth-options.ts), and Clegra's people through Clegra's core (CLEGRA_ISSUER and the rest of CLEGRA_*).
import { oauthProviderAuthServerMetadata, oauthProviderOpenIdConfigMetadata } from "@better-auth/oauth-provider"
import { createLocalJWKSet, decodeProtectedHeader, errors, jwtVerify, type JWK } from "jose"
import { AuthError, clegraFromEnv, type AuthOptions, type CallerResolver } from "@clegra/sdk"

import { auth, membership } from "@/lib/auth"
import { CLEGRA_SCOPE, ORG_CLAIM } from "@/lib/auth-options"
import { permissionsForRole } from "@/lib/permissions"
import { authIssuer, mcpResource } from "@/lib/site"

// ------------------------------------------------------------------ the CRM's own users

// better-auth's signing keys, read in-process and cached; read again (at most every 10 s) for a key id we don't know (rotation).
let keys: { set: ReturnType<typeof createLocalJWKSet>; at: number } | null = null
async function loadKeys() {
  const jwks = (await auth().api.getJwks()) as { keys?: JWK[] }
  return (keys = { set: createLocalJWKSet({ keys: jwks.keys ?? [] }), at: Date.now() })
}

/**
 * A better-auth access token → the caller. Only a JWT (`typ: at+jwt`) signed by better-auth's keys, from its issuer,
 * for exactly this server (`aud` = resource), not expired (30 s of skew), not sender-bound (`cnf`), with the
 * `clegra` scope and an organization. Then, live from the database: the person must still be a member of that
 * organization; their role now gives the permissions. The organization comes from the token only.
 */
export const resolveUser: CallerResolver = async (token, _request, { resource }) => {
  try {
    if (decodeProtectedHeader(token).typ !== "at+jwt") throw new AuthError("not an access token")
  } catch (error) {
    throw error instanceof AuthError ? error : new AuthError("not a JWT access token: ask for this server as the resource (RFC 8707)")
  }
  const verify = (set: ReturnType<typeof createLocalJWKSet>) =>
    jwtVerify(token, set, { issuer: authIssuer(), audience: resource, typ: "at+jwt", algorithms: ["EdDSA", "ES256", "ES512", "PS256", "RS256"], clockTolerance: 30, requiredClaims: ["sub", "exp", "aud"] })
  let claims
  try {
    const current = keys ?? (await loadKeys())
    claims = (await verify(current.set).catch(async (error) => {
      if (error instanceof errors.JWKSNoMatchingKey && Date.now() - current.at > 10_000) return verify((await loadKeys()).set)
      throw error
    })).payload
  } catch (error) {
    if (error instanceof errors.JWTExpired) throw new AuthError("the access token has expired")
    if (error instanceof errors.JWTClaimValidationFailed && error.claim === "aud") throw new AuthError("the access token is for another server")
    if (error instanceof errors.JOSEError) throw new AuthError("the access token is not valid")
    throw error
  }
  // For this server alone. better-auth adds its own userinfo endpoint when the client asks for `openid` (ChatGPT and
  // Claude do); any other audience could replay the token here.
  if ([claims.aud].flat().some((aud) => aud !== resource && aud !== `${authIssuer()}/oauth2/userinfo`)) throw new AuthError("the access token is for several servers")
  if (claims.cnf !== undefined) throw new AuthError("sender-constrained (DPoP) access tokens are not accepted")
  if (typeof claims.scope !== "string" || !claims.scope.split(" ").includes(CLEGRA_SCOPE)) throw new AuthError(`the access token lacks the ${CLEGRA_SCOPE} scope`)
  const orgId = claims[ORG_CLAIM]
  if (typeof orgId !== "string" || !orgId) throw new AuthError("the access token names no organization")

  const member = await membership(orgId, claims.sub!)
  if (!member) throw new AuthError("the user is not a member of the token's organization")
  return { installation: orgId, person: { id: claims.sub!, name: member.userName }, permissions: permissionsForRole(member.role), subject: claims.sub! }
}

/** better-auth's metadata at the root (RFC 8414 and OpenID discovery for an issuer with a path), where clients look. */
async function serveMetadata(request: Request): Promise<Response | null> {
  const path = new URL(request.url).pathname
  const issuerPath = new URL(authIssuer()).pathname
  const which = path === `/.well-known/oauth-authorization-server${issuerPath}` ? "oauth" : path === `/.well-known/openid-configuration${issuerPath}` ? "openid" : null
  if (!which) return null
  if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { status: 405, headers: { allow: "GET, HEAD" } })
  return which === "oauth" ? oauthProviderAuthServerMetadata(auth())(request) : oauthProviderOpenIdConfigMetadata(auth())(request)
}

// ------------------------------------------------------------------ the CRM's users and Clegra's

/**
 * The MCP server's authorization, for the one public address (CLEGRA_PUBLIC_URL): the CRM's own users, and with
 * CLEGRA_ISSUER the people of Clegra companies through Clegra's core (the SDK verifies those tokens itself; their
 * tenant is `<company>@<issuer>`, never an organization of the CRM). The rest of the Clegra configuration comes from
 * CLEGRA_REGISTRATION_ID, CLEGRA_REGISTRATION_CHALLENGE, CLEGRA_ALLOWED_COMPANIES and CLEGRA_CLIENT_ORIGINS.
 */
export function crmAuth(env: Record<string, string | undefined> = process.env): AuthOptions {
  const clegra = clegraFromEnv(env)
  return { resolve: resolveUser, serve: serveMetadata, authorizationServers: [authIssuer(env)], resource: mcpResource(env), ...(clegra ? { clegra } : {}) }
}
