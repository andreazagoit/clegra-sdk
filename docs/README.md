# Clegra apps

> Draft 1.0 (2026-11-14). The Clegra apps is for **apps that are also MCP servers**.
> The protocol's names (the technical name `clegra`, the manifest path, the URI scheme, the `_meta` key, the token claim) are defined in one file, [`packages/clegra/spec/src/protocol.ts`](../../packages/clegra/spec/src/protocol.ts).

You describe an app once, as **one typed object**: entities, actions, pages,
fragments, agents, permissions, settings. From it you get

- a **JSON manifest** that a workspace host (Clegra is the first) reads with
  one fetch to draw the app natively, and
- a **plain MCP server** — tools with correct annotations and MCP Apps views —
  that ChatGPT, Claude and any MCP client use with nothing extra.

```ts
export default defineApp({ name, title, version, locale, auth, permissions, settings, entities, actions, pages, fragments, agents })
```

| Read | For |
|---|---|
| [spec.md](spec.md) | The specification (normative, short) |
| [quickstart.md](quickstart.md) | Next.js in 5 minutes (`npx clegra init`), a day to ship; standalone Node; tests |
| [kinds.md](kinds.md) | Kinds: when they pay off, third parties' dotted kinds, the promotion rule, what Clegra does with them |
| [auth.md](auth.md) | Your sign-in as the authorization server, your `auth.resolve`: better-auth, Clerk, Auth0, WorkOS |
| [ai-guide.md](ai-guide.md) ([llms.txt](llms.txt)) | The single-file reference for coding agents |
| [examples/crm.md](examples/crm.md) | A CRM: Next.js, better-auth, Drizzle; code in [`examples/apps/crm`](../../examples/apps/crm) |
| [examples/warehouse.md](examples/warehouse.md) | A warehouse: Next.js, better-auth, plain SQL; code in [`examples/apps/warehouse`](../../examples/apps/warehouse) |
| [`packages/clegra/spec`](../../packages/clegra/spec) | The manifest's JSON Schema and the conformance checks, independent of the SDK |
| [CHANGELOG.md](CHANGELOG.md) | What changed in 1.0 and the `clegra` package |
| [RELEASE.md](RELEASE.md) | What the `clegra` tarball ships, the pack check, the publish guard and publish day |
| [future/](future/README.md) | Earlier, larger drafts: non-normative, not part of 1.0 |

**Status.** One package, [`packages/clegra`](../../packages/clegra) (`clegra`, MIT, not published yet):
`clegra`, `clegra/next`, `clegra/node`, `clegra/testing`, `clegra/spec` and the CLI
(`npx clegra init`, `npx clegra check <url>`). Unit tests, a real Next.js run and the conformance checks.
From the repository root: `npm run clegra:test`, `npm run clegra:crm`, `npm run clegra:check -- <url>`.
