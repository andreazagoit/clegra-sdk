# @clegra/sdk

The package Clegra apps are built with. MIT. You write one typed object, `defineApp({ entities, actions, pages,
fragments, agents, … })`. It becomes a plain, conformant MCP server (tools, MCP Apps views, OAuth) for ChatGPT, Claude
and any MCP client, and a JSON manifest Clegra reads to draw the app natively in its workspace. Spec: [docs/spec.md](docs/spec.md).

```sh
npm i @clegra/sdk zod
```

ESM JavaScript with its type declarations, Node 20+; `zod` 4 is a peer dependency and `next` (15+) an optional one: an
app that only serves MCP installs no React and no UI library. Clegra's design system is the separate package
`@clegra/ui` (below); this one does not depend on it.
Versions before 1.0 are prereleases on the dist-tag `next` (`npm i @clegra/sdk@next zod`); [docs/RELEASE.md](docs/RELEASE.md)
says how the tarball is made, checked and published.

| Entry | What |
| --- | --- |
| `@clegra/sdk` | `defineApp`, `AuthError`, `SqlStore`, `MemoryStore`, types. Framework-agnostic (`app.fetch(request)`) |
| `@clegra/sdk/next` | `toNextHandlers`, `withClegra`, `clegraRewrites`; `embedProxy`, `getEmbedCaller` for embedded pages (`next` is an optional peer dependency) |
| `@clegra/sdk/node` | `listen(app)`: the app on Node's own HTTP server |
| `@clegra/sdk/testing` | `testClient(app)`: JSON-RPC to `app.fetch` with dev tokens; `installationClient(app)` for schedules, later runs and lifecycle tools |
| `@clegra/sdk/spec` | `checkApp`, `formatReport`: the conformance checks |
| CLI | `npx @clegra/sdk init [dir] [--ui] [--dry-run]`; `npx @clegra/sdk check <url> [--token …]` (or `CLEGRA_TOKEN`) |

## Next.js: `npx @clegra/sdk init`

In an existing App Router app, `npx @clegra/sdk init` writes the three files below and wraps next.config. It also puts a
random local bearer in `.env.local` (`CLEGRA_LOCAL_TOKEN`), which the generated `resolve` accepts only when
`NODE_ENV` isn't `production`. It never overwrites a file, prints what it can't edit safely, and `--dry-run` writes
nothing. Then `npm run dev` and `npx @clegra/sdk check http://localhost:3000 --token <CLEGRA_LOCAL_TOKEN>`.
See [docs/quickstart.md](docs/quickstart.md).

## Next.js: three files

```ts
// next.config.ts
import { withClegra } from "@clegra/sdk/next"

export default withClegra({ /* your config: your rewrites, in any shape, are kept */ })
```

```ts
// app/api/clegra/[...path]/route.ts
import { toNextHandlers } from "@clegra/sdk/next"
import { app } from "@/clegra"

export const { GET, POST, DELETE, OPTIONS } = toNextHandlers(app)
```

```ts
// clegra.ts
import { defineApp } from "@clegra/sdk"

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
answers `POST <path>/_ticket` too (`@clegra/sdk/node`).

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

Recipes for better-auth, Clerk, Auth0 and WorkOS: [docs/auth.md](docs/auth.md).

Dev sign-in (`auth.dev`) answers loopback callers only. A Next route handler can't know the caller's address:
`x-forwarded-for` is whatever the client sent. So `toNextHandlers` refuses an app with `auth.dev`. Locally,
use init's bearer (`CLEGRA_LOCAL_TOKEN`) or your own sign-in, or run the app with `listen` from `@clegra/sdk/node`.

## Kinds and references across apps

`kind: "person"` on an entity and `.meta({ as: "email", filter: true })` on a field say what the record is in the
words every app shares (spec §3.1; the vocabulary is `spec/kinds.json`, written with `npm run schema`). Key filters
(`email`, `vatID`, `gtin`, `uid`) reach `list` normalised and must be matched exactly. `ref.kind("organization")`
holds the URI of a record in any app (spec §3.2). Both are optional: apps without them are unchanged.

## Navigation, page actions, schedules, notifications

All optional; names are checked by TypeScript and again when the app starts (a wrong one fails with its place named).

```ts
defineApp({
  …,
  pages: {
    tasks: { title: "Tasks", list: "task", columns: ["title"], actions: ["add_task"], badge: "open_count" },
    board: { title: "Board", dashboard: [{ type: "open_count", params: {} }] },
  },
  nav: [{ section: "Work", pages: ["tasks", "board"] }],      // without nav: every non-record page, in order
  schedules: { digest: { action: "send_digest", every: 60 } }, // minutes; a read or a write that isn't confirm: "always"
  notifications: { digest: { label: "Daily digest", permission: "tasks.view", default: false } },
})
```

- **Page `actions`**: global actions shown on the page, the first one as its primary. Page params fill in the
  action's inputs that have the same names. The generated view draws them as buttons that open the action's form.
  The page's `view` carries them, and the app's `nav` too.
- **`badge`**: a `stat` fragment with no required params. Its `value` is the page's count in the navigation.
- **`visibility: "app"`** on an entity, action or fragment: its tools are for views and the host's own UI only.
  They carry MCP Apps `_meta.ui.visibility: ["app"]`, `search`/`fetch` leave the records out, and agents can't use it.
- **`schedules`**: the workspace host calls the action as the installation, with no person and
  `_meta.clegra.schedule`. Handlers see `ctx.schedule`.
- **`ctx.notify({ type, title, to })`**: once the app declares `notifications`, every notification names one of
  them. `to` takes person ids or `{ permission }`. A call with no person must say `to`.
- **`targets`** on a global action: offered on an email (`mail.message`) or a record of a kind
  (`record:organization`). The input template is filled from the fields the target `needs` (`{subject}`,
  `{from.address}`, `{uri}`, `{title}`).

## Approve now, act later

```ts
publish: {
  title: "Publish", input: z.object({ text: z.string(), when: z.iso.datetime() }),
  later: { at: "when", window: 60 },            // a write with confirm "always"; window 10–10080 minutes
  run: (input, ctx) => { /* ctx.later: { id, at, until, confirmedAt }; ctx.person: who confirmed it */ },
}
```

When the person confirms, the call is stored instead of run. The store keeps the arguments as they were confirmed
and the host's proof (`until` = `at` + `window`). The answer is `{ data: { later: { id, at, until } } }`.

The SDK adds the schedule `clegra_later`, run every 5 minutes. Each due run is claimed once. Its arguments and proof
are checked again (the proof as of when it was confirmed), and then it runs as its author before `until`. If it can't
run (expired or refused), the author gets a `clegra_later` notification.

- Cancel a run with `ctx.cancelLater(id)`.
- Without a workspace host, `app.runLater(tenant)` runs the due runs from your own cron.
- A plain client can't produce a proof. Its confirmation is kept without one.
- The store needs a `later` part. `MemoryStore` and `SqlStore` have one. `SqlStore.schema()` returns both tables
  (`<table>`, `<table>_later`) and is safe to run again in a new migration.

## Lifecycle

```ts
lifecycle: {
  installation: (state, ctx) => {},                                     // "enabled" | "disabled" | "uninstalled"
  export: (ctx) => ({ contentType: "application/json", body: json }),  // or null: nothing kept
  delete: (ctx) => ({ counts: { tasks: 12 } }),                        // idempotent; also after uninstall
}
```

These become the app-only tools `clegra_installation`, `clegra_export` (one embedded file with its sha256) and
`clegra_delete`. Only the installation itself is given them: a workspace host's token with no person. `clegra_delete`
also removes the tenant's later runs.

```ts
const host = await installationClient(app)   // @clegra/sdk/testing
await host.schedule("digest"); await host.runLater(); const { file } = await host.exportData()
```

## Your own UI: `@clegra/ui`

An app's own pages and views can use Clegra's design system, the package `@clegra/ui` (its own repository, version
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

The package is the repository's root, so it is published from here (`npm publish --tag next`, [docs/RELEASE.md](docs/RELEASE.md)).

| Path | What | In the tarball |
| --- | --- | --- |
| `src/` | `@clegra/sdk`, `@clegra/sdk/next`, `@clegra/sdk/node`, `@clegra/sdk/testing` | built, as `dist/src` |
| `spec/` | `@clegra/sdk/spec` (conformance checks), the CLI (`clegra`: `init`, `check`), the manifest's JSON Schema, `kinds.json` | built, as `dist/spec` |
| `docs/` | The specification, quickstart, guides, release steps | `docs/spec.md` and `docs/quickstart.md` only |
| `examples/` | `crm` and `warehouse` (Next.js), `shipments` (Node): npm workspaces of this repository using `@clegra/sdk` as `file:../..` (its TypeScript source, no build step); `examples/deploy.sh` deploys a Next.js example to Vercel | no |
| `test/` | The real Next.js test (`test/fixture`) | no |
| `scripts/` | The build, `prepack`/`postpack`, the pack check, the hygiene check, the JSON Schema writer | no |
| `vendor/` | (git-ignored) the `@clegra/ui` tarball the pack check installs beside this package | no |

```sh
npm ci              # the package's tooling and the examples' dependencies (one lockfile)
npm run typecheck   # src, spec, scripts; typecheck:all adds the examples
npm test            # core, @clegra/sdk/next, clegra init (fixture projects in temp folders), the conformance checks
npm run test:examples   # the three examples' tests (the Next.js ones on an embedded Postgres, PGlite)
npm run test:next   # test/fixture with next dev (port 3942), then next build + next start (3943); clegra check through the rewrites; the embedded page in Chromium (Playwright)
npm run hygiene     # nothing private in any tracked file (scripts/hygiene.mjs)
npm run build       # dist/ (git-ignored): what the tarball ships; npm pack builds it itself
npm run pack:check  # slow: npm pack, the publish guard, a Node-only app (no React), a fresh Next.js app, and one with @clegra/ui too (vendor/)
```

In the repository the package exports its TypeScript source. `npm pack` and `npm publish` build `dist/` and swap in a
package.json whose exports point there (scripts/prepack.mjs); scripts/postpack.mjs puts the repository's back.
