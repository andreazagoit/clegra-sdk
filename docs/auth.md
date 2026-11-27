# Sign-in: the module, or your own authorization server

The person signs in **on the app's own page**, in their system browser, and consents; the client then holds a grant
the app issued. That one login gives the client its MCP token and, by session transfer, a session of the app's pages
([access](extensions/access.md), [session transfer](extensions/session-transfer.md)). Two ways:

1. **The sign-in module** (`@clegra/sdk/signin`): an OAuth 2.1 authorization server on top of your login.
2. **Your own authorization server** (better-auth, Clerk, Auth0, WorkOS…): `serve(app, { auth: { verify, … } })`.

## 1. The sign-in module

```ts
import { serve, SqlStore } from "@clegra/sdk"
import { createSignIn, passwordLogin, SqlSignInStore } from "@clegra/sdk/signin"

const store = new SqlSignInStore(query)                    // SqlSignInStore.schema() in your migrations
const login = passwordLogin({ store, origin: "https://jobs.example.com", title: { en: "Jobs", it: "Lavori" } })
const signIn = createSignIn(app, {
  issuer: "https://jobs.example.com",                      // the app's origin
  resource: "https://jobs.example.com/mcp",                // the one audience of its tokens
  login,                                                   // or your own Login
  active: (person) => login.active(person),                // false: the person left; every token refused at once
  store,
  keys: [JSON.parse(process.env.SIGN_IN_KEY!)],            // newSignInKey() makes one; required in production
})
export const served = serve(app, { origin: "https://jobs.example.com", auth: { signIn }, store: new SqlStore(query) })
```

`Login` is your login under the module: `session(request) → { id, name, email?, tenant? } | null` (who is signed in
from their own credentials), `signInUrl(returnTo, request)`, and optionally `fetch(request)` for its own routes.
`passwordLogin` is a ready one: accounts with email and password (PBKDF2-SHA256; `login.accounts.create/update/
remove/list/get`), its page at `/signin` (`/signin/out` to sign out), a session cookie that also works inside a
client's frame. `serve` uses the same `login.session` for the confirmation page, session transfer, the access log and
generated pages.

What it serves:

| Path | What |
|---|---|
| `/.well-known/oauth-authorization-server` | RFC 8414 metadata |
| `/oauth/authorize` | Sign-in (your login), then consent: each requested scope on its own line, the client (host of `client_id`, redirect target), a warning for loopback or custom-scheme redirects. Never framed, never remembered |
| `/oauth/token` | Authorization code with PKCE S256; refresh |
| `/oauth/revoke` | RFC 7009 |
| `/oauth/jwks.json` | The signing keys |
| `/oauth/grants` | The person's grants (client, scopes, created, last used, background, browser sessions), each with «Revoke»; a link to «Download the access log» (`/access/log`) |

- **Clients** identify themselves with a Client ID Metadata Document (an https URL), public or with a key pair
  (`private_key_jwt`); no dynamic registration. The document's host is resolved and refused if it points inside the
  network.
- **Scopes** are the access profile's: `web.read`, `web.write`, `web.irreversible`, `bound_browser_session`,
  `browser_session` (only when the app sets `sessionTransfer: { link: true }`, else `invalid_scope`),
  `offline_access`. A request with none gets `web.read`; a grant holds only what was asked (ACC-1).
- **Tokens**: `at+jwt`, EdDSA, `aud` = `resource`, ten minutes (`accessTokenSeconds`); bound to the client's key
  (`cnf.jkt`) when the token request carries a DPoP proof (then sent as `Authorization: DPoP`). Refresh tokens rotate
  on every use; a used one presented again revokes the whole grant. They live `refreshTokenDays` (default 30) with
  `offline_access`, else 12 hours from the grant (ACC-5).
- **Revocation** from the grants page, a refresh reuse, RFC 7009, `signIn.grants.revoke(person, id)`,
  `signIn.revokeGrant(id)` or `signIn.forget(person)` reaches `serve` (`onRevoke`): transferred sessions end, pending
  confirmations and event subscriptions are cancelled. A revocation from the confirmation page («Not you?») reaches
  the module the same way.

### Development: `devSignIn`

```ts
const signIn = devSignIn(app, { issuer: "http://localhost:3000", people: [{ id: "ada", name: "Ada" }], code: "LOCAL123" })
```

The same module over test people: its login at `/oauth/dev-login` asks for a code (random unless given;
`signIn.dev.code`), keys live in memory. `signIn.dev.token({ person?, scopes?, clientId?, clientName? })` signs a
development token for tests (default every scope the app offers; its grant id is `dev:<person>:<client>`), accepted
only on a loopback host. `devSignIn` is refused when `NODE_ENV` is `production`.

## 2. Your own authorization server

```ts
serve(app, {
  origin: "https://jobs.example.com",
  auth: {
    authorizationServers: ["https://auth.example.com"],
    verify: async (token, request, { resource }) => { /* → Grant | null */ },
    sessions: { read: (request) => yourSession(request), signInUrl: (returnTo) => `/sign-in?next=${encodeURIComponent(returnTo)}` },
    revoke: (grantId) => yourAuth.revoke(grantId),       // the person chose «Decline and revoke»
  },
})
```

`verify` must check the signature, the expiry and that the audience is exactly `resource` (the MCP URL, RFC 8707),
and return the `Grant`: `{ id, clientId, clientName?, person: { id, name, email?, tenant? }, scopes }`. `id` must be
stable for the life of the grant (one client for one person): revocation, transferred sessions and confirmations key
on it. Return null (or throw) to refuse. `sessions.read` returns the person of the app's own browser session, from
their own credentials, never a session the SDK transferred.

A JWT with `jose`:

```ts
import { createRemoteJWKSet, jwtVerify } from "jose"
const jwks = createRemoteJWKSet(new URL("https://auth.example.com/.well-known/jwks.json"))

verify: async (token, _request, { resource }) => {
  const { payload } = await jwtVerify(token, jwks, { issuer: "https://auth.example.com", audience: resource })
  const scopes = String(payload.scope ?? "").split(" ").filter(Boolean)
  const clientId = String(payload.client_id ?? payload.azp ?? "")
  return { id: String(payload.sid ?? `${clientId}:${payload.sub}`), clientId, person: { id: String(payload.sub), name: String(payload.name ?? payload.sub) }, scopes }
}
```

Recipes, to check against your provider's settings (claim names and options differ by provider and version):

- **better-auth** (its OAuth provider / MCP plugin): verify the access token against its JWKS with the MCP URL as
  audience; `sessions.read` is its session API on the request's cookies.
- **Clerk**: OAuth access tokens for your application, verified with its JWKS; the audience must be the MCP URL
  (configure it, and refuse tokens without it); `sessions.read` from its session token on the request.
- **Auth0**: an API whose identifier is the MCP URL (the audience); define the scopes above on the API; the grant id
  from `sid` if present, else client and subject.
- **WorkOS**: AuthKit's access tokens verified with its JWKS; the audience as configured for the MCP resource.

Whatever the provider: offer the scopes of the access profile (or enforce them in `verify`), keep access tokens
short, and give the person a page that lists and revokes grants (ACC-6) — it is the one part no SDK can do for you.
