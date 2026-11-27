# Getting started: plain JavaScript

A small job-requests app on Node, with no framework: its records at their own web URLs, a few tools, a page, a
confirmed action and the development sign-in. The same code runs on any runtime with Fetch (`served.fetch(request)`);
`listen` is only the Node server. Reference: [spec.md](spec.md); the rules: [extensions](extensions/README.md).

```sh
npm i @clegra/sdk@next zod
```

## 1. The definitions

One thing per file is the habit; here they are together.

```ts
// jobs.ts
import { AppError, defineApp, defineBadge, defineEntity, definePage, defineTool } from "@clegra/sdk"
import { z } from "zod"

type Job = { id: string; title: string; status: "open" | "done"; customer: string }
const jobs = new Map<string, Job>([["1", { id: "1", title: "Replace boiler", status: "open", customer: "Harbor Supplies Ltd" }]])

export const job = defineEntity({
  name: "job",
  title: { en: "Job", it: "Lavoro" },
  path: "/jobs/{id}",                                   // the record's web URL, and its MCP resource URI
  schema: z.object({ id: z.string(), title: z.string(), status: z.enum(["open", "done"]), customer: z.string() }),
  card: { title: "title", subtitle: "customer", status: "status" },
  get: ({ id }) => jobs.get(id!) ?? null,
  list: () => ({ rows: [...jobs.values()] }),
})

export const openJobs = defineBadge({ name: "open", value: () => [...jobs.values()].filter((j) => j.status === "open").length })
export const jobsPage = definePage({ name: "jobs", title: "Jobs", path: "/jobs{?status}", role: "list", entity: job, nav: { order: 10 }, badge: openJobs })
export const jobPage = definePage({ name: "job", title: "Job", path: "/jobs/{id}", role: "record", entity: job })

export const listJobs = defineTool({
  name: "job.list", title: "List jobs", description: "The jobs, optionally by status",
  input: z.object({ status: z.enum(["open", "done"]).optional() }),
  annotations: { readOnly: true }, entity: job, page: jobsPage,
  run: ({ status }) => {
    const rows = [...jobs.values()].filter((j) => !status || j.status === status)
    return { data: { rows }, records: rows.map((record) => ({ entity: job, record })) }
  },
})

export const completeJob = defineTool({
  name: "job.complete", title: "Complete job", description: "Closes a job as done",
  input: z.object({ id: z.string() }),                  // the job's URL, or its id
  annotations: { readOnly: false, destructive: false, idempotent: true },
  entity: job, on: "record", page: jobPage,
  run: (_input, ctx, record) => {
    if (record.status === "done") throw new AppError("conflict", "The job is already done")
    record.status = "done"
    ctx.changed(openJobs)
    return { records: [{ entity: job, record }], text: `Done: ${record.title}` }
  },
})

// Sends something to someone outside: the app's own confirmation (ACT-2), on the app's page.
export const sendReport = defineTool({
  name: "job.send_report", title: "Send report", description: "Sends the job's report to the customer",
  input: z.object({ id: z.string() }),
  annotations: { readOnly: false, destructive: false, openWorld: true },
  entity: job, on: "record",
  confirm: {
    message: (_i, _ctx, r) => `Send the report of «${r.title}» to ${r.customer}?`,
    values: (_i, _ctx, r) => ({ customer: r.customer }),
  },
  run: () => ({ data: { sent: true } }),
})

export const app = defineApp({
  name: "jobs", title: "Jobs", description: "Job requests", version: "1.0.0",
  entities: [job], tools: [listJobs, completeJob, sendReport], pages: [jobsPage, jobPage], badges: [openJobs],
})
```

`defineApp` checks everything at once (a page variable a tool cannot fill, a card field that is not in the schema…)
and says where.

## 2. Serve it

```ts
// main.ts
import { serve } from "@clegra/sdk"
import { listen } from "@clegra/sdk/node"
import { devSignIn } from "@clegra/sdk/signin"
import { app } from "./jobs"

const signIn = devSignIn(app, { issuer: "http://localhost:4010" })
const served = serve(app, { origin: "http://localhost:4010", auth: { signIn }, pages: "generated" })
await listen(served, { port: 4010 })
console.log(`dev sign-in code: ${signIn.dev.code}`)
```

- `/mcp` is the MCP server (revision `2026-07-28`); `/mcp/server-card`, `/.well-known/ai-catalog.json` and the OAuth
  metadata say where it is and who signs people in.
- `devSignIn` is the sign-in module over test people: a client that connects is sent to its login (the code on the
  console), then to its consent page. It is refused when `NODE_ENV` is `production`.
- `pages: "generated"` draws read-only pages at the record URLs and the list page, for an app with no site of its own.
  An app with a site serves its own pages there and leaves `pages` out.

Connect any MCP client to `http://localhost:4010/mcp`: it lists the tools with their `_meta`, reads
`webmap://pages`, opens records as resources at their URLs. A call to `job.send_report` asks the person to confirm
on `http://localhost:4010/confirm/<id>`.

## 3. Test it

```ts
// jobs.test.ts
import assert from "node:assert/strict"
import { test } from "node:test"
import { serve } from "@clegra/sdk"
import { devSignIn } from "@clegra/sdk/signin"
import { testClient } from "@clegra/sdk/testing"
import { app } from "./jobs"

test("complete a job by its URL", async () => {
  const signIn = devSignIn(app, { issuer: "http://localhost:3000", people: [{ id: "ada", name: "Ada" }] })
  const served = serve(app, { origin: "http://localhost:3000", auth: { signIn } })
  const client = testClient(served, { token: await signIn.dev.token({ person: "ada" }) })
  const r = await client.call("job.complete", { id: "http://localhost:3000/jobs/1" })
  assert.equal(r.content?.[1]?.uri, "http://localhost:3000/jobs/1")
  assert.deepEqual(await client.readJson("webmap://badges/open"), { value: 0 })
})
```

`signIn.dev.token({ person, scopes })` signs a development token (default: every scope the app offers); pass
`scopes: ["web.read"]` to see the step-up. `confirmOnPage(served, url, cookie)` is the person's click on a
confirmation page (sign in at `/oauth/dev-login` first for the cookie).

## 4. Production

- **The origin.** `serve(app, { origin })` or `CLEGRA_PUBLIC_URL`, an https origin: in production it is never taken
  from a request.
- **The sign-in.** `createSignIn(app, { issuer, resource, login, active, store, keys })` with your own login, or with
  `passwordLogin` for an app that has none; or your own authorization server through `auth: { verify,
  authorizationServers, sessions }`. See [auth.md](auth.md).
- **The store.** `SqlStore` (one table, `SqlStore.schema()` in your migrations) when the app runs on more than one
  process: confirmations, codes, transferred sessions and the access log live there.
- **Check it.** `npx @clegra/sdk check https://jobs.example.com --token <a token>` prints the level the app reaches
  (A, B1, B2, C).

## 5. Your own pages

The app's pages are its own: any framework, at the URLs the definitions name. A page reads who is looking with
`served.session(request)` (the app's own session, or one transferred from a client) and shows
`served.banner(session, request)` over a transferred one. A `GET` with `Authorization: Bearer` at a record URL is the
SDK's (`served.handle` answers it with the record's JSON); everything else is yours: with Node's server, mount
`toNodeHandler(served)` with a `next` and answer the rest; with Express, `app.use(clegraMiddleware(served))`.
