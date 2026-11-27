# Clegra apps

> Draft 1.0 (2026-11-14). Clegra apps are Clegra's developer platform: **apps that Clegra draws natively and that are also plain MCP servers**, built with the package `@clegra/sdk`.
> The names they carry on the wire (`clegra`: the manifest path, the URI scheme, the `_meta` key, the token claim, the OAuth scope) are defined in one file, [`spec/src/protocol.ts`](../spec/src/protocol.ts).

You describe an app once, **one thing per file**: entities, actions, pages,
artifacts, agents (each a `define*` handle), assembled with permissions and settings by `defineApp`, and run by
`serve`. From it you get

- a **plain MCP server** — tools with correct annotations, MCP Apps views and
  OAuth — that ChatGPT, Claude and any MCP client use with nothing extra, and
- a **JSON manifest** that Clegra reads with one fetch to draw the app natively
  in its workspace: pages, records, actions behind a confirmation, agents, and
- an **OpenAPI 3.1 index** of the same operations, callable over plain HTTP.

```ts
export const app = defineApp({ name, title, version, locale, permissions, settings, entities: [deal], actions: [markWon], pages: [deals], artifacts, agents })
export const served = serve(app, { auth, store, people, site, clientOrigins })
```

| Read | For |
|---|---|
| [spec.md](spec.md) | The specification (normative, short) |
| [start-javascript.md](start-javascript.md) | Getting started in plain JavaScript (any runtime with Fetch; `listen` on Node); pages, tests, your data layer, kinds |
| [start-next.md](start-next.md) | Getting started with Next.js: 5 minutes (`npx @clegra/sdk init`), a day to ship, your site in Clegra |
| [kinds.md](kinds.md) | Kinds: when they pay off, third parties' dotted kinds, the promotion rule |
| [auth.md](auth.md) | The sign-in module (`createSignIn`, `passwordLogin`, `devSignIn`), or your own authorization server with `auth.resolve`: better-auth, Clerk, Auth0, WorkOS |
| `@clegra/ui` | Clegra's design system, a separate package on npm with its own guide; `npx @clegra/sdk init --ui` adds it to a Next.js app |
| [ai-guide.md](ai-guide.md) ([llms.txt](llms.txt)) | The single-file reference for coding agents |
| [examples/crm.md](examples/crm.md) | A CRM: Next.js, better-auth, Drizzle; code in [`examples/crm`](../examples/crm) |
| [examples/warehouse.md](examples/warehouse.md) | A warehouse: Next.js, better-auth, plain SQL; code in [`examples/warehouse`](../examples/warehouse) |
| [`examples/shipments`](../examples/shipments) | Shipments: plain Node (`listen`), the sign-in module, a courier API |
| [`spec`](../spec) | The manifest's JSON Schema and the conformance checks, independent of the SDK |
| [CHANGELOG.md](../CHANGELOG.md) | What changed in 1.0 and the `@clegra/sdk` package |
| [RELEASE.md](RELEASE.md) | What the `@clegra/sdk` tarball ships, the pack check, the publish guard and publish day |

**Status.** One package, `@clegra/sdk` (MIT, this repository's root; `0.3.0-next.0`, published with the dist-tag `next`):
`@clegra/sdk`, `@clegra/sdk/signin`, `@clegra/sdk/next`, `@clegra/sdk/node`, `@clegra/sdk/express`, `@clegra/sdk/testing`, `@clegra/sdk/spec` and the CLI (`npx @clegra/sdk init [--ui]`, `npx @clegra/sdk check <url>`). Unit tests, a real Next.js run and the conformance checks.
From the repository root: `npm test`, `npm run test:all`, `npm run dev -w clegra-example-crm`, `npm run clegra:check -- <url>`.
