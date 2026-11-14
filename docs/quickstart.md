# Quickstart

> Non-normative. MCP Workspaces v1 ([spec](spec.md)).

You will run the CRM example, see it in an MCP host, then write your own app.

## 1. Run the example

```sh
cd examples/mcp-workspaces/crm
npm install          # or, inside this repository, nothing: the workspace has the deps
MCPW_DEV_CODE=CRM2026 npm start
```

```
CRM — MCP http://127.0.0.1:3920/mcp · card http://127.0.0.1:3920/.well-known/mcp-workspace.json
DEV AUTH ON (never in production) — sign-in code: CRM2026
```

`auth.dev` makes the server its own OAuth authorization server for test
people: Ada (sales manager, every permission) and Bruno (sales rep, no deal
values). It works only on a loopback address. The sign-in page asks for the
code printed on the console.

## 2. Try it in ChatGPT (or Claude)

1. Expose the port: `cloudflared tunnel --url http://127.0.0.1:3920` prints an
   `https://….trycloudflare.com` address.
2. ChatGPT → Settings → Apps & Connectors → Advanced → Developer mode on →
   «Create» a connector with URL `https://….trycloudflare.com/mcp` and
   authentication **OAuth**.
3. ChatGPT opens the dev sign-in page: pick Ada, type the code.
4. Ask: «Show the CRM pipeline», «Which deals close this month?», «Mark the
   Officine Bianchi deal as won». Lists, records and the dashboard appear as
   MCP Apps views; the write asks for ChatGPT's own approval.

## 3. Write your own

```ts
// src/app.ts
import { McpWorkspacesServer } from "@mcpw/server"
import { z } from "zod"

export const app = new McpWorkspacesServer({
  name: "tasks", title: "Tasks", version: "0.1.0", locale: "en",
  auth: { dev: true },
})
app.registerPermission("tasks.edit", { label: "Change tasks", default: true })

const tasks = new Map<string, Map<string, Task>>()            // per installation
type Task = { id: string; title: string; done: boolean }
const of = (installation: string) => tasks.get(installation) ?? tasks.set(installation, new Map()).get(installation)!

const Task = app.registerEntity("task", {
  label: "Task", plural: "Tasks", icon: "check-square",
  schema: z.object({
    id: z.string(),
    title: z.string().meta({ role: "title", label: "Title", search: true }),
    done: z.boolean().meta({ label: "Done", filter: true }),
  }),
  get: (id, ctx) => of(ctx.installation).get(id) ?? null,
  list: (q, ctx) => {
    const rows = [...of(ctx.installation).values()]
      .filter((t) => q.filters.done === undefined || t.done === q.filters.done)
      .filter((t) => !q.text || t.title.toLowerCase().includes(q.text.toLowerCase()))
    return { rows: rows.slice(0, q.limit) }
  },
})

app.registerAction("add_task", {
  title: "Add task", input: z.object({ title: z.string().min(1) }), permission: "tasks.edit",
}, (input, ctx) => {
  const id = crypto.randomUUID()
  of(ctx.installation).set(id, { id, title: input.title, done: false })
  return { message: `Added «${input.title}».`, record: ctx.uri(Task, id) }
})

app.registerAction("complete", {
  entity: Task, title: "Complete", confirm: "optional", permission: "tasks.edit",
}, (_input, ctx, task) => {
  of(ctx.installation).set(task.id, { ...task, done: true })
  return { message: `«${task.title}» done.`, record: task.id }
})

app.registerPage("tasks", { kind: "list", title: "Tasks", entity: Task, columns: ["title", "done"] })
```

```ts
// src/main.ts
import { app } from "./app"
await app.listen({ port: 3921 })
```

You now have the tools `task_list`, `task_get`, `search`, `fetch`,
`add_task`, `task_complete`, `open_tasks`, a record page and a record card
for every task, and a card at `/.well-known/mcp-workspace.json`.

## 4. Test it

```ts
// src/app.test.ts
import assert from "node:assert/strict"
import { test } from "node:test"
import { testClient } from "@mcpw/server/testing"
import { app } from "./app"

test("adding needs the permission", async () => {
  const c = await testClient(app, { permissions: [] })
  assert.ok(!(await c.listTools()).some((t) => t.name === "add_task"))
})

test("a workspace host must confirm", async () => {
  const c = await testClient(app, { permissions: "all", host: "workspace" })
  const r = await c.call("add_task", { title: "Call Ada" }, { "mcpw/call": "c1" })
  assert.equal((r.structuredContent as any).error.code, "confirmation_required")
  assert.ok(!(await c.confirmed("add_task", { title: "Call Ada" }, "c1")).isError)
})
```

`node --import tsx --test src/app.test.ts`. `testClient` goes through the
real HTTP path with a dev token; `confirmed()` signs the proof a workspace
host sends after the person's «Confirm».

## 5. In a workspace (Clegra)

Clegra → Moduli → «Installa da indirizzo» → the app's URL. Clegra reads the
card, shows your pages in the rail and your records as cards in chat, and
asks «Conferma» before every `always` action. For your server to accept
Clegra's tokens, add its issuer: `auth: { issuers: [{ issuer: "<node URL>" }] }`
(the CRM reads `MCPW_ISSUERS`).
