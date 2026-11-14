# Quickstart

> Working name; the SDK is `@mcpw/server` (private for now, in
> [`packages/mcp-workspaces`](../../packages/mcp-workspaces)).

## 1. One file, one object

```ts
// app.ts
import { AppError, defineApp } from "@mcpw/server"
import { z } from "zod"

type Note = { id: string; title: string; status: "open" | "done" }
const notes = new Map<string, Map<string, Note>>()   // one map per installation
const notesOf = (installation: string) => {
  if (!notes.has(installation)) notes.set(installation, new Map([["n1", { id: "n1", title: "Call Ada", status: "open" }]]))
  return notes.get(installation)!
}

export default defineApp({
  name: "notes",
  title: { en: "Notes", it: "Note" },
  version: "1.0.0",
  auth: { dev: true },                                // local sign-in page; never in production

  permissions: { "notes.edit": { label: "Edit notes", default: true } },

  entities: {
    note: {
      label: "Note",
      plural: "Notes",
      schema: z.object({
        id: z.string(),
        title: z.string().meta({ role: "title", label: "Title", search: true }),
        status: z.enum(["open", "done"]).meta({ role: "status", label: "Status", filter: true }),
      }),
      get: (id, ctx) => notesOf(ctx.installation).get(id) ?? null,
      list: (q, ctx) => {
        let rows = [...notesOf(ctx.installation).values()]
        if (typeof q.filters.status === "string") rows = rows.filter((n) => n.status === q.filters.status)
        if (q.text) rows = rows.filter((n) => n.title.toLowerCase().includes(q.text!.toLowerCase()))
        return { rows, total: rows.length }
      },
    },
  },

  actions: {
    close: {
      on: "note",                                     // a record action: `note` below is the typed record
      title: "Close",
      input: z.object({}),                            // always given; z.object({}) for none
      permission: "notes.edit",
      expose: { plain: true },                        // writes reach ChatGPT/Claude only when you opt in
      run: (_input, ctx, note) => {
        if (note.status === "done") throw new AppError("conflict", "Already closed.")
        notesOf(ctx.installation).set(note.id, { ...note, status: "done" })
        return { message: `${note.title} closed.`, record: note.id }
      },
    },
  },

  fragments: {
    open_count: {
      title: "Open notes",
      description: "How many notes are open",
      params: z.object({}),                           // always given too
      template: "stat",
      data: (_p, ctx) => ({ label: "open", value: [...notesOf(ctx.installation).values()].filter((n) => n.status === "open").length }),
    },
  },

  pages: {
    notes: { title: "Notes", list: "note", columns: ["title", "status"] },
    home: { title: "Home", dashboard: [{ type: "open_count", params: {} }] },
  },

  agents: {
    helper: { title: "Helper", description: "Finds and closes notes", instructions: "Help with notes.", uses: ["note", "close"] },
  },
})
```

```ts
// main.ts
import app from "./app"
await app.listen({ port: 3920 })   // MCP at /mcp, manifest at /.well-known/app-manifest.json
```

`npx tsx main.ts` prints the dev sign-in code. A wrong name anywhere (a
permission, an entity, an action) fails here, at start, not at the first call.

## 2. Try it

- **MCP Inspector**: `npx @modelcontextprotocol/inspector`, transport
  Streamable HTTP, URL `http://127.0.0.1:3920/mcp`; sign in with the code. You
  see `note_list`, `note_get`, `note_close`, `search`, `fetch`, `open_notes`,
  `open_home`, `show_open_count`.
- **ChatGPT / Claude**: they need https. `cloudflared tunnel --url
  http://127.0.0.1:3920` gives a public address; add `<address>/mcp` as a
  connector and sign in with the code. Lists, records and the dashboard show
  as MCP Apps views.
- **A workspace host** installs the app from its address and reads the manifest.

## 3. Test it

```ts
import { testClient } from "@mcpw/server/testing"
import app from "./app"

const plain = await testClient(app, { permissions: "all" })           // as ChatGPT would call
await plain.call("note_list", { status: "open" })
const host = await testClient(app, { permissions: "all", host: "workspace" })
await host.confirmed("note_close", { id: "n1" })                      // call id + confirmation proof
```

Then the conformance checks ([spec §8](spec.md#8-conformance)):

```sh
npm run mcpw:conformance -- http://127.0.0.1:3920 --token <bearer>
```

## 4. Three rules, three escape hatches

- `input` (actions) and `params` (fragments) are always given: `z.object({})` for none.
- `on: "<entity>"` makes a record action; without it the action is global and `run` gets `(input, ctx)`.
- Every handler scopes its data by `ctx.installation`.

- `mcp: (server, caller) => { … }` hands you the raw `McpServer` of each request for hand-written tools, resources and views.
- `view: { html }` on an entity, a page or a fragment replaces the generated view; a page that is only `{ title, view }` or `{ title, url }` is fully yours.
- `expose: { plain, tool }` (entities: `{ plain, list, get }`) decides what plain MCP clients see and what the tools are called.

Next: the [CRM](examples/crm.md), the [spec](spec.md), the [AI guide](ai-guide.md).
