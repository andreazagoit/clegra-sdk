# @clegra/sdk

> The public repository, [github.com/andreazagoit/clegra-sdk](https://github.com/andreazagoit/clegra-sdk), is a
> read-only snapshot of each version, published from where the package is developed: issues are welcome there,
> pull requests are not merged.

The package Clegra apps are built with. MIT.

A Clegra app is a **web app with a plain MCP server** (revision `2026-07-28`, the official
`@modelcontextprotocol/server` underneath) plus a few small MCP extensions and profiles
([docs/extensions](docs/extensions/README.md)):

- **the agent always uses MCP tools**, interactive and in the background; each tool says truthfully what it does and
  names its record type and its page;
- **pages are for people**: every record is a resource at its own web URL, the app's pages, navigation, counters and
  tiles are resources inside the MCP server, per person;
- **one sign-in**: one OAuth login on the app's own page gives the client its MCP token and, through session
  transfer, a session of the app's pages; what cannot be undone is confirmed by the person on the app's own page.

| Extension or profile | What |
| --- | --- |
| [web-map](docs/extensions/web-map.md) | `com.clegra/web-map`: tools, records (web URLs) and pages joined; badges, tiles, Server Card |
| [app-share](docs/extensions/app-share.md) | `com.clegra/app-share`: share between apps, and targeted plugins |
| [session-transfer](docs/extensions/session-transfer.md) | One sign-in for the grant and the pages |
| [access](docs/extensions/access.md) | Scopes, grants, revocation, the log |
| [app-agents](docs/extensions/app-agents.md) | Agents shipped as skills |
| [confirmation](docs/extensions/confirmation.md) | Confirmation verified by the app (URL-mode elicitation) |
| [event-types](docs/extensions/event-types.md) | Notifications and activities |

```sh
npm i @clegra/sdk@next zod
```

ESM JavaScript with its type declarations, Node 20+; `zod` 4 is a peer dependency and `next` (15+) an optional one.
Versions before 1.0 are prereleases on the dist-tag `next`; [docs/RELEASE.md](docs/RELEASE.md) says how the tarball
is made, checked and published.

| Entry | What |
| --- | --- |
| `@clegra/sdk` | `defineEntity`, `defineTool`, `definePage`, `defineBadge`, `defineWidget`, `defineAgent`, `defineApp`, `serve`, `AppError`, `MemoryStore`, `SqlStore`, `SCOPES`, `agentDigest`, types. Web APIs only: `served.fetch(request)` runs on any runtime |
| `@clegra/sdk/signin` | `createSignIn`, `devSignIn`, `passwordLogin`, `MemorySignInStore`, `SqlSignInStore`, `newSignInKey`, `frameCookie`: the app's own OAuth 2.1 server on its login, with the access profile's scopes and the grants page |
| `@clegra/sdk/next` | `toNextHandlers(served)`, `withClegra`, `clegraRewrites`, `recordProxy` |
| `@clegra/sdk/node` | `listen(served)`, `toNodeHandler(served)` |
| `@clegra/sdk/express` | `clegraMiddleware(served)` |
| `@clegra/sdk/testing` | `testClient(served, { token })` (MCP `2026-07-28` against `served.fetch`), `confirmOnPage` |
| CLI | `npx @clegra/sdk check <url> --token …` (the adoption level: A, B1, B2, C); `npx @clegra/sdk init` (Next.js) |

## In one screen

```ts
import { defineApp, defineEntity, definePage, defineTool, serve } from "@clegra/sdk"
import { listen } from "@clegra/sdk/node"
import { devSignIn } from "@clegra/sdk/signin"
import { z } from "zod"

const job = defineEntity({
  name: "job", title: "Job", path: "/jobs/{id}",                     // the record's web URL = its MCP resource URI
  schema: z.object({ id: z.string(), title: z.string(), status: z.string() }),
  card: { title: "title", status: "status" },
  get: ({ id }, ctx) => db.job(ctx.person, id!),
})
const jobPage = definePage({ name: "job", title: "Job", path: "/jobs/{id}", role: "record", entity: job })
const complete = defineTool({
  name: "job.complete", title: "Complete job", description: "Closes a job",
  input: z.object({ id: z.string() }),                              // the job's URL
  annotations: { readOnly: false, destructive: false, idempotent: true },
  entity: job, on: "record", page: jobPage,
  run: async (_input, ctx, record) => ({ records: [{ entity: job, record: await db.complete(ctx.person, record) }] }),
})
const app = defineApp({ name: "jobs", title: "Jobs", description: "Job requests", version: "1.0.0", entities: [job], tools: [complete], pages: [jobPage] })

await listen(serve(app, { origin: "http://localhost:3000", auth: { signIn: devSignIn(app) }, pages: "generated" }), { port: 3000 })
```

A tool that sends, pays, shares or deletes for good gets `confirm: { message, values }`: the SDK asks the person on
the app's own page (URL-mode elicitation, or a link for clients without it) and runs the call once.

Read next: [docs/spec.md](docs/spec.md) (the reference), [docs/start-javascript.md](docs/start-javascript.md),
[docs/start-next.md](docs/start-next.md), [docs/auth.md](docs/auth.md), [docs/ai-guide.md](docs/ai-guide.md).

## Public URL

The public origin is `serve(app, { origin })`, else `CLEGRA_PUBLIC_URL`. In production one of them is required (it is
never taken from a request): tokens are accepted only for `<origin>/mcp`, and every URL of the web map is on it. On
Vercel, preview deployments have other hosts: give each environment its own value.

## This repository

The package is the repository's root; `.github/workflows/publish.yml` publishes each new version to npm with
provenance ([docs/RELEASE.md](docs/RELEASE.md)).

| Path | What | In the tarball |
| --- | --- | --- |
| `src/` | Every entry, the CLI (`src/cli/`) | built, as `dist/src` |
| `docs/` | The reference, the two getting-started guides, the extensions, guides, release steps | `docs/spec.md`, the start guides, `docs/accents.svg`, `docs/extensions/*.md` |
| `test/` | The real Next.js test (`test/fixture`) | no |
| `scripts/` | The build, `prepack`/`postpack`, the pack check | no |

```sh
npm ci              # the package's tooling (one lockfile)
npm run typecheck
npm test            # the core, the sign-in module, the adapters, the CLI
npm run test:next   # test/fixture with next dev, then next build + next start
npm run build       # dist/ (git-ignored): what the tarball ships; npm pack builds it itself
npm run pack:check  # slow: npm pack, the publish guard, a Node-only app, a fresh Next.js app
```

In the repository the package exports its TypeScript source. `npm pack` and `npm publish` build `dist/` and swap in a
package.json whose exports point there (scripts/prepack.mjs); scripts/postpack.mjs puts the repository's back.
