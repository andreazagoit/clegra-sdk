# Model App Protocol (MAP)

> Draft 1.0 (2026-11-14). The Model App Protocol (MAP) is for **apps that are also MCP servers**.
> The protocol's names (the technical name `modelapp`, the manifest path, the URI scheme, the `_meta` key, the token claim) are defined in one file, [`packages/modelapp/spec/src/protocol.ts`](../../packages/modelapp/spec/src/protocol.ts).

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
| [quickstart.md](quickstart.md) | Next.js in 5 minutes (`npx modelapp init`), a day to ship; standalone Node; tests |
| [kinds.md](kinds.md) | Kinds: when they pay off, third parties' dotted kinds, the promotion rule, what Clegra does with them |
| [auth.md](auth.md) | Your sign-in as the authorization server, your `auth.resolve`: better-auth, Clerk, Auth0, WorkOS |
| [ai-guide.md](ai-guide.md) ([llms.txt](llms.txt)) | The single-file reference for coding agents |
| [examples/crm.md](examples/crm.md) | A CRM: Next.js, better-auth, Drizzle; code in [`examples/modelapp/crm`](../../examples/modelapp/crm) |
| [examples/warehouse.md](examples/warehouse.md) | A warehouse: Next.js, better-auth, plain SQL; code in [`examples/modelapp/warehouse`](../../examples/modelapp/warehouse) |
| [`packages/modelapp/spec`](../../packages/modelapp/spec) | The manifest's JSON Schema and the conformance checks, independent of the SDK |
| [CHANGELOG.md](CHANGELOG.md) | What changed in 1.0 and the `modelapp` package |
| [RELEASE.md](RELEASE.md) | What the `modelapp` tarball ships, the pack check, the publish guard and publish day |
| [future/](future/README.md) | Earlier, larger drafts: non-normative, not part of 1.0 |

**Status.** One package, [`packages/modelapp`](../../packages/modelapp) (`modelapp`, MIT, not published yet):
`modelapp`, `modelapp/next`, `modelapp/node`, `modelapp/testing`, `modelapp/spec` and the CLI
(`npx modelapp init`, `npx modelapp check <url>`). Unit tests, a real Next.js run and the conformance checks.
From the repository root: `npm run modelapp:test`, `npm run modelapp:crm`, `npm run modelapp:check -- <url>`.
