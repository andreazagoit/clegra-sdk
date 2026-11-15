# Quickstart

> Model App Protocol (MAP): an app that is also an MCP server. The SDK is `modelapp` (private for now, in
> [`packages/modelapp`](../../packages/modelapp)).

## 1. One file, one object

```ts
// app.ts
import { AppError, defineApp } from "modelapp"
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
  auth: { dev: true },                                // local sign-in page: loopback callers only, refused in production

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
        // q.textFields: the search fields this caller may see; search in those only
        if (q.text) rows = rows.filter((n) => (q.textFields ?? []).some((f) => String(n[f as "title"] ?? "").toLowerCase().includes(q.text!.toLowerCase())))
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
// main.ts: a standalone app on Node's HTTP server (a Next.js app serves app.fetch from its routes instead)
import { listen } from "modelapp/node"
import app from "./app"
await listen(app, { port: 3920 })   // MCP at /mcp, manifest at /.well-known/modelapp.json
```

`npx tsx main.ts` prints the dev sign-in code. A wrong name anywhere (a
permission, an entity, an action) fails here, at start, not at the first call.

Three things you get by saying them in the schema:

- **Sorting**: `.meta({ sort: true })` on a field makes its column sortable in
  every host (a header to click, `sort` and `dir` on the list tool). Your
  `list` gets `q.sort = { field, dir }`, already checked: order by it.
- **References**: `ref("folder")` in an entity or in an action's `input`.
  Lists and records show the folder's title, forms offer a picker over
  folders, a model reads `{ id, title }`. You only ever handle the id.
- **Forms**: an action's `input` is its form. Required fields are marked,
  `min`, `max` and dates are checked before sending, and what your schema
  refuses comes back per field (`error.fields`) in the caller's language.
  Add `.meta({ label, currency, labels })` for the words and the money.

## 2. Try it

- **MCP Inspector**: `npx @modelcontextprotocol/inspector`, transport
  Streamable HTTP, URL `http://127.0.0.1:3920/mcp`; sign in with the code. You
  see `note_list`, `note_get`, `note_close`, `search`, `fetch`, `open_notes`,
  `open_home`, `show_open_count`.
- **ChatGPT / Claude**: they need https. `cloudflared tunnel --url
  http://127.0.0.1:3920` gives a public address; add `<address>/mcp` as a
  connector and sign in with the code. Lists, records and the dashboard show
  as MCP Apps views. A client says who it is with the URL of its metadata
  document, or registers dynamically: both work in dev, with nothing to set up.
- **A workspace host** installs the app from its address and reads the manifest.

## 3. Test it

```ts
import { testClient } from "modelapp/testing"
import app from "./app"

const plain = await testClient(app, { permissions: "all" })           // as ChatGPT would call
await plain.call("note_list", { status: "open" })
const host = await testClient(app, { permissions: "all", host: "workspace" })
await host.confirmed("note_close", { id: "n1" })                      // call id + confirmation proof
```

Then the conformance checks ([spec §8](spec.md#8-conformance)):

```sh
npm run modelapp:check -- http://127.0.0.1:3920 --token <bearer>
```

## 4. Three rules, three escape hatches

- `input` (actions) and `params` (fragments) are always given: `z.object({})` for none.
- `on: "<entity>"` makes a record action; without it the action is global and `run` gets `(input, ctx)`.
- Every handler scopes its data by `ctx.installation`.

Your data layer is yours (any database, ORM or API). What the SDK guarantees without knowing it: the tenant
(`ctx.installation`) and the person come from the verified caller, never from parameters; filters, sort, text and
cursor reach `list` already checked against the fields' meaning and the caller's field permissions; fields the
caller may not see are stripped from what your handler returns. A list handler over SQL:

```ts
list: async (q, ctx) => {
  const where = ["org_id = $1"], params: unknown[] = [ctx.installation]          // the tenant, always
  if (typeof q.filters.status === "string") where.push(`status = $${params.push(q.filters.status)}`)
  if (q.text) where.push(`(${(q.textFields ?? []).map((f) => `${f} ILIKE $${params.push(`%${q.text}%`)}`).join(" OR ")})`)
  const order = q.sort ? `${q.sort.field} ${q.sort.dir}` : "id"                     // q.sort.field is a declared sortable field
  const offset = Number(q.cursor ?? 0)
  const { rows } = await db.query(`SELECT * FROM notes WHERE ${where.join(" AND ")} ORDER BY ${order} LIMIT ${q.limit + 1} OFFSET ${offset}`, params)
  return { rows: rows.slice(0, q.limit), ...(rows.length > q.limit ? { next: String(offset + q.limit) } : {}) }
},
```

In production: `auth.resolve` verifies your own users' tokens (your auth library is the authorization server),
`auth.resource` is your public MCP address, and `store: new SqlStore((text, params) => pool.query(text, params))`
keeps idempotency and one-time token ids in your Postgres (`SqlStore.schema()` gives the table for a migration).

- `mcp: (server, caller) => { … }` hands you the raw `McpServer` of each request for hand-written tools, resources and views.
- `view: { html }` on an entity, a page or a fragment replaces the generated view; a page that is only `{ title, view }` or `{ title, url }` is fully yours.
- `expose: { plain, tool }` (entities: `{ plain, list, get }`) decides what plain MCP clients see and what the tools are called.

Next: the [CRM](examples/crm.md), the [spec](spec.md), the [AI guide](ai-guide.md).
