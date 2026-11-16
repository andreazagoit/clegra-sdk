# clegra

The Clegra apps SDK. MIT. You write one typed object, `defineApp({ entities, actions, pages, fragments,
agents, … })`. It becomes a JSON manifest for workspace hosts and a plain, conformant MCP server for ChatGPT, Claude
and any MCP client. Spec: [docs/developers/spec.md](../../docs/developers/spec.md).

```sh
npm i clegra zod
```

ESM JavaScript with its type declarations, Node 20+; `zod` 4 is a peer dependency, `next` (15+) an optional one.
Not on npm yet: [docs/developers/RELEASE.md](../../docs/developers/RELEASE.md) says how the tarball is made, checked and
(after the owner's yes) published.

| Entry | What |
| --- | --- |
| `clegra` | `defineApp`, `AuthError`, `SqlStore`, `MemoryStore`, types. Framework-agnostic (`app.fetch(request)`) |
| `clegra/next` | `toNextHandlers`, `withClegra`, `clegraRewrites`; `embedProxy`, `getEmbedCaller` for embedded pages (`next` is an optional peer dependency) |
| `clegra/node` | `listen(app)`: the app on Node's own HTTP server |
| `clegra/testing` | `testClient(app)`: JSON-RPC to `app.fetch` with dev tokens |
| `clegra/spec` | `checkApp`, `formatReport`: the conformance checks |
| CLI | `npx clegra init [dir] [--dry-run]`; `npx clegra check <url> [--token …]` (or `CLEGRA_TOKEN`) |

## Next.js: `npx clegra init`

In an existing App Router app, `npx clegra init` writes the three files below and wraps next.config. It also puts a
random local bearer in `.env.local` (`CLEGRA_LOCAL_TOKEN`), which the generated `resolve` accepts only when
`NODE_ENV` isn't `production`. It never overwrites a file, prints what it can't edit safely, and `--dry-run` writes
nothing. Then `npm run dev` and `npx clegra check http://localhost:3000 --token <CLEGRA_LOCAL_TOKEN>`.
See [docs/developers/quickstart.md](../../docs/developers/quickstart.md).

## Next.js: three files

```ts
// next.config.ts
import { withClegra } from "clegra/next"

export default withClegra({ /* your config: your rewrites, in any shape, are kept */ })
```

```ts
// app/api/clegra/[...path]/route.ts
import { toNextHandlers } from "clegra/next"
import { app } from "@/clegra"

export const { GET, POST, DELETE, OPTIONS } = toNextHandlers(app)
```

```ts
// clegra.ts
import { defineApp } from "clegra"

export const app = defineApp({
  name: "crm",
  title: "CRM",
  version: "1.0.0",
  auth: {
    resource: `${process.env.CLEGRA_PUBLIC_URL}/mcp`,
    authorizationServers: [`${process.env.CLEGRA_PUBLIC_URL}/api/auth`],
    resolve: async (token, request, { resource }) => {
      // Verify the token of your own sign-in (signature, expiry, aud === resource), then say who is calling.
      return { installation: "org-id", person: { id: "user-id", name: "Ada" }, permissions: ["deals.view"] }
    },
  },
  // permissions, entities (get/list on any database, scoped by ctx.installation), actions, pages…
})
```

- **`withClegra`** adds `beforeFiles` rewrites to the route for `/mcp`, `/.well-known/clegra.json` and the OAuth
  metadata paths (`oauth-protected-resource`, `oauth-authorization-server` and `openid-configuration`, each bare or
  with a path).
  - It keeps the app's own rewrites, in any shape: an array, an object, a sync or async function, or a config
    function.
  - It refuses `basePath` (the well-known paths must be at the root of the host) and `trailingSlash: true` (which
    redirects `/mcp` to `/mcp/`).
- **`toNextHandlers`** hands `app.fetch` each request at its public address.
  - The mount is taken off (`/api/clegra/mcp` → `/mcp`). A rewritten request arrives with its source path, and
    that path is kept.
  - Responses, SSE included, pass through unbuffered. Nothing is kept between requests, so it runs on serverless.
  - Options: `mount` (default `/api/clegra`, the same value in both functions) and `publicUrl`.
  - Leave defineApp's `path` unset: the mount does that job.

## Embedded pages (`/embed/*`)

A page `url: "/embed/board"` is a page of your site that hosts frame. The frame is cross-site, so the viewer is signed
in with a one-minute, single-use ticket the host asks for (`clegra_embed`) and posts into the frame; the app
answers with a `Secure; HttpOnly; SameSite=None; Partitioned` cookie for that page's path (spec §5.1).

```ts
// clegra.ts
defineApp({ …, embed: { frameAncestors: ["https://app.clegra.com", "https://chatgpt.com"], secret: process.env.CLEGRA_EMBED_SECRET } })

// proxy.ts
export const proxy = embedProxy(app)            // POST /embed/_ticket; frame-ancestors on every /embed response
export const config = { matcher: "/embed/:path*" }

// app/embed/board/page.tsx
const caller = await getEmbedCaller(app, "board") // null: no ticket, expired, or a top-level visit
```

`app.embed.exchange(request)` and `app.embed.caller(page, request)` are the same, framework-neutral; `app.fetch`
answers `POST <path>/_ticket` too (`clegra/node`).

## Public URL behind proxies and on Vercel

The public origin is `publicUrl`, else `CLEGRA_PUBLIC_URL` (an origin only, like `https://crm.example.com`), else
what the request says (`x-forwarded-host` / `x-forwarded-proto`, else `host`). A client can send those headers, so in
production set `CLEGRA_PUBLIC_URL` and `auth.resource`. Tokens are only accepted for `auth.resource`. Without
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

Recipes for better-auth, Clerk, Auth0 and WorkOS: [docs/developers/auth.md](../../docs/developers/auth.md).

Dev sign-in (`auth.dev`) answers loopback callers only. A Next route handler can't know the caller's address:
`x-forwarded-for` is whatever the client sent. So `toNextHandlers` refuses an app with `auth.dev`. Locally,
use init's bearer (`CLEGRA_LOCAL_TOKEN`) or your own sign-in, or run the app with `listen` from `clegra/node`.

## Kinds and references across apps

`kind: "person"` on an entity and `.meta({ as: "email", filter: true })` on a field say what the record is in the
words every app shares (spec §3.1; the vocabulary is `spec/kinds.json`, written with `npm run schema`). Key filters
(`email`, `vatID`, `gtin`, `uid`) reach `list` normalised and must be matched exactly. `ref.kind("organization")`
holds the URI of a record in any app (spec §3.2). Both are optional: apps without them are unchanged.

## Tests

```sh
npm test            # core + clegra/next unit tests
npx tsx --test "spec/src/**/*.test.ts"   # clegra init (fixture projects in temp folders)
npm run test:next   # test/fixture with next dev (port 3942), then next build + next start (3943); clegra check through the rewrites
npm run typecheck
npm run build       # dist/ (git-ignored): what the tarball ships; npm pack builds it itself
npm run pack:check  # slow: npm pack, then a fresh Next.js app outside the repository with the tarball (docs/developers/RELEASE.md)
```

In this repository the package exports its TypeScript source: the examples, Clegra and the tests import it through
the workspace with no build step. `npm pack` builds `dist/` and packs a package.json whose exports point there
(scripts/prepack.mjs; scripts/postpack.mjs puts the repository's back).
