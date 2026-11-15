# modelapp

The Model App Protocol (MAP) SDK. MIT. You write one typed object, `defineApp({ entities, actions, pages, fragments,
agents, … })`. It becomes a JSON manifest for workspace hosts and a plain, conformant MCP server for ChatGPT, Claude
and any MCP client. Spec: [docs/map/spec.md](../../docs/map/spec.md).

```sh
npm i modelapp zod
```

| Entry | What |
| --- | --- |
| `modelapp` | `defineApp`, `AuthError`, `SqlStore`, `MemoryStore`, types. Framework-agnostic (`app.fetch(request)`) |
| `modelapp/next` | `toNextHandlers`, `withModelApp`, `modelAppRewrites` for Next.js (`next` is an optional peer dependency) |
| `modelapp/node` | `listen(app)`: the app on Node's own HTTP server |
| `modelapp/testing` | `testClient(app)`: JSON-RPC to `app.fetch` with dev tokens |
| `modelapp/spec` | `checkApp`, `formatReport`: the conformance checks |
| CLI | `npx modelapp check <url> [--token …]` (or `MODELAPP_TOKEN`) |

## Next.js: three files

```ts
// next.config.ts
import { withModelApp } from "modelapp/next"

export default withModelApp({ /* your config: your rewrites, in any shape, are kept */ })
```

```ts
// app/api/modelapp/[...path]/route.ts
import { toNextHandlers } from "modelapp/next"
import { app } from "@/modelapp"

export const { GET, POST, DELETE, OPTIONS } = toNextHandlers(app)
```

```ts
// modelapp.ts
import { defineApp } from "modelapp"

export const app = defineApp({
  name: "crm",
  title: "CRM",
  version: "1.0.0",
  auth: {
    resource: `${process.env.MODELAPP_PUBLIC_URL}/mcp`,
    authorizationServers: [`${process.env.MODELAPP_PUBLIC_URL}/api/auth`],
    resolve: async (token, request, { resource }) => {
      // Verify the token of your own sign-in (signature, expiry, aud === resource), then say who is calling.
      return { installation: "org-id", person: { id: "user-id", name: "Ada" }, permissions: ["deals.view"] }
    },
  },
  // permissions, entities (get/list on any database, scoped by ctx.installation), actions, pages…
})
```

- **`withModelApp`** adds `beforeFiles` rewrites to the route for `/mcp`, `/.well-known/modelapp.json` and the OAuth
  metadata paths (`oauth-protected-resource`, `oauth-authorization-server` and `openid-configuration`, each bare or
  with a path).
  - It keeps the app's own rewrites, in any shape: an array, an object, a sync or async function, or a config
    function.
  - It adds `modelapp` to `transpilePackages`, because the package ships TypeScript source.
  - It refuses `basePath` (the well-known paths must be at the root of the host) and `trailingSlash: true` (which
    redirects `/mcp` to `/mcp/`).
- **`toNextHandlers`** hands `app.fetch` each request at its public address.
  - The mount is taken off (`/api/modelapp/mcp` → `/mcp`). A rewritten request arrives with its source path, and
    that path is kept.
  - Responses, SSE included, pass through unbuffered. Nothing is kept between requests, so it runs on serverless.
  - Options: `mount` (default `/api/modelapp`, the same value in both functions) and `publicUrl`.
  - Leave defineApp's `path` unset: the mount does that job.

## Public URL behind proxies and on Vercel

The public origin is `publicUrl`, else `MODELAPP_PUBLIC_URL` (an origin only, like `https://crm.example.com`), else
what the request says (`x-forwarded-host` / `x-forwarded-proto`, else `host`). A client can send those headers, so in
production set `MODELAPP_PUBLIC_URL` and `auth.resource`. Tokens are only accepted for `auth.resource`. Without
`auth.resource` in production, every request answers `500 misconfigured`. On Vercel, preview deployments have other
hosts: give each environment its own value.

## Auth: write `auth.resolve` yourself

The app verifies its own access tokens: those its sign-in (better-auth, Clerk, Auth0, WorkOS, …) issues to MCP clients.

- `auth.resolve(token, request, { resource })` checks the signature, the expiry and that the audience is exactly
  `resource` (RFC 8707). For a JWT that is `jwtVerify` from `jose` with the issuer's JWKS.
- It returns `{ installation, person, permissions }` (the tenant comes from the token, never from a parameter). It
  returns null, or throws `AuthError`, to refuse.
- `auth.authorizationServers` names your authorization server in the protected-resource metadata.
- `auth.serve(request)` can answer its RFC 8414 metadata at the root.

Recipes per sign-in library are in [docs/map](../../docs/map).

Dev sign-in (`auth.dev`) answers loopback callers only. A Next route handler can't know the caller's address:
`x-forwarded-for` is whatever the client sent. So `toNextHandlers` refuses an app with `auth.dev`. Use your own
sign-in locally, or run the app with `listen` from `modelapp/node`.

## Tests

```sh
npm test            # core + modelapp/next unit tests
npm run test:next   # test/fixture with next dev (port 3942), then next build + next start (3943); modelapp check through the rewrites
npm run typecheck
```
