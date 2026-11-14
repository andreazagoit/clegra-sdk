# Model App Protocol (MAP)

> Draft 1.0 (2026-11-14). The Model App Protocol (MAP) is for **apps that are also MCP servers**.
> The protocol's names (the technical name `modelapp`, the manifest path, the URI scheme, the `_meta` key, the token claim) are defined in one file, [`packages/modelapp-spec/src/protocol.ts`](../../packages/modelapp-spec/src/protocol.ts).

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
| [quickstart.md](quickstart.md) | A first app: write, run in the Inspector and ChatGPT, test |
| [ai-guide.md](ai-guide.md) ([llms.txt](llms.txt)) | The single-file reference for coding agents |
| [examples/crm.md](examples/crm.md) | The reference app; code in [`examples/modelapp/crm`](../../examples/modelapp/crm) |
| [`packages/modelapp-spec`](../../packages/modelapp-spec) | The manifest's JSON Schema and the conformance checks, independent of the SDK |
| [future/](future/README.md) | Earlier, larger drafts: non-normative, not part of 1.0 |

**Status.** SDK: [`packages/modelapp`](../../packages/modelapp)
(`@modelapp/server`, private for now), with unit tests, a snapshot of the CRM's
generated MCP output and the conformance checks. `npm run modelapp:test`,
`npm run modelapp:crm`, `npm run modelapp:check -- <url>`.
