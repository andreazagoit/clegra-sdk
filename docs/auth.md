# Your sign-in, your `resolve`

> Non-normative. The rules are in [spec §7](spec.md#7-enforcement), «Production: an app with its own
> authorization server». This page shows how to meet them with the sign-in you already have.

An MCP client (Claude, ChatGPT, the MCP Inspector) connects to `https://app.example.com/mcp` as an OAuth client.
Each person signs in once with your app's own sign-in and gets an access token for your MCP server. The `@clegra/sdk`
package answers the `401`, serves the protected-resource metadata (RFC 9728) and enforces everything after that point. Your
code does one thing: it says whether a token is good and who it belongs to.

```ts
serve(app, {
  auth: {
    resource: `${process.env.CLEGRA_PUBLIC_URL}/mcp`,            // the only audience accepted; required in production
    authorizationServers: ["https://app.example.com/api/auth"],    // the issuer, named in the protected-resource metadata
    resolve: async (token, request, { resource }) => {
      // 1. verify: signature (JWKS), expiry, issuer, aud === resource
      // 2. return { installation, person: { id, name }, permissions } — or null / throw AuthError to refuse (401)
    },
    serve: async (request) => null,  // optional: answer RFC 8414 metadata at your origin, null for anything else
  },
  // …
})
```

The contract:

- `installation` is the tenant your handlers scope by (`ctx.installation`): an organization, a workspace, an account.
  It must come from the verified token or your database. Never take it from a request parameter. It must match
  `[A-Za-z0-9._:-]{1,128}`.
- `permissions` are ids you declared under `permissions`, or `"all"`. The SDK drops ids you didn't declare. Map them
  from your roles, and read the roles live when you can, so a removed member loses access on the next call.
- `subject` (optional, default `person.id`): idempotency of writes is kept per subject.
- Return `null` for a token that isn't yours. Throw `AuthError("reason")` to refuse with a reason; the reason goes
  into `WWW-Authenticate`. Any other error is logged and answered as `401 invalid token`.

## Your users are linked through your sign-in, never around it

An app with its own users is linked through its own sign-in: each person signs in with your app's credentials and
consents, and the host (Clegra like ChatGPT or Claude) then acts only with the token your authorization server issued.
A host's identity is never a way into one of your users' accounts: no email match, no session handed over. Your
accounts, permissions and revocations stay the one authority, read on every call.

When the host also shows your site in a frame (spec §5.1), the first sign-in can link in the same step: the host opens
the frame at your authorization page with `response_mode=web_message`; your page signs the person in, asks the
consent, and posts `{ type: "authorization_response", response: { code, state, iss } }` to the framing host (only to
its configured client origins) instead of redirecting. List `web_message` in `response_modes_supported`. Signing out
of your site never revokes the link; your revocation endpoint (RFC 7009) and your own admin screens do.

## What the authorization server must give MCP clients

This is spec §7 «Production», as a checklist:

| Need | Why |
|---|---|
| Authorization code + PKCE `S256`, listed in `code_challenge_methods_supported` | Clients refuse a server whose metadata doesn't list it |
| RFC 8414 metadata (or OpenID discovery) | Clients find the endpoints from the issuer named in `authorization_servers` |
| The `resource` parameter (RFC 8707), so the token's `aud` is exactly your MCP URL | Without it, a token issued for another app could be replayed here |
| Client ID Metadata Documents (CIMD), then optionally Dynamic Client Registration | Current clients identify themselves by an https URL. Nobody registers Claude or ChatGPT by hand |
| A consent page that shows the client and the account being connected | The person sees who gets access |
| Tokens you can verify: a JWT with a JWKS, or an introspection call | `resolve` has to check them |

## The recipes

Each recipe says how far it was verified. None of them is a package: copy the code into your app, it is yours.

| Recipe | Verified |
|---|---|
| [better-auth](#a-better-auth) | Tested in this repo's examples (better-auth 1.7.7, `examples/crm/clegra/auth.ts`) |
| [Clerk](#b-clerk) | From Clerk's docs on 2026-11-15, not run here |
| [Auth0](#c-auth0) | From Auth0's docs on 2026-11-15, not run here |
| [WorkOS AuthKit](#d-workos-authkit) | From WorkOS's docs on 2026-11-15, not run here |

### (a) better-auth

*Tested in this repo's examples:* the CRM (`examples/crm/lib/auth-options.ts`, `clegra/auth.ts`) passes
`clegra check` with a token from the real OAuth flow.

better-auth 1.7.7 has no built-in MCP plugin. Use `@better-auth/mcp` (authorization server), `jwt` (signed access
tokens) and `@better-auth/cimd` (Client ID Metadata Documents), all 1.7.7.

```ts
// lib/auth.ts
import { cimd } from "@better-auth/cimd"
import { fetchClientMetadataResource } from "@better-auth/cimd/node"
import { mcp } from "@better-auth/mcp"
import { betterAuth } from "better-auth"
import { APIError } from "better-auth/api"
import { jwt, organization } from "better-auth/plugins"

const site = process.env.CLEGRA_PUBLIC_URL!       // https://app.example.com
export const resource = `${site}/mcp`               // mcp({ resource }) and serve's auth.resource: the same string
export const issuer = `${site}/api/auth`            // better-auth at /api/auth

export const auth = betterAuth({
  baseURL: site,
  secret: process.env.BETTER_AUTH_SECRET,
  database: yourDatabase,
  emailAndPassword: { enabled: true },
  disabledPaths: ["/token"],                        // the jwt plugin's session-JWT endpoint: MCP clients use OAuth tokens only
  plugins: [
    organization(),
    jwt({ disableSettingJwtHeader: true }),
    mcp({
      resource,
      loginPage: "/sign-in",
      consentPage: "/oauth/consent",
      scopes: ["openid", "profile", "email", "offline_access", "clegra"],   // `clegra`: the scope the metadata announces
      postLogin: {                                  // one connection = one organization: the session's active one
        page: "/oauth/organization",
        shouldRedirect: ({ session }) => !session.activeOrganizationId,
        consentReferenceId: ({ session }) => {
          if (!session.activeOrganizationId) throw new APIError("BAD_REQUEST", { error: "invalid_request", error_description: "choose an organization first" })
          return session.activeOrganizationId as string
        },
      },
      customAccessTokenClaims: ({ referenceId }) => (referenceId ? { org: referenceId } : {}),  // the organization, also after a refresh
    }),
    cimd({ fetchClientMetadataResource, metadataProfile: "mcp-2026-07-28" }),
  ],
})
```

The `resolve` (about 40 lines). Each check closes one specific hole:

```ts
// clegra-auth.ts
import { oauthProviderAuthServerMetadata, oauthProviderOpenIdConfigMetadata } from "@better-auth/oauth-provider"
import { createLocalJWKSet, decodeProtectedHeader, errors, jwtVerify, type JWK } from "jose"
import { AuthError, type AuthOptions, type CallerResolver } from "@clegra/sdk"
import { auth, issuer, resource } from "@/lib/auth"

let keys: { set: ReturnType<typeof createLocalJWKSet>; at: number } | null = null
const loadKeys = async () => (keys = { set: createLocalJWKSet({ keys: ((await auth.api.getJwks()) as { keys: JWK[] }).keys }), at: Date.now() })

const resolve: CallerResolver = async (token, _request, { resource }) => {
  let typ: unknown
  try { typ = decodeProtectedHeader(token).typ } catch { throw new AuthError("not a JWT access token: ask for this server as the resource (RFC 8707)") }
  if (typ !== "at+jwt") throw new AuthError("not an access token")       // better-auth gives an opaque token when no resource was asked
  const verify = (set: ReturnType<typeof createLocalJWKSet>) =>
    jwtVerify(token, set, { issuer, audience: resource, typ: "at+jwt", algorithms: ["EdDSA", "ES256", "ES512", "PS256", "RS256"], clockTolerance: 30, requiredClaims: ["sub", "exp", "aud"] })
  let claims
  try {
    const current = keys ?? (await loadKeys())
    claims = (await verify(current.set).catch(async (error) => {
      // An unknown key id: keys were rotated. Read them again, at most every 10 s.
      if (error instanceof errors.JWKSNoMatchingKey && Date.now() - current.at > 10_000) return verify((await loadKeys()).set)
      throw error
    })).payload
  } catch (error) {
    if (error instanceof errors.JWTExpired) throw new AuthError("the access token has expired")
    if (error instanceof errors.JOSEError) throw new AuthError("the access token is not valid")
    throw error
  }
  // This server alone, plus better-auth's own userinfo endpoint when `openid` was asked (ChatGPT and Claude ask): any other audience could replay it here
  if ([claims.aud].flat().some((aud) => aud !== resource && aud !== `${issuer}/oauth2/userinfo`)) throw new AuthError("the access token is for several servers")
  if (claims.cnf !== undefined) throw new AuthError("sender-constrained (DPoP) tokens are not accepted")                     // we don't verify DPoP proofs
  if (typeof claims.scope !== "string" || !claims.scope.split(" ").includes("clegra")) throw new AuthError("the access token lacks the clegra scope")
  const org = claims.org
  if (typeof org !== "string" || !org) throw new AuthError("the access token names no organization")
  const member = await membership(org, claims.sub!)        // YOUR query: member ⨝ user, read now (removed members, changed roles count at once)
  if (!member) throw new AuthError("the user is not a member of the token's organization")
  return { installation: org, person: { id: claims.sub!, name: member.name }, permissions: permissionsForRole(member.role), subject: claims.sub! }
}

// RFC 8414 / OpenID discovery for an issuer with a path live at the root (/.well-known/…/api/auth): withClegra rewrites them here.
const serve = async (request: Request) => {
  const path = new URL(request.url).pathname
  if (path === "/.well-known/oauth-authorization-server/api/auth") return oauthProviderAuthServerMetadata(auth)(request)
  if (path === "/.well-known/openid-configuration/api/auth") return oauthProviderOpenIdConfigMetadata(auth)(request)
  return null
}

export const appAuth: AuthOptions = { resource, authorizationServers: [issuer], resolve, serve }
```

The pitfalls the checks above handle:

- **One audience.** `aud` must be exactly `resource` and nothing else. better-auth's `aud` can be an array.
- **No `cnf`.** A DPoP-bound token is only safe with its proof. The SDK doesn't verify proofs, so refuse the token.
- **The scope.** Clients ask for `clegra` because your protected-resource metadata announces it.
- **Live membership.** The organization comes from the token. The role is read from your database now, never from
  the token.
- **Key rotation.** For an unknown `kid`, read the JWKS again, but at most every 10 seconds, so tokens with random
  key ids can't hammer your database.

The pages are your own. They open with the signed OAuth request in their query (`…&sig=…`), so keep it in the URL.
On the browser side use `createAuthClient({ plugins: [organizationClient(), oauthProviderClient()] })`.
`oauthProviderClient` comes from `@better-auth/oauth-provider/client` and sends the signed query with every POST.

1. `/sign-in`: your normal `authClient.signIn.email(…)`. better-auth continues the authorization by itself.
2. `/oauth/organization`: `authClient.organization.list()`, then `authClient.organization.setActive({ organizationId })`,
   then POST `/oauth2/continue` with `{ postLogin: true }`.
3. `/oauth/consent`: GET `/oauth2/public-client?client_id=…` returns `client_name`, `client_uri` and `logo_uri`. Show
   them with the `client_id` (for a CIMD client, its URL) and the organization. Then POST `/oauth2/consent` with
   `{ accept: true }`, or `{ accept: false }` to deny. You can call it as
   `authClient.$fetch("/oauth2/consent", { method: "POST", body: { accept: true } })`.

Tables: better-auth's own (`user`, `session`, `account`, `verification`, `organization`, `member`, `invitation`, `jwks`,
`oauthClient`, `oauthConsent`, `oauthAccessToken`, `oauthRefreshToken`, …). Create them in an explicit migration,
never at startup. Dynamic Client Registration is off in this config, and CIMD covers current clients. For an older
client that only registers dynamically, add `allowDynamicClientRegistration: true` to `mcp({…})`. Know that this
opens a public endpoint that anyone can use to create clients.

### (b) Clerk

*From Clerk's docs on 2026-11-15, not run here.* Sources:
[Build an MCP server (Next.js)](https://clerk.com/docs/nextjs/guides/ai/mcp/build-mcp-server),
[Client ID Metadata Documents](https://clerk.com/docs/guides/configure/auth-strategies/oauth/client-id-metadata-documents),
[Verify OAuth tokens](https://clerk.com/docs/guides/configure/auth-strategies/oauth/verify-oauth-tokens),
[JWT OAuth access tokens](https://clerk.com/changelog/2026-01-08-jwt-oauth-access-tokens),
[OAuth and organizations](https://clerk.com/changelog/2026-05-14-oauth-organizations).

- **Authorization server.** Your instance's Frontend API URL (`https://clerk.<your-domain>`) is the issuer. It serves
  `/.well-known/oauth-authorization-server`, `/.well-known/openid-configuration` and `/.well-known/jwks.json`.
- **Clients.** In the Dashboard, under OAuth applications → Settings, turn on «Publish CIMD support». It is off by
  default. CIMD clients must be public, and PKCE `S256` and the consent screen always apply. A separate «Publish DCR
  support» switch exists.
- **Audience.** Enter your MCP URL in the Dashboard's «MCP URL» field. Clerk then puts `aud` into its tokens. Verify
  with `audience: resource`: Clerk's guide warns that without it the audience isn't checked. The docs don't say
  whether a client's own `resource` parameter is honored per request.
- **Tokens.** New OAuth applications issue JWTs; older ones are opaque until switched. Clerk's SDK accepts both.
- **Tenant and roles.** With the `user:org:read` scope, the person picks an organization on the consent screen and
  the token carries `org_id`. No role or permission claim is documented for OAuth tokens, so read the person's
  role in that organization from Clerk's Backend API, or from your own tables.

```ts
// `clerk`: the Clerk backend client (@clerk/backend), and verifyClerkToken (@clerk/mcp-tools), set up and imported
// exactly as in Clerk's MCP guide for Next.js.
import { AuthError, type AuthOptions } from "@clegra/sdk"

export const appAuth: AuthOptions = {
  resource,
  authorizationServers: [process.env.CLERK_FRONTEND_API_URL!],       // your instance's Frontend API URL
  resolve: async (_token, request, { resource }) => {
    const state = await clerk.authenticateRequest(request, { acceptsToken: "oauth_token", audience: resource })
    if (!state.isAuthenticated) return null
    const info = verifyClerkToken(state.toAuth(), state.token)        // info.extra.userId, info.scopes
    if (!info) return null
    // org_id is in the JWT claims (needs the user:org:read scope). Then the role: Clerk's Backend API or your tables.
    // Map that role to your permission ids and return { installation: <org id>, person: { id, name }, permissions }.
    throw new AuthError("TODO: map the Clerk organization and role")
  },
}
```

The gaps: no roles in the token, so a lookup on every call (cache it briefly). Clerk's
`authServerMetadataHandlerClerk` (from `@clerk/mcp-tools/next`) is only needed for clients built against older MCP
versions that look for metadata at your origin. Its README marks it not fully implemented, so prefer naming Clerk's
issuer in `authorizationServers` and leaving `serve` out.

### (c) Auth0

*From Auth0's docs on 2026-11-15, not run here.* Sources:
[Authorization for your MCP server](https://auth0.com/ai/docs/mcp/get-started/authorization-for-your-mcp-server),
[Resource Parameter Compatibility Profile](https://auth0.com/ai/docs/mcp/guides/resource-param-compatibility-profile),
[Client ID Metadata Documents](https://auth0.com/docs/get-started/auth0-overview/create-applications/cimd-overview),
[Dynamic Client Registration](https://auth0.com/docs/get-started/applications/dynamic-client-registration),
[Organizations in tokens](https://auth0.com/docs/manage-users/organizations/using-tokens),
[RBAC for APIs](https://auth0.com/docs/get-started/apis/enable-role-based-access-control-for-apis),
[`@auth0/auth0-api-js`](https://github.com/auth0/auth0-auth-js/tree/main/packages/auth0-api-js).

- **Authorization server.** The issuer is `https://<tenant>.auth0.com/`, with a trailing slash, or your custom domain.
  It serves OpenID discovery and `/.well-known/oauth-authorization-server`, and its JWKS is at
  `/.well-known/jwks.json`.
- **Audience.** Create an API whose identifier is your MCP URL. Then turn on the tenant setting «Resource Parameter
  Compatibility Profile», because without it Auth0 ignores `resource`. If a client sends both `audience` and
  `resource`, `audience` wins. Auth0's guide also sets the API's token dialect to `rfc9068_profile_authz`.
- **Clients.** You can import a CIMD document by hand. Clients that send their CIMD URL as `client_id` are Early
  Access, and they are third-party apps in strict mode. DCR (`enable_dynamic_client_registration`) creates
  third-party clients. Those clients can only use connections promoted to domain level, and they reach no API
  unless the API grants default third-party permissions. Auth0 recommends CIMD over DCR.
- **Tokens.** JWTs for a custom API. When a client also asks for `openid`, `aud` is an array: your API plus Auth0's
  own `…/userinfo`. That is the one exception to the «one audience» rule worth allowing, because the second audience
  is Auth0 itself, not another app. Allow exactly that pair and nothing more.
- **Tenant and roles.** `org_id` (with the `organization` parameter). `permissions` are added when «Enable RBAC» and
  «Add Permissions in the Access Token» are on. Organization-scoped role permissions are Early Access.

```ts
import { ApiClient } from "@auth0/auth0-api-js"
import { AuthError, type AuthOptions } from "@clegra/sdk"

const api = new ApiClient({ domain: process.env.AUTH0_DOMAIN!, audience: resource })   // checks iss, aud, exp, nbf

export const appAuth: AuthOptions = {
  resource,
  authorizationServers: [`https://${process.env.AUTH0_DOMAIN}/`],
  resolve: async (token) => {
    const claims = await api.verifyAccessToken({ accessToken: token }).catch(() => null)
    if (!claims) return null
    const org = claims.org_id
    if (typeof org !== "string") throw new AuthError("the access token names no organization")
    const granted = Array.isArray(claims.permissions) ? (claims.permissions as string[]) : []
    // A person's name is not in an access token by default: add it with an Action, or read it from your users.
    return { installation: org, person: { id: claims.sub!, name: String(claims.name ?? claims.sub) }, permissions: granted }
  },
}
```

The gaps: `resource` is off by default, and dynamic CIMD is Early Access. Auth0 permission names are Auth0's own,
so name your app's permissions the same (`deals.view`) or map between them. Not confirmed: whether the metadata lists
`client_id_metadata_document_supported` once CIMD is on.

### (d) WorkOS AuthKit

*From WorkOS's docs on 2026-11-15, not run here.* Sources:
[AuthKit: Model Context Protocol](https://workos.com/docs/authkit/mcp),
[Connect token claims](https://workos.com/docs/authkit/connect/token-claims).

- **Authorization server.** `https://<your-authkit-domain>`, with metadata at `/.well-known/oauth-authorization-server`,
  which lists `S256`. The JWKS is at `/oauth2/jwks`. «Standalone Connect» sends people to your own login page, so
  your existing sign-in stays.
- **Clients.** CIMD is off by default: turn it on in Dashboard → Connect → Configuration. DCR is in the same place,
  for clients without CIMD.
- **Audience.** Add your MCP URL as a Resource Indicator. Tokens then carry `aud` equal to the requested `resource`.
  One indicator can be the default for clients that send none. With no indicator, `aud` is the environment's client
  id, so set one.
- **Tokens.** JWT: `iss`, `aud`, `sub`, `client_id`, `org_id` (the organization chosen at authorization), `scope`,
  `exp`. There is no permissions claim. Look the membership up:
  `workos.userManagement.listOrganizationMemberships({ userId, organizationId })`, then the role's permissions
  (`workos.authorization.getOrganizationRole(organizationId, slug)`). Cache that briefly per person and organization.

```ts
import { createRemoteJWKSet, jwtVerify } from "jose"
import { AuthError, type AuthOptions } from "@clegra/sdk"

const AUTHKIT = process.env.WORKOS_AUTHKIT_DOMAIN!                    // https://<your-authkit-domain>
const jwks = createRemoteJWKSet(new URL(`${AUTHKIT}/oauth2/jwks`))   // jose caches and refetches on an unknown kid

export const appAuth: AuthOptions = {
  resource,
  authorizationServers: [AUTHKIT],
  resolve: async (token, _request, { resource }) => {
    const { payload } = await jwtVerify(token, jwks, { issuer: AUTHKIT, audience: resource, clockTolerance: 30 }).catch(() => {
      throw new AuthError("the access token is not valid here")
    })
    if (Array.isArray(payload.aud) && payload.aud.length !== 1) throw new AuthError("the access token is for several servers")
    const org = payload.org_id
    if (typeof org !== "string") throw new AuthError("the access token names no organization")
    // The membership and its role, live: listOrganizationMemberships, then the role's permissions (WorkOS's SDK).
    // Map them to your permission ids; the name comes from your users or WorkOS's user record.
    throw new AuthError("TODO: map the WorkOS membership to permissions")
  },
}
```

The gaps: no permissions in the token, so there is one lookup per call (cache it). Not confirmed: whether the
metadata announces CIMD once it is on, and which SDK call returns the person's name.

## No OAuth server yet? The SDK's sign-in module

`@clegra/sdk/signin` is a complete OAuth 2.1 authorization server on top of the login you already have (spec §7,
«Your sign-in»). You give it who is signed in on a request and where your sign-in page is; it gives every client
(Clegra, Claude, ChatGPT) a delegation your app issued, through your own consent page, revocable in your app.

```ts
import { createSignIn, passwordLogin, SqlSignInStore } from "@clegra/sdk/signin"

const store = new SqlSignInStore(query)   // SqlSignInStore.schema() in a migration
export const signIn = createSignIn(app, {         // app: what defineApp returned (its title and permissions)
  issuer: "https://app.example.com",
  resource: "https://app.example.com/mcp",
  // Your login: who is signed in on this request (your session), and where your sign-in page is.
  login: { session: (request) => currentUser(request), signInUrl: (returnTo) => `/login?next=${encodeURIComponent(returnTo)}` },
  // Read live on every call: what the person may do now (null: no longer allowed).
  permissionsOf: (person) => permissionsFor(person),
  store,
  keys: [JSON.parse(process.env.SIGNIN_KEY!)],   // newSignInKey() makes one
  clientOrigins: ["https://app.clegra.com"],      // who may frame your site and get web_message answers
})
export const served = serve(app, { auth: { signIn } })
```

- No login at all? `passwordLogin({ store, origin, title })` is one: accounts with an email and a password
  (`login.accounts.create`), a sign-in page at `/signin`, a session cookie that works inside a client's frame. Give
  `login.permissionsOf` as `permissionsOf`.
- Background work (a nightly job, a script, an automation): the person makes a personal key in your app
  (`signIn.keys.create(person, { name, scopes })`), shown once, revoked with `signIn.keys.revoke`.
- Your «connected apps» screen: `signIn.links.list(person)` and `signIn.links.revoke(person, id)`; a person who
  leaves: `signIn.forget(person)`.

## Your own site in a client's frame

A workspace client (Clegra) shows your site in a frame on its own site (spec §5.1). It never signs anyone in for you:
the person signs in with your sign-in, inside the frame. For that your session cookie must be
`Secure; HttpOnly; SameSite=None; Partitioned` over https (the sign-in module's `frameCookie` writes it; with
better-auth: `advanced.defaultCookieAttributes`), and your pages must be framable by the client only (`siteProxy(served)`
in `proxy.ts`, with `clientOrigins` and `site: { start }` in `serve`). `<ClegraSite />` in the root layout takes the
client's theme and language and tells it where the person is.

## Locally, before any of this

`devSignIn(app, { issuer?, people?, installation?, code? })` is the sign-in module over test people: a dev login at
`/oauth/dev-login` that lists them and asks for the code printed when the app starts, then the module's real consent
and tokens, so a real MCP client links exactly as in production. Beside it, `served.dev` signs development tokens and
a development workspace host's confirmation proofs for tests (`testClient`, `installationClient`). It is refused when
`NODE_ENV` is `production`, its development tokens count only from callers on a loopback address, and its keys live
in memory.

```ts
export const served = serve(app, { auth: { signIn: devSignIn(app, { issuer: "http://127.0.0.1:3920", people: [{ id: "ada", name: "Ada", permissions: "all" }] }) } })
```

In a Next.js app with its own authorization server:

`npx @clegra/sdk init` writes a `resolve` that also accepts one bearer from `.env.local` (`CLEGRA_LOCAL_TOKEN`). It is
refused whenever `NODE_ENV` is `production`, which `next build`, `next start` and every deployment set. Use it to see
the app in the Inspector on day one, and keep it as you plug in one of the recipes above. The
[Next.js guide](start-next.md) has the details.
