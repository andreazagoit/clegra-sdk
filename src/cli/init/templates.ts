/**
 * The files `clegra init` writes. Plain strings: no template engine. Each takes `ts` (TypeScript or plain
 * JavaScript, as the project is written) and gives the file's text.
 */

/** The environment variable of the development sign-in's code (`.env.local`): the dev login asks for it. */
export const DEV_CODE_ENV = "CLEGRA_DEV_CODE"

/**
 * `clegra/`: a small working app on in-file sample data, one file per thing (the entity, its tools, its page), the
 * definition that assembles them (`app`), and how it runs (`index`: the sign-in), with the places to plug the
 * database and the production sign-in marked TODO.
 */
export function clegraFiles(input: { name: string; title: string; ts: boolean }): { file: string; text: string }[] {
  const { name, title, ts } = input
  const T = (typed: string, plain: string) => (ts ? typed : plain)
  const ext = ts ? "ts" : "js"
  const task = `// A task: the app's one entity. Its records live at their own web URL (/tasks/{id}), which is also their MCP
// resource URI. Written by \`npx @clegra/sdk init\`.
import { defineEntity } from "@clegra/sdk"
import { z } from "zod"

// TODO(your data): replace the sample tasks with your database (any database, ORM or API). Scope every read and
// write by ctx.person (and ctx.person.tenant, when your sign-in has organizations).
${T('export type Task = { id: string; title: string; status: "open" | "done"; due: string }\n', "")}const sample${T(": Task[]", "")} = [
  { id: "t1", title: "Send the spring catalog to the printer", status: "open", due: "2026-03-02" },
  { id: "t2", title: "Renew the domain name", status: "open", due: "2026-03-15" },
  { id: "t3", title: "Archive last year's invoices", status: "done", due: "2026-01-31" },
]
const tasksByPerson = new Map${T("<string, Task[]>", "")}()
export function tasksOf(person${T(": string", "")})${T(": Task[]", "")} {
  let tasks = tasksByPerson.get(person)
  if (!tasks) tasksByPerson.set(person, (tasks = sample.map((t) => ({ ...t }))))
  return tasks
}

export const task = defineEntity({
  name: "task",
  title: "Task",
  plural: "Tasks",
  path: "/tasks/{id}",
  schema: z.object({ id: z.string(), title: z.string(), status: z.enum(["open", "done"]), due: z.string() }),
  card: { title: "title", status: "status", date: "due" },
  get: ({ id }, ctx) => tasksOf(ctx.person.id).find((t) => t.id === id) ?? null,
  list: (query, ctx) => ({ rows: tasksOf(ctx.person.id).slice(0, query.limit) }),
})
`
  const listTasks = `// «List tasks»: a read. Its results link each task at its web URL.
import { defineTool } from "@clegra/sdk"
import { z } from "zod"

import { task, tasksOf } from "./task"
import { tasks } from "./tasks"

export const listTasks = defineTool({
  name: "task.list",
  title: "List tasks",
  description: "Lists the person's tasks, open ones or all",
  input: z.object({ status: z.enum(["open", "done"]).optional() }),
  annotations: { readOnly: true },
  entity: task,
  page: tasks,
  run: ({ status }, ctx) => {
    const rows = tasksOf(ctx.person.id).filter((t) => !status || t.status === status)
    return { data: { rows }, records: rows.map((record) => ({ entity: task, record })) }
  },
})
`
  const complete = `// «Complete»: a change on one task. It takes the task's URL (or its id), and can be put back: no confirmation.
import { AppError, defineTool } from "@clegra/sdk"
import { z } from "zod"

import { task, tasksOf } from "./task"

export const complete = defineTool({
  name: "task.complete",
  title: "Complete task",
  description: "Marks an open task as done",
  input: z.object({ id: z.string().describe("The task's URL") }),
  annotations: { readOnly: false, destructive: false, idempotent: true },
  entity: task,
  on: "record",
  run: (_input, ctx, record) => {
    const stored = tasksOf(ctx.person.id).find((t) => t.id === record.id)
    if (!stored || stored.status === "done") throw new AppError("conflict", "The task is already done.")
    stored.status = "done"
    return { text: \`\${record.title}: done.\`, records: [{ entity: task, record: stored }] }
  },
})
`
  const tasks = `// The tasks page, for people: your own page at /tasks (write it in your app). The web map tells clients it is there.
import { definePage } from "@clegra/sdk"

import { task } from "./task"

export const tasks = definePage({ name: "tasks", title: "Tasks", path: "/tasks{?status}", role: "list", entity: task, nav: { order: 10 } })
`
  const app = `// Your app's definition (nothing here is served): an MCP server with the web map, for any MCP client.
import { defineApp } from "@clegra/sdk"

import { complete } from "./complete"
import { listTasks } from "./list-tasks"
import { task } from "./task"
import { tasks } from "./tasks"

export const app = defineApp({
  name: ${JSON.stringify(name)},
  title: ${JSON.stringify(title)},
  description: "Tasks",
  version: "0.1.0",
  entities: [task],
  tools: [listTasks, complete],
  pages: [tasks],
})
`
  const index = `// How the app runs. Served by app/api/clegra/[...path]/route.${ext}; next.config's withClegra puts it at /mcp, its
// Server Card, the OAuth metadata and the sign-in at the root of the site.
import { serve, type ServedApp } from "@clegra/sdk"
import { devSignIn } from "@clegra/sdk/signin"

import { app } from "./app"

// The public origin (CLEGRA_PUBLIC_URL, like https://app.example.com). Required in production.
const origin = process.env.CLEGRA_PUBLIC_URL ?? "http://localhost:3000"

// TODO(your sign-in): devSignIn is for development only (test people, the code in .env.local, ${DEV_CODE_ENV}): it is
// refused in production. For production use createSignIn(app, { issuer, resource, login, store, keys }) of
// @clegra/sdk/signin over your own login, or your own OAuth server with auth: { verify, authorizationServers }
// (docs: auth.md in the @clegra/sdk docs).
let instance: ServedApp | null = null

/** The served app, made on first use: \`next build\` imports this file without serving anything. */
export function served(): ServedApp {
  instance ??= serve(app, { origin, auth: { signIn: devSignIn(app, { issuer: origin, ...(process.env.${DEV_CODE_ENV} ? { code: process.env.${DEV_CODE_ENV} } : {}) }) } })
  return instance
}
`
  return [
    { file: `task.${ext}`, text: task },
    { file: `list-tasks.${ext}`, text: listTasks },
    { file: `complete.${ext}`, text: complete },
    { file: `tasks.${ext}`, text: tasks },
    { file: `app.${ext}`, text: app },
    { file: `index.${ext}`, text: index },
  ]
}

/** `app/api/clegra/[...path]/route.ts`: the one route that serves MCP, the OAuth metadata and the sign-in. */
export function routeFile(input: { importPath: string }): string {
  return `import { toNextHandlers } from "@clegra/sdk/next"

import { served } from ${JSON.stringify(input.importPath)}

// MCP (/mcp) and its Server Card, the OAuth metadata (/.well-known/…), the sign-in (/oauth/…), the confirmation and
// session-transfer pages, rewritten here by withClegra in next.config; record URLs read with a bearer token, by proxy.
export const { GET, POST, DELETE, OPTIONS } = toNextHandlers(served)
`
}

/** `proxy.ts`: a record URL read with a bearer token goes to the route (web-map REC-1); pages are untouched. */
export function proxyFile(): string {
  return `import { recordProxy } from "@clegra/sdk/next"

// A GET with Authorization: Bearer on a record's URL gets the record's JSON from the clegra route; every other
// request goes on to your pages as before. List your entities' paths in the matcher.
export const proxy = recordProxy()
export const config = { matcher: ["/tasks/:id"] }
`
}

/** A next.config for a project without one. */
export function nextConfigFile(ts: boolean): string {
  return ts
    ? `import type { NextConfig } from "next"
import { withClegra } from "@clegra/sdk/next"

const nextConfig: NextConfig = {}

export default withClegra(nextConfig)
`
    : `import { withClegra } from "@clegra/sdk/next"

/** @type {import("next").NextConfig} */
const nextConfig = {}

export default withClegra(nextConfig)
`
}

/** The lines added to `.env.local`. */
export function envLines(code: string): string {
  return `# clegra: the development sign-in's code (devSignIn: test people, never in production). Keep this file out of git.
${DEV_CODE_ENV}=${code}
`
}
