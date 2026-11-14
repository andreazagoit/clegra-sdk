# MCP Workspaces

> v1, draft 1.0 (2026-11-14). Placeholder names (`mcpw`, `@mcpw/server`)
> wait for open question Q1.

**One MCP server that is also a complete business application.** You declare
entities, actions, pages and fragments on top of the official MCP SDK.
ChatGPT, Claude and any MCP host use it as plain MCP tools with MCP Apps
views; a workspace host (Clegra is the first) reads its card and mounts the
whole app natively: pages in the navigation, record cards, actions behind a
confirmation, agents.

| Read | For |
|---|---|
| [spec.md](spec.md) | The v1 specification (normative, ~4 pages) |
| [quickstart.md](quickstart.md) | Your first app in ten minutes, run in ChatGPT and in a workspace |
| [examples/crm.md](examples/crm.md) | The CRM example, explained; code in [`examples/mcp-workspaces/crm`](../../examples/mcp-workspaces/crm) |
| [ai-guide.md](ai-guide.md), [llms.txt](llms.txt) | Building an app with an AI coding agent |
| [future/](future/README.md) | Everything beyond v1, kept as non-normative future extensions |

**Status.** The SDK is built: [`packages/mcp-workspaces`](../../packages/mcp-workspaces)
(`@mcpw/server`, private for now), with unit tests. Clegra installs v1 apps
from their URL. Open questions: Q1 (names), and everything listed in
[future/](future/README.md).
