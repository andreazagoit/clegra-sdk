# Apps that are also MCP servers

> Draft 1.0 (2026-11-14). **Working name**: the final name is chosen before
> publishing; `mcpw` and `@mcpw/server` are working tokens.

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
| [examples/crm.md](examples/crm.md) | The reference app; code in [`examples/mcp-workspaces/crm`](../../examples/mcp-workspaces/crm) |
| [`packages/app-spec`](../../packages/app-spec) | The manifest's JSON Schema and the conformance checks, independent of the SDK |
| [future/](future/README.md) | Earlier, larger drafts: non-normative, not part of 1.0 |

**Status.** SDK: [`packages/mcp-workspaces`](../../packages/mcp-workspaces)
(`@mcpw/server`, private for now), with unit tests, a snapshot of the CRM's
generated MCP output and the conformance checks. `npm run mcpw:test`,
`npm run mcpw:crm`, `npm run mcpw:conformance -- <url>`.
