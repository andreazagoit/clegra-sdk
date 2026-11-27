# @clegra/sdk

> The public repository, [github.com/andreazagoit/clegra-sdk](https://github.com/andreazagoit/clegra-sdk), is a
> read-only snapshot of each version, published from where the package is developed: issues are welcome there,
> pull requests are not merged.

The package Clegra apps are built with. MIT. You write one thing per file (`defineEntity`, `defineAction`,
`definePage`, `defineArtifact`, …), assemble them with `defineApp({ entities: [...], actions: [...], pages: [...] })`,
and run them with `serve(app, { auth, store, … })`. The app becomes a plain, conformant MCP server (tools, MCP Apps
views, OAuth) for ChatGPT, Claude and any MCP client, a JSON manifest Clegra reads to draw the app natively in its
workspace, and an OpenAPI 3.1 index of the same operations. Spec: [docs/spec.md](docs/spec.md).

```sh
npm i @clegra/sdk@next zod
```

ESM JavaScript with its type declarations, Node 20+; `zod` 4 is a peer dependency and `next` (15+) an optional one: an
app that only serves MCP installs no React and no UI library. Clegra's design system is the separate package
`@clegra/ui` (below); this one does not depend on it.
Versions before 1.0 are prereleases on the dist-tag `next` (`npm i @clegra/sdk@next zod`); [docs/RELEASE.md](docs/RELEASE.md)
says how the tarball is made, checked and published.

| Entry | What |
| --- | --- |
| `@clegra/sdk` | `defineEntity`, `defineAction`, `defineArtifact`, `defineComponent`, `definePage`, `defineAgent`, `defineApp`, `serve`, `AuthError`, `SqlStore`, `MemoryStore`, `useHostLookup`, types. Web APIs only: `served.fetch(request)` runs on any runtime |
| `@clegra/sdk/signin` | `createSignIn`, `devSignIn`, `passwordLogin`, `MemorySignInStore`, `SqlSignInStore`, `frameCookie`, `newSignInKey`: the app's own OAuth 2.1 server on its login, and its development form (Web APIs only) |
| `@clegra/sdk/next` | `toNextHandlers(served)`, `withClegra`, `clegraRewrites`; `siteProxy`, `<ClegraSite />` for the app's own site (`next` is an optional peer dependency) |
| `@clegra/sdk/node` | `listen(served)`: the app on Node's own HTTP server; `toNodeHandler(served)` for any Node server |
| `@clegra/sdk/express` | `clegraMiddleware(served)`: the app's routes in an Express (or Connect) app |
| `@clegra/sdk/testing` | `testClient(served)`: JSON-RPC to `served.fetch` with development tokens; `installationClient(served)` for schedules, later runs and lifecycle tools |
| `@clegra/sdk/spec` | `checkApp`, `formatReport`: the conformance checks |
| `@clegra/sdk/spec/protocol`, `@clegra/sdk/spec/kinds` | For workspace hosts: the protocol's names (manifest path, URI scheme, `_meta` key, token claim, reserved tools, the site's paths and messages) and the kinds vocabulary with its key normalisation (`KINDS`, `keyOf`, `normaliseKey`, `kindOfRecord`, …). No Node built-ins: safe in a browser bundle |
| CLI | `npx @clegra/sdk init [dir] [--ui] [--dry-run]`; `npx @clegra/sdk check <url> [--token …]` (or `CLEGRA_TOKEN`) |

## Next.js: `npx @clegra/sdk init`

In an existing App Router app, `npx @clegra/sdk init` writes a `clegra/` folder (one file per thing: an entity, an
action, a page, `app.ts`, `index.ts`) and the route below, and wraps next.config. It also puts a
random local bearer in `.env.local` (`CLEGRA_LOCAL_TOKEN`), which the generated `resolve` accepts only when
`NODE_ENV` isn't `production`. It never overwrites a file, prints what it can't edit safely, and `--dry-run` writes
nothing. Then `npm run dev` and `npx @clegra/sdk check http://localhost:3000 --token <CLEGRA_LOCAL_TOKEN>`.
Two guides: [plain JavaScript](docs/start-javascript.md) and [Next.js](docs/start-next.md).

## Next.js: three files

```ts
// next.config.ts
import { withClegra } from "@clegra/sdk/next"

export default withClegra({ /* your config: your rewrites, in any shape, are kept */ })
```

```ts
// app/api/clegra/[...path]/route.ts
import { toNextHandlers } from "@clegra/sdk/next"
import { served } from "@/clegra"

export const { GET, POST, DELETE, OPTIONS } = toNextHandlers(served)
```

```ts
// clegra/app.ts: the definition, pure (each entity, action and page in its own file, imported)
import { defineApp } from "@clegra/sdk"
import { deal } from "./entities/deal"
import { markWon } from "./actions/mark-won"
import { dealsPage } from "./pages/deals"

export const app = defineApp({
  name: "crm",
  title: "CRM",
  version: "1.0.0",
  permissions: { "deals.view": { label: "See deals" }, "deals.edit": { label: "Change deals" } },
  entities: [deal],
  actions: [markWon],
  pages: [dealsPage],
})
```

```ts
// clegra/index.ts: how it runs
import { serve } from "@clegra/sdk"
import { app } from "./app"

export const served = serve(app, {
  auth: {
    resource: `${process.env.CLEGRA_PUBLIC_URL}/mcp`,
    authorizationServers: [`${process.env.CLEGRA_PUBLIC_URL}/api/auth`],
    resolve: async (token, request, { resource }) => {
      // Verify the token of your own sign-in (signature, expiry, aud === resource), then say who is calling.
      return { installation: "org-id", person: { id: "user-id", name: "Ada" }, permissions: ["deals.view"] }
    },
  },
})
```

- **`withClegra`** adds `beforeFiles` rewrites to the route for `/mcp`, `/.well-known/clegra.json`, `/openapi.json`,
  `/operations/…`, the sign-in module's `/oauth/…` and the OAuth
  metadata paths (`oauth-protected-resource`, `oauth-authorization-server` and `openid-configuration`, each bare or
  with a path).
  - It keeps the app's own rewrites, in any shape: an array, an object, a sync or async function, or a config
    function.
  - It refuses `basePath` (the well-known paths must be at the root of the host) and `trailingSlash: true` (which
    redirects `/mcp` to `/mcp/`).
- **`toNextHandlers`** hands `served.fetch` each request at its public address.
  - The mount is taken off (`/api/clegra/mcp` → `/mcp`). A rewritten request arrives with its source path, and
    that path is kept.
  - Responses, SSE included, pass through unbuffered. Nothing is kept between requests, so it runs on serverless.
  - Options: `mount` (default `/api/clegra`, the same value in both functions) and `publicUrl`.
  - Leave serve's `path` unset: the mount does that job.

## Your own site in Clegra

An app with a website of its own is shown in Clegra's clients **as that site**: the client frames your real pages at
your own origin and draws nothing around them (spec §5.1). Clegra never signs anyone in to your app: the person signs
in with your own sign-in inside the frame (your session cookie `Secure; HttpOnly; SameSite=None; Partitioned`), and
links your app to Clegra's assistant in the same frame, through your consent (`response_mode=web_message`).

```ts
// clegra/index.ts
serve(app, { …, site: { start: "/" }, clientOrigins: ["https://app.clegra.com", "app://client"] })

// proxy.ts: every page framable by those client origins only
export const proxy = siteProxy(served)
export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] }

// app/layout.tsx: the bridge (where the person is; the client's theme and language)
<body>{children}<ClegraSite /></body>
```

Without Next: `served.site.headers()` gives the framing policy for every page, and
`<script src="/clegra/site/bridge.js" async></script>` loads the bridge. The SDK's generated views stay for apps
without a site and for every other host (ChatGPT, Claude).

## Public URL behind proxies and on Vercel

The public origin is `publicUrl`, else `CLEGRA_PUBLIC_URL` (an origin only, like `https://crm.example.com`), else
what the request says (`x-forwarded-host` / `x-forwarded-proto`, else `host`). A client can send those headers, so in
production set `CLEGRA_PUBLIC_URL` and `auth.resource`. Tokens are only accepted for `auth.resource`. Without
`auth.resource` in production, every request but the manifest answers `500 misconfigured`. On Vercel, preview deployments have other
hosts: give each environment its own value.

## Auth: write `auth.resolve` yourself

The app verifies its own access tokens: those its sign-in (better-auth, Clerk, Auth0, WorkOS, …) issues to MCP clients.

- `auth.resolve(token, request, { resource })` checks the signature, the expiry and that the audience is exactly
  `resource` (RFC 8707). For a JWT that is `jwtVerify` from `jose` with the issuer's JWKS.
- It returns `{ installation, person, permissions }` (the tenant comes from the token, never from a parameter). It
  returns null, or throws `AuthError`, to refuse.
- `auth.authorizationServers` names your authorization server in the protected-resource metadata.
- `auth.serve(request)` can answer its RFC 8414 metadata at the root.

Recipes for better-auth, Clerk, Auth0 and WorkOS: [docs/auth.md](docs/auth.md).

## Your sign-in: `@clegra/sdk/signin`

An app without an OAuth server of its own gets one on top of its login: `createSignIn(app, { issuer, resource,
login, permissionsOf, store, keys, clientOrigins })`, then `serve(app, { auth: { signIn } })` (spec §7, «Your sign-in»;
[docs/auth.md](docs/auth.md)). Every client (Clegra, Claude, ChatGPT) acts for a person only with the delegation your
app issued through your consent: `at+jwt` tokens for exactly your MCP address (DPoP-bound when the client proves a
key), refresh rotation with reuse detection, RFC 7009, Client ID Metadata Documents, `web_message` for a framing
client. Personal keys (`signIn.keys`) for background work; `passwordLogin` for an app with no login at all.

Locally, `devSignIn(app)` is the same module over test people (a code printed on the console) with development
tokens and confirmation proofs for tests (`served.dev`, `testClient`); refused in production, its development tokens
count from loopback callers only.

## The index as OpenAPI

`GET /openapi.json` is the app's operations as an OpenAPI 3.1 document (effects as `x-clegra-effect`, the pages as
`x-clegra-pages`), each callable as `POST /operations/<tool>` with the same caller and checks as its MCP tool; a write
takes an `Idempotency-Key` (spec §7, «The index as OpenAPI»).

## Kinds and references across apps

`kind: "person"` on an entity and `.meta({ as: "email", filter: true })` on a field say what the record is in the
words every app shares (spec §3.1; the vocabulary is `spec/kinds.json`, written with `npm run schema`). Key filters
(`email`, `vatID`, `gtin`, `uid`) reach `list` normalised and must be matched exactly. `ref.kind("organization")`
holds the URI of a record in any app (spec §3.2). Both are optional: apps without them are unchanged.

## Navigation, page actions, schedules, notifications

All optional; things are named by their handles, checked by TypeScript and again in `defineApp` (a wrong one fails
with its place named).

```ts
export const tasksPage = definePage({ name: "tasks", title: "Tasks", list: task, columns: ["title"], actions: [addTask], badge: openCount })
export const boardPage = definePage({ name: "board", title: "Board", dashboard: [{ artifact: openCount }] })

defineApp({
  …,
  pages: [tasksPage, boardPage],
  nav: [{ section: "Work", pages: [tasksPage, boardPage] }],      // without nav: every non-record page, in order
  schedules: [{ name: "digest", action: sendDigest, every: 60 }], // minutes; a read or a write that isn't confirm: "always"
  notifications: { digest: { label: "Daily digest", permission: "tasks.view", default: false } },
})
```

- **Page `actions`**: global actions shown on the page, the first one as its primary. Page params fill in the
  action's inputs that have the same names. The generated view draws them as buttons that open the action's form.
  The page's `view` carries them, and the app's `nav` too.
- **`badge`**: a `stat` artifact with no required params. Its `value` is the page's count in the navigation.
- **`visibility: "app"`** on an entity, action or artifact: its tools are for views and the host's own UI only.
  They carry MCP Apps `_meta.ui.visibility: ["app"]`, `search`/`fetch` leave the records out, and agents can't use it.
- **`schedules`**: the workspace host calls the action as the installation, with no person and
  `_meta.clegra.schedule`. Handlers see `ctx.schedule`.
- **`ctx.notify({ type, title, to })`**: once the app declares `notifications`, every notification names one of
  them. `to` takes person ids or `"admins"` (the company's administrators). A call with no person must say `to`.
- **`targets`** on a global action: offered on an email (`mail.message`) or a record of a kind
  (`record:organization`). The input template is filled from the fields the target `needs` (`{subject}`,
  `{from.address}`, `{uri}`, `{title}`).

## Approve now, act later

```ts
export const publish = defineAction({
  name: "publish", title: "Publish", input: z.object({ text: z.string(), when: z.iso.datetime() }),
  later: { at: "when", window: 60 },            // a write with confirm "always"; window 10–10080 minutes
  run: (input, ctx) => { /* ctx.later: { id, at, until, confirmedAt }; ctx.person: who confirmed it */ },
})
```

When the person confirms, the call is stored instead of run. The store keeps the arguments as they were confirmed
and the host's proof (`until` = `at` + `window`). The answer is `{ data: { later: { id, at, until } } }`.

The SDK adds the schedule `clegra_later`, run every 5 minutes. Each due run is claimed once. Its arguments and proof
are checked again (the proof as of when it was confirmed), and then it runs as its author before `until`. If it can't
run (expired or refused), the author gets a `clegra_later` notification.

- Cancel a run with `ctx.cancelLater(id)`.
- Without a workspace host, `served.runLater(tenant)` runs the due runs from your own cron.
- A plain client can't produce a proof. Its confirmation is kept without one.
- The store needs a `later` part. `MemoryStore` and `SqlStore` have one. `SqlStore.schema()` returns both tables
  (`<table>`, `<table>_later`) and is safe to run again in a new migration.

## Lifecycle

```ts
defineApp({ …, lifecycle: {
  installation: (state, ctx) => {},                                     // "enabled" | "disabled" | "uninstalled"
  export: (ctx) => ({ contentType: "application/json", body: json }),  // or null: nothing kept
  delete: (ctx) => ({ counts: { tasks: 12 } }),                        // idempotent; also after uninstall
} })
```

These become the app-only tools `clegra_installation`, `clegra_export` (one embedded file with its sha256) and
`clegra_delete`. Only the installation itself is given them: a workspace host's token with no person. `clegra_delete`
also removes the tenant's later runs.

```ts
const host = await installationClient(served)   // @clegra/sdk/testing; served with devSignIn
await host.schedule("digest"); await host.runLater(); const { file } = await host.exportData()
```

## Your own UI: `@clegra/ui`

An app's own pages and views can use Clegra's design system, the package `@clegra/ui` (a separate package on npm, with its own version
and guide): components for React and React Native, the theme (light and dark), tokens and `<ClegraProvider>` (an
MCP Apps view that takes the host's look). The view `@clegra/sdk` generates is plain HTML and needs none of it.

```sh
npx @clegra/sdk init --ui && npm install   # @clegra/ui and its web libraries into package.json, its stylesheet after Tailwind
```

```css
/* app/globals.css (Tailwind 4); without Tailwind: import "@clegra/ui/prebuilt.css" in the root layout */
@import "tailwindcss";
@import "@clegra/ui/styles.css";
```

```tsx
import { Button } from "@clegra/ui/components/button"
import { ClegraProvider } from "@clegra/ui/frame"
```

## This repository

The package is the repository's root; `.github/workflows/publish.yml` publishes each new version to npm with provenance ([docs/RELEASE.md](docs/RELEASE.md)).

| Path | What | In the tarball |
| --- | --- | --- |
| `src/` | `@clegra/sdk`, `@clegra/sdk/signin`, `@clegra/sdk/next`, `@clegra/sdk/node`, `@clegra/sdk/express`, `@clegra/sdk/testing` | built, as `dist/src` |
| `spec/` | `@clegra/sdk/spec` (conformance checks), the CLI (`clegra`: `init`, `check`), the manifest's JSON Schema, `kinds.json` | built, as `dist/spec` |
| `docs/` | The specification, the two getting-started guides, guides, release steps | `docs/spec.md`, `docs/start-javascript.md` and `docs/start-next.md` only |
| `examples/` | `crm` and `warehouse` (Next.js), `shipments` (Node): npm workspaces of this repository using `@clegra/sdk` as `file:..` (its TypeScript source, no build step), run locally | no |
| `test/` | The real Next.js test (`test/fixture`) | no |
| `scripts/` | The build, `prepack`/`postpack`, the pack check, the JSON Schema writer | no |
| `vendor/` | (git-ignored) the `@clegra/ui` tarball the pack check installs beside this package | no |

```sh
npm ci              # the package's tooling and the examples' dependencies (one lockfile)
npm run typecheck   # src, spec, scripts; typecheck:all adds the examples
npm test            # core, @clegra/sdk/next, clegra init (fixture projects in temp folders), the conformance checks
npm run test:examples   # the three examples' tests (the Next.js ones on an embedded Postgres, PGlite)
npm run test:next   # test/fixture with next dev (port 3942), then next build + next start (3943); clegra check through the rewrites; the app's own site framed by a Clegra client harness in Chromium (Playwright)
npm run build       # dist/ (git-ignored): what the tarball ships; npm pack builds it itself
npm run pack:check  # slow: npm pack, the publish guard, a Node-only app (no React), a fresh Next.js app, and one with @clegra/ui too (vendor/)
```

In the repository the package exports its TypeScript source. `npm pack` and `npm publish` build `dist/` and swap in a
package.json whose exports point there (scripts/prepack.mjs); scripts/postpack.mjs puts the repository's back.
