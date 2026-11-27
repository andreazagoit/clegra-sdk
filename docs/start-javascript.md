# Getting started: plain JavaScript

> A Clegra app is an app that Clegra draws natively and that is also a plain MCP server for ChatGPT, Claude and any
> MCP client. One package, `@clegra/sdk` (ESM JavaScript with its types). Its core uses Web APIs only (Fetch, Web
> Crypto); thin adapters mount it: `@clegra/sdk/node` (`listen`, `toNodeHandler`), `@clegra/sdk/express`
> (`clegraMiddleware`), `@clegra/sdk/next` ([the Next.js guide](start-next.md)), or `served.fetch(request)` in any
> runtime that speaks Fetch.

## One file per thing

An app is its definition, one thing per file: each `define*` call returns a handle, and one thing names another by
its imported handle, never by a string. `clegra/app.ts` assembles them with `defineApp` (pure: checked at once,
nothing served); `clegra/index.ts` serves them with `serve(app, { … })`.

```text
clegra/
  data.ts             your data (here: in memory, per installation)
  entities/note.ts    defineEntity
  actions/close.ts    defineAction (a record action: on: note)
  artifacts/open.ts   defineArtifact
  pages/notes.ts      definePage (a list of notes, a dashboard)
  agents/helper.ts    defineAgent
  app.ts              defineApp: the handles assembled
  index.ts            serve(app, { auth, store, … }): how it runs
main.ts               listen(served)
```

```ts
// clegra/data.ts
export type Note = { id: string; title: string; status: "open" | "done" }
const notes = new Map<string, Map<string, Note>>()   // one map per installation
export const notesOf = (installation: string) => {
  if (!notes.has(installation)) notes.set(installation, new Map([["n1", { id: "n1", title: "Call Ada", status: "open" }]]))
  return notes.get(installation)!
}
```

```ts
// clegra/entities/note.ts
import { defineEntity } from "@clegra/sdk"
import { z } from "zod"

import { notesOf } from "../data"

export const note = defineEntity({
  name: "note",
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
})
```

```ts
// clegra/actions/close.ts
import { AppError, defineAction } from "@clegra/sdk"
import { z } from "zod"

import { notesOf } from "../data"
import { note } from "../entities/note"

export const close = defineAction({
  name: "close",
  on: note,                                           // a record action: `record` below is typed from note's schema
  title: "Close",
  input: z.object({}),                                // always given; z.object({}) for none
  permission: "notes.edit",
  run: (_input, ctx, record) => {
    if (record.status === "done") throw new AppError("conflict", "Already closed.")
    notesOf(ctx.installation).set(record.id, { ...record, status: "done" })
    return { message: `${record.title} closed.`, record: record.id }
  },
})
```

```ts
// clegra/artifacts/open.ts
import { defineArtifact } from "@clegra/sdk"
import { z } from "zod"

import { notesOf } from "../data"

export const openCount = defineArtifact({
  name: "open_count",
  title: "Open notes",
  description: "How many notes are open",
  params: z.object({}),                               // always given too
  template: "stat",
  widget: true,                                       // offered as a Home widget
  data: (_p, ctx) => ({ label: "open", value: [...notesOf(ctx.installation).values()].filter((n) => n.status === "open").length }),
})
```

```ts
// clegra/pages/notes.ts
import { definePage } from "@clegra/sdk"

import { openCount } from "../artifacts/open"
import { note } from "../entities/note"

export const notesPage = definePage({ name: "notes", title: "Notes", list: note, columns: ["title", "status"] })
export const homePage = definePage({ name: "home", title: "Home", dashboard: [{ artifact: openCount }] })
```

```ts
// clegra/agents/helper.ts
import { defineAgent } from "@clegra/sdk"

import { close } from "../actions/close"
import { note } from "../entities/note"

export const helper = defineAgent({ name: "helper", title: "Helper", description: "Finds and closes notes", instructions: "Help with notes.", uses: [note, close] })
```

```ts
// clegra/app.ts
import { defineApp } from "@clegra/sdk"

import { close } from "./actions/close"
import { helper } from "./agents/helper"
import { openCount } from "./artifacts/open"
import { note } from "./entities/note"
import { homePage, notesPage } from "./pages/notes"

export const app = defineApp({
  name: "notes",
  title: { en: "Notes", it: "Note" },
  version: "1.0.0",
  permissions: { "notes.edit": { label: "Edit notes", default: true } },
  entities: [note],
  actions: [close],
  artifacts: [openCount],
  pages: [homePage, notesPage],
  agents: [helper],
})
```

```ts
// clegra/index.ts
import { serve } from "@clegra/sdk"
import { devSignIn } from "@clegra/sdk/signin"

import { app } from "./app"

// Locally: the development sign-in (test people, a code printed on the console; refused in production).
export const served = serve(app, { auth: { signIn: devSignIn(app, { issuer: "http://127.0.0.1:3920" }) } })
```

```ts
// main.ts
import { listen } from "@clegra/sdk/node"
import { served } from "./clegra"

await listen(served, { port: 3920 })   // MCP at /mcp, manifest at /.well-known/clegra.json, OpenAPI at /openapi.json
```

`npx tsx main.ts` prints the development sign-in's code. A handle that is not the app's own, a wrong permission or a
column that is not a field fails in `defineApp`, at start, not at the first call. In the MCP Inspector
(`http://127.0.0.1:3920/mcp`) the client identifies itself with a Client ID Metadata Document, you pick a test
person, type the code and consent: the same OAuth flow as in production, on test people. There is no dynamic
registration.

With Express instead of `listen`, mount the same served app at the root of the site:

```ts
import express from "express"
import { clegraMiddleware } from "@clegra/sdk/express"
import { served } from "./clegra"

const web = express()
web.use(clegraMiddleware(served))   // the app's routes; everything else goes on to your own
web.listen(3920)
```

No body parser may run before it on the app's routes: a confirmation covers the arguments as sent.

Three things you get by saying them in the schema:

- **Sorting**: `.meta({ sort: true })` on a field makes its column sortable in every host (a header to click, `sort`
  and `dir` on the list tool). Your `list` gets `q.sort = { field, dir }`, already checked: order by it.
- **References**: `ref("folder")` in an entity or in an action's `input` (a record of your entity `folder`, by its
  name). Lists and records show the folder's title, forms offer a picker over folders, a model reads `{ id, title }`.
  You only ever handle the id.
- **Forms**: an action's `input` is its form. Required fields are marked, `min`, `max` and dates are checked before
  sending, and what your schema refuses comes back per field (`error.fields`) in the caller's language. Add
  `.meta({ label, currency, labels })` for the words and the money.

## Pages people use every day

The same app, with what makes it a place to work in rather than a list (all optional; [spec §5.2, §4.2, §11–§13](spec.md)).
Each action in its own file:

```ts
// clegra/actions/add.ts: a global action; «+ Nuovo» uses it to make a new note
export const add = defineAction({
  name: "add",
  title: "New note",
  input: z.object({ title: z.string().default("Untitled") }),
  confirm: false,
  permission: "notes.edit",
  creates: note,
  run: (input, ctx) => {
    const id = crypto.randomUUID()
    notesOf(ctx.installation).set(id, { id, title: input.title, status: "open" })
    return { message: `${input.title} added.`, record: ctx.uri(note, id) }
  },
})

// clegra/actions/remind.ts: run by a schedule (no required input, not confirm "always")
export const remind = defineAction({
  name: "remind",
  title: "Remind about open notes",
  input: z.object({}),
  readOnly: true,
  run: (_input, ctx) => {
    const open = [...notesOf(ctx.installation).values()].filter((n) => n.status === "open").length
    if (open) ctx.notify({ type: "reminder", title: `${open} notes are open`, to: "admins" })   // no person in a schedule: say `to`
    return { message: `${open} open.` }
  },
})

// clegra/actions/archive-on.ts: «approve now, act later», confirmed now, runs at `when`
export const archiveOn = defineAction({
  name: "archive_on",
  title: "Archive the done notes",
  input: z.object({ when: z.iso.datetime() }),
  permission: "notes.edit",
  later: { at: "when", window: 60 },
  run: (_input, ctx) => {
    for (const n of notesOf(ctx.installation).values()) if (n.status === "done") notesOf(ctx.installation).delete(n.id)
    return { message: "Archived." }
  },
})
```

```ts
// clegra/pages/notes.ts: «New note» is the page's primary action, the open count its badge
export const notesPage = definePage({ name: "notes", title: "Notes", list: note, columns: ["title", "status"], actions: [add], badge: openCount })

// clegra/app.ts
export const app = defineApp({
  // … as above, and:
  actions: [close, add, remind, archiveOn],
  nav: [{ section: "Notes", pages: [homePage, notesPage] }],
  schedules: [{ name: "morning", action: remind, every: 1440 }],
  notifications: { reminder: { label: "Open notes reminder" } },
  lifecycle: {
    export: (ctx) => ({ contentType: "application/json", body: JSON.stringify([...notesOf(ctx.installation).values()]) }),
    delete: (ctx) => {
      const n = notesOf(ctx.installation).size
      notesOf(ctx.installation).clear()
      return { counts: { notes: n } }
    },
  },
})
```

- **Page actions and badges**: «New note» is the notes page's primary button, opening its form; the open count shows
  next to «Notes» in the navigation. ChatGPT and Claude see the same in the generated view.
- **«+ Nuovo»**: `creates: note` makes `add` the action a workspace host's «+ Nuovo» and a document's «/» menu use.
- **Featured actions**: `featured: true` on a record action shows it on the entity's record template (give the entity
  `record: { fields }`), up to three, in the app's order of actions.
- **Schedules** run as the installation, with nobody at the screen: the host calls `remind` once a day. A write that
  needs a confirmation can't be scheduled; that is what `later` is for.
- **Later**: the person confirms «Archive the done notes at 18:00» once; the SDK keeps the confirmed call and runs it
  at that time, as them, or tells them it did not run. It needs a store with later runs (`MemoryStore`, the default,
  or `SqlStore`).
- **Lifecycle**: when an administrator uninstalls the app, the host offers to export the data and delete them in 30
  days, or to delete them now.

## Production: your own sign-in

`devSignIn` is refused when `NODE_ENV` is `production`. There, the app signs its people in itself
([auth.md](auth.md)):

- an app with a login: `createSignIn(app, { issuer, resource, login, permissionsOf, store, keys, clientOrigins })`
  over it (`login.session(request)`, `login.signInUrl(returnTo)`), then `auth: { signIn }`;
- an app with no login at all: `passwordLogin({ store, origin, title })` is one, the `login` of `createSignIn`;
- an app whose auth library already is an OAuth server (better-auth, Clerk, Auth0, WorkOS): `auth: { resolve,
  resource, authorizationServers }`.

```ts
// clegra/index.ts, in production
import { serve, SqlStore } from "@clegra/sdk"
import { createSignIn, passwordLogin, SqlSignInStore } from "@clegra/sdk/signin"

import { app } from "./app"

const query = (text: string, params: unknown[]) => pool.query(text, params)
const store = new SqlSignInStore(query)                    // SqlSignInStore.schema(): its table, for a migration
const login = passwordLogin({ store, origin: "https://notes.example.com", title: { en: "Notes", it: "Note" } })
const signIn = createSignIn(app, {
  issuer: "https://notes.example.com",
  resource: "https://notes.example.com/mcp",
  login,
  permissionsOf: login.permissionsOf,
  store,
  keys: [JSON.parse(process.env.SIGNIN_KEY!)],              // newSignInKey() makes one
})
export const served = serve(app, { auth: { signIn }, store: new SqlStore(query) })
```

## Test it

```ts
import { serve } from "@clegra/sdk"
import { devSignIn } from "@clegra/sdk/signin"
import { installationClient, testClient } from "@clegra/sdk/testing"
import { app } from "./clegra/app"

const served = serve(app, { auth: { signIn: devSignIn(app) } })
const plain = await testClient(served, { permissions: "all" })        // as ChatGPT would call
await plain.call("note_list", { status: "open" })
const host = await testClient(served, { permissions: "all", host: "workspace" })
await host.confirmed("note_close", { id: "n1" })                      // call id + confirmation proof
await host.confirmed("archive_on", { when: "2026-12-01T17:00:00Z" })  // stored: { data: { later: { id, at, until } } }

const installation = await installationClient(served)                 // the installation itself: no person
await installation.schedule("morning")                                // as the host runs the schedule
await installation.runLater()                                         // the due later runs
const { file } = await installation.exportData()                      // clegra_export, read back (file.body: bytes)
await installation.call("clegra_delete")
```

`testClient` signs with development tokens (`served.dev.token(…)`), so it needs the app served with `devSignIn`.
Its workspace host confirms with development proofs (`served.dev.confirmation(…)`); both count from a loopback
caller only. Alternatively, pass `token` with a bearer your own sign-in accepts, which is how the examples test
their real auth. Then run the conformance checks ([spec §8](spec.md#8-conformance)):
`npx @clegra/sdk check <url> --token <bearer>`.

## The index as OpenAPI

The same operations are an OpenAPI 3.1 document at `/openapi.json`, each callable over plain HTTP with the same
caller, permissions and checks as its MCP tool:

```sh
curl -X POST http://127.0.0.1:3920/operations/note_list -H "authorization: Bearer $TOKEN" -H "content-type: application/json" -d '{"status":"open"}'
```

Each operation says its effect (`x-clegra-effect`: `read`, `write`, `irreversible`); a write takes an
`Idempotency-Key`. Details: [spec §7, «The index as OpenAPI»](spec.md#the-index-as-openapi).

## Your data layer

Your data layer is yours: any database, ORM or API. The SDK guarantees three things without knowing it:

- The tenant (`ctx.installation`) and the person come from the verified caller, never from parameters.
- Filters, sort, text and cursor reach `list` already checked against the fields' meaning and the caller's field
  permissions.
- Fields the caller may not see are stripped from what your handler returns.

A list handler over SQL:

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

Handlers get the call's `ctx` only: what else they need (a database pool, an API client) they import, as any module
does, made on first use.

## Kinds, when other apps hold the same things

If your entities are people, companies, events, tasks, documents, products or orders, say so: `kind: "person"` on
the entity and `.meta({ as: "email", filter: true })` on the field that holds it. Hosts then show one picker, one
search and one «People» page over every app that has people, and find the same person in another app by the exact
email. Your `list` receives a key filter normalised (`q.filters.email` lower-cased): compare it exactly.

```ts
if (typeof q.filters.email === "string") where.push(`lower(email) = $${params.push(q.filters.email)}`)
```

A field that points at a record of *another* app is `ref.kind("organization")`: it holds the URI and nothing else.
Skip kinds for your own domain records (deals, tickets), and when a workspace will have one app per kind they add
nothing. Details: [AI guide](ai-guide.md#kinds-the-same-kind-of-thing-across-apps-optional), [spec §3.1](spec.md#31-kinds).

## Three rules, three escape hatches

- `input` (actions) and `params` (artifacts) are always given: `z.object({})` for none.
- `on: <entity handle>` makes a record action; without it the action is global and `run` gets `(input, ctx)`.
- Every handler scopes its data by `ctx.installation`.

- `serve(app, { mcp: (server, caller) => { … } })` hands you the raw `McpServer` of each request for hand-written
  tools, resources and views.
- `view: { html }` on an entity, a page or an artifact replaces the generated view. A page that is only
  `{ name, title, view }` is fully yours.
- `expose: { plain, tool }` (entities: `{ plain, list, get }`) decides what plain MCP clients see and what the tools
  are called.

Next: [auth.md](auth.md), the [examples](examples/crm.md), the [spec](spec.md), the [AI guide](ai-guide.md).
