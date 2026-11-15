# @modelapp/next

A MAP app (`defineApp` from `@modelapp/server`) inside a Next.js App Router app, and better-auth as its
authorization server. MIT.

- `@modelapp/next`: `toNextHandlers(app)` (the route) and `withModelApp(nextConfig)` (the rewrites).
- `@modelapp/next/better-auth`: `betterAuthBridge(auth, { caller })`, which verifies better-auth's MCP access tokens
  inside the app.

Verified with Next 16.4.3 (`next dev` and `next build` + `next start` with Turbopack; `next build --webpack` builds too) and
better-auth 1.7.7 with `@better-auth/mcp`, `@better-auth/cimd` and `@better-auth/oauth-provider` 1.7.7.

## Install

```sh
npm i @modelapp/server @modelapp/next zod
npm i better-auth @better-auth/mcp @better-auth/cimd @better-auth/oauth-provider   # pin all to the same version (1.7.7)
```

## The three files

```ts
// next.config.ts
import { withModelApp } from "@modelapp/next"

export default withModelApp({ /* your config: rewrites in any shape are kept */ })
```

```ts
// app/api/modelapp/[...path]/route.ts
import { toNextHandlers } from "@modelapp/next"
import { app } from "@/modelapp"

export const { GET, POST, DELETE, OPTIONS } = toNextHandlers(app)
```

```ts
// modelapp.ts
import { defineApp } from "@modelapp/server"
import { betterAuthBridge } from "@modelapp/next/better-auth"
import { auth, resource } from "@/lib/auth"

export const app = defineApp({
  name: "crm",
  title: "CRM",
  version: "1.0.0",
  auth: {
    ...betterAuthBridge(auth, {
      // installation defaults to the organization id; person to { id: user.id, name: user.name }.
      caller: ({ roles }) => ({ permissions: roles.includes("owner") || roles.includes("admin") ? "all" : ["deals.view"] }),
    }),
    resource,
  },
  // permissions, entities (get/list on any database, scoped by ctx.installation), actions, pages…
})
```

What happens:

- `withModelApp` adds `beforeFiles` rewrites from `/mcp`, `/.well-known/modelapp.json`,
  `/.well-known/oauth-protected-resource/:path*`, `/.well-known/oauth-authorization-server/:path*` and
  `/.well-known/openid-configuration/:path*` (each also matches the bare path) to `/api/modelapp/…`. The app's own
  rewrites are kept: an array becomes `afterFiles` (what Next does with an array), an object keeps its
  `beforeFiles` (after ours), `afterFiles` and `fallback`. The config may be an object or a config function.
  It adds `transpilePackages` for `@modelapp/server`, `@modelapp/spec` and `@modelapp/next`. In a workspace
  (symlinked packages) the builds work without it. Installed from a registry as TypeScript source, Next needs
  it. It refuses `basePath` (the well-known paths must be at the root of the host) and `trailingSlash: true` (it
  redirects `/mcp` to `/mcp/`).
- `toNextHandlers` gives `app.fetch` the request at its public address: the mount taken off
  (`/api/modelapp/mcp` → `/mcp`). Next hands a route handler a rewritten request with the source path
  (`/mcp`), and that path is kept. A path that is neither under the mount nor a rewritten one answers
  500 `misconfigured`. Responses go back as they are; SSE streams arrive chunk by chunk (verified with
  `next start`), with `cache-control: no-transform` and `x-accel-buffering: no` for proxies. No state is kept
  between requests (stateless MCP): it runs the same on serverless. Options: `mount` (default `/api/modelapp`,
  the same in both functions) and `publicUrl`.
- Leave defineApp's `path` unset (an error otherwise). The route's mount does that job.

## Public URL behind proxies and on Vercel

The public origin is, in order:

1. `publicUrl` (in `toNextHandlers`).
2. The `MODELAPP_PUBLIC_URL` environment variable (`https://crm.example.com`, an origin only).
3. What the request says: `x-forwarded-host` / `x-forwarded-proto`, else `host`.

Next itself sets `x-forwarded-host` from `host` when a proxy didn't, and Vercel sets both headers. A client can send
these headers too, so in production set `MODELAPP_PUBLIC_URL` and `auth.resource`. Tokens are only ever accepted
for `auth.resource`, whatever the headers say. In production, `resolve` without `auth.resource` answers 500
`misconfigured` on every request. On Vercel, give each environment its own value: preview deployments have other
hosts, and better-auth's `baseURL`, the mcp `resource` and `auth.resource` must all match.

## Dev sign-in (`auth.dev`) is refused under Next

The SDK's dev authorization server answers loopback callers only, and needs the socket's peer address. A Next route
handler doesn't get it: `NextRequest` carries no IP. Next fills `x-forwarded-for` from the socket only when the
header is missing (`??=`), so a client can send any value. The test sends `10.9.9.9` and Next passes it on. Guessing
from that header would open dev sign-in to anyone, so `toNextHandlers` throws if `auth.dev` is on. Locally, use the
app's own sign-in (better-auth below), or run the app outside Next with `listen` from `@modelapp/server/node`.

## better-auth as the authorization server

### The canonical config

```ts
// lib/auth.ts
import { cimd } from "@better-auth/cimd"
import { fetchClientMetadataResource } from "@better-auth/cimd/node"
import { mcp } from "@better-auth/mcp"
import { betterAuth } from "better-auth"
import { APIError } from "better-auth/api"
import { jwt, organization } from "better-auth/plugins"

const site = process.env.MODELAPP_PUBLIC_URL! // https://crm.example.com: the site's public origin
export const resource = `${site}/mcp` // the MCP address: mcp({ resource }) and defineApp's auth.resource

export const auth = betterAuth({
  baseURL: site, // better-auth at /api/auth: the issuer is https://crm.example.com/api/auth
  secret: process.env.BETTER_AUTH_SECRET,
  database: yourDatabase,
  emailAndPassword: { enabled: true },
  // The jwt plugin's /token hands out session JWTs; MCP clients use OAuth tokens only.
  disabledPaths: ["/token"],
  plugins: [
    organization(),
    jwt({ disableSettingJwtHeader: true }),
    mcp({
      resource,
      loginPage: "/sign-in",
      consentPage: "/oauth/consent",
      // `modelapp` is the scope the app's protected-resource metadata announces (clients ask for it).
      scopes: ["openid", "profile", "email", "offline_access", "modelapp"],
      // The connection is for one organization: the session's active one, chosen on the organization page.
      postLogin: {
        page: "/oauth/organization",
        shouldRedirect: ({ session }) => !session.activeOrganizationId,
        consentReferenceId: ({ session }) => {
          if (!session.activeOrganizationId) throw new APIError("BAD_REQUEST", { error: "invalid_request", error_description: "choose an organization first" })
          return session.activeOrganizationId as string
        },
      },
      // The organization in the access token (also after a refresh), read by betterAuthBridge (organizationClaim, default "org").
      customAccessTokenClaims: ({ referenceId }) => (referenceId ? { org: referenceId } : {}),
    }),
    // Client ID Metadata Documents (ChatGPT, Claude, VS Code…): clients identified by an https URL, no registration.
    cimd({ fetchClientMetadataResource, metadataProfile: "mcp-2026-07-28" }),
  ],
})
```

```ts
// app/api/auth/[...all]/route.ts
import { toNextJsHandler } from "better-auth/next-js"
import { auth } from "@/lib/auth"

export const { GET, POST } = toNextJsHandler(auth)
```

Tables (better-auth's own names): `user`, `session`, `account`, `verification`; `organization`, `member`,
`invitation`; `jwks`; `oauthClient`, `oauthResource`, `oauthClientResource`, `oauthRefreshToken`,
`oauthAccessToken`, `oauthConsent`, `oauthClientAssertion`. Create them in an explicit migration, never at startup.
For plain SQL, `(await getMigrations(auth.options)).compileMigrations()` from `better-auth/db/migration` gives the
SQL. With Drizzle, use better-auth's schema generator.

### Client registration: CIMD on, Dynamic Client Registration off

Spec §7 puts metadata documents first and DCR second, as an option. Current MCP clients send a metadata document. An
open `/oauth2/register` would let anyone create clients with any name and redirect URI, which a consent page then
shows as if they were real. A CIMD client's identity is its https URL, and the domain vouches for it. For an older
client that only does DCR, add `allowDynamicClientRegistration: true, allowUnauthenticatedClientRegistration: true`
to `mcp({…})`. The `register` endpoint is rate-limited (5 per minute by default). The canonical config doesn't
announce `registration_endpoint`, and the tests check that.

Without `clientPrivileges`, a signed-in person may create their own clients (`/oauth2/create-client`).
`scripts/oauth-token.ts` uses this. Restrict it with `clientPrivileges` if needed, and give the script an existing
client instead.

### The pages

All three are your own pages. They open with the signed OAuth request in their query (`…&sig=…`), so leave it in
the URL. On the browser side use `createAuthClient({ plugins: [organizationClient(), oauthProviderClient()] })`.
`oauthProviderClient` comes from `@better-auth/oauth-provider/client`. It adds `oauth_query` (the signed query
from `window.location.search`) to every POST. Better-auth answers `{ redirect: true, url }` and the client goes
there by itself.

1. `loginPage` (`/sign-in`): the normal `authClient.signIn.email({ email, password })` (or sign-up). Better-auth
   continues the authorization and redirects to the organization page or the consent page.
2. `postLogin.page` (`/oauth/organization`): list the person's organizations (`authClient.organization.list()`),
   then `authClient.organization.setActive({ organizationId })`. After that, POST `/oauth2/continue` with
   `{ postLogin: true }`, which leads to the consent page.
3. `consentPage` (`/oauth/consent`): show who is asking. GET `/oauth2/public-client?client_id=…` gives
   `client_name`, `client_uri` and `logo_uri`. Also show the `client_id` (for a metadata-document client, its URL)
   and the organization being connected. The query carries `client_id`, `scope` and `resource`. Then POST
   `/oauth2/consent` with `{ accept: true }`, or `{ accept: false }` to deny. Without types for these endpoints,
   use `authClient.$fetch("/oauth2/consent", { method: "POST", body: { accept: true } })`.

`src/better-auth.test.ts` («the pages, step by step») runs exactly these calls.

### What the bridge checks

`resolve(token, request, { resource })` accepts a token only when all of these hold:

- It is a JWT with `typ: at+jwt` and an asymmetric `alg`.
- It is signed by a key of the instance's JWKS. The JWKS comes from `auth.api.getJwks()` in-process, is cached, and
  is read again (at most every 10 s) for an unknown `kid`.
- `iss` is the issuer: better-auth's `baseURL`, or the jwt plugin's `jwt.issuer`.
- `aud` is exactly `auth.resource`, with no second audience.
- `exp` and `nbf` hold, with 30 s of clock skew.
- It has no `cnf` (DPoP-bound tokens are refused).
- It carries the `modelapp` scope (option `scope`, `null` for any).
- It names a client and the organization claim.

Then, live from the database: the user must exist and not be banned (the admin plugin's `banned` / `banExpires`
fields, when present), and the user must be a member of the token's organization. `caller` gets `{ claims, userId,
user, organizationId, member, roles, clientId, request }` and returns `{ installation?, permissions, locale?,
person? }`, or null to refuse.

- Removing a membership, deleting or banning a user, or changing a role takes effect on the next call, even with an
  access token issued before.
- An opaque token, a token for another audience, a tampered token, an expired token and a token signed by another
  key all get 401 with the reason in `WWW-Authenticate`.
- A resource that isn't the mcp plugin's is a configuration error (logged, 401).

`authorizationServers` is `[issuer]`. `serve` answers `/.well-known/oauth-authorization-server/<issuer path>` and
`/.well-known/openid-configuration/<issuer path>` through better-auth's own `oauthProviderAuthServerMetadata` /
`oauthProviderOpenIdConfigMetadata`. `withModelApp` rewrites these paths to the route. Better-auth serves
`<issuer>/.well-known/openid-configuration` itself.

## A token for `modelapp check` against a real URL

```sh
MODELAPP_OAUTH_EMAIL=… MODELAPP_OAUTH_PASSWORD=… \
  MODELAPP_TOKEN=$(npx tsx packages/modelapp-next/scripts/oauth-token.ts https://crm.example.com) \
  npm run modelapp:check -- https://crm.example.com
```

The script runs the real flow over HTTP: sign in → organization (`--org <id>` when the person has several) →
authorize (PKCE S256, `resource`) → consent → token. It reads the authorization server from the app's
protected-resource metadata. Credentials come only from the environment: `MODELAPP_OAUTH_EMAIL` +
`MODELAPP_OAUTH_PASSWORD`, or `MODELAPP_OAUTH_COOKIE`. Optionally pass `MODELAPP_OAUTH_CLIENT_ID` +
`MODELAPP_OAUTH_REDIRECT_URI` for an existing client. The script prints only the token. In code:
`oauthAccessToken({ authBaseURL, resource, signIn, fetch })` from `src/testing/oauth-flow.ts` (`fetch` may be
`auth.handler`).

## Tests

```sh
npm test            # adapter unit tests + the bridge on a real better-auth (PGlite, in-process, and the script over HTTP)
npm run test:next   # test/fixture with next dev (port 3942), then next build + next start (3943); modelapp check through the rewrites
npm run typecheck
```

Verified: path and origin mapping, every rewrites shape, SSE pass-through (unit test and both real Next modes),
`request.url` of a rewritten request (the source path), the spoofable `x-forwarded-for`, `modelapp check`
(public checks and a full run with a token), and the full OAuth flow with CIMD and with a client the person
created. Also: org isolation, org from the token only, membership revoked, role changed, banned and deleted users,
refresh keeping the org, other-audience, tampered, expired, opaque, DPoP and multi-audience tokens.

Not verified here: a deployment on Vercel or behind a real proxy, real ChatGPT / Claude / MCP Inspector clients,
the `@better-auth/cimd/node` transport against a real metadata document (the tests serve the document in-process),
DPoP, and key rotation in a running instance (the refetch on an unknown `kid` is in the code but not tested).
