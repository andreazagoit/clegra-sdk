/**
 * The files `clegra init` writes. Plain strings: no template engine. Each takes `ts` (TypeScript or plain
 * JavaScript, as the project is written) and gives the file's text.
 */

/** The environment variable of the local bearer (`.env.local`): accepted by the generated `resolve` outside production only. */
export const LOCAL_TOKEN_ENV = "CLEGRA_LOCAL_TOKEN"

/**
 * `clegra/`: a small working app on in-file sample data, one file per thing (the entity, its action, its page), the
 * definition that assembles them (`app`), and how it runs (`index`: the sign-in), with the places to plug the database
 * and the sign-in marked TODO.
 */
export function clegraFiles(input: { name: string; title: string; ts: boolean }): { file: string; text: string }[] {
  const { name, title, ts } = input
  const T = (typed: string, plain: string) => (ts ? typed : plain)
  const ext = ts ? "ts" : "js"
  const task = `// A task: the app's one entity (its records and how they are read). Written by \`npx @clegra/sdk init\`.
import { defineEntity } from "@clegra/sdk"
import { z } from "zod"

// TODO(your data): replace the sample tasks with your database (any database, ORM or API). Scope every read and
// write by ctx.installation: the tenant your sign-in names (an organization, a workspace, an account).
${T('export type Task = { id: string; title: string; status: "open" | "done"; due: string }\n', "")}const sample${T(": Task[]", "")} = [
  { id: "t1", title: "Send the spring catalog to the printer", status: "open", due: "2026-03-02" },
  { id: "t2", title: "Renew the domain name", status: "open", due: "2026-03-15" },
  { id: "t3", title: "Archive last year's invoices", status: "done", due: "2026-01-31" },
]
const tasksByInstallation = new Map${T("<string, Task[]>", "")}()
export function tasksOf(installation${T(": string", "")})${T(": Task[]", "")} {
  let tasks = tasksByInstallation.get(installation)
  if (!tasks) tasksByInstallation.set(installation, (tasks = sample.map((t) => ({ ...t }))))
  return tasks
}

export const task = defineEntity({
  name: "task",
  label: "Task",
  plural: "Tasks",
  icon: "check-square",
  schema: z.object({
    id: z.string(),
    title: z.string().meta({ role: "title", label: "Title", search: true, sort: true }),
    status: z.enum(["open", "done"]).meta({ role: "status", label: "Status", filter: true, labels: { open: "Open", done: "Done" }, tones: { done: "success" } }),
    due: z.string().meta({ role: "date", label: "Due", sort: true }),
  }),
  get: (id, ctx) => tasksOf(ctx.installation).find((t) => t.id === id) ?? null,
  list: (query, ctx) => {
    let rows = tasksOf(ctx.installation)
    if (typeof query.filters.status === "string") rows = rows.filter((t) => t.status === query.filters.status)
    // Search only in query.textFields: the search fields this caller may see.
    const text = query.text?.toLowerCase()
    if (text) rows = rows.filter((t) => (query.textFields ?? []).some((f) => String(t[f${T(" as keyof Task", "")}] ?? "").toLowerCase().includes(text)))
    if (query.sort) {
      const { field, dir } = query.sort
      rows = [...rows].sort((a, b) => String(a[field${T(" as keyof Task", "")}]).localeCompare(String(b[field${T(" as keyof Task", "")}])) * (dir === "asc" ? 1 : -1))
    }
    return { rows: rows.slice(0, query.limit), total: rows.length }
  },
})
`
  const complete = `// «Complete»: an action on one task. It names its entity by the imported handle.
import { AppError, defineAction } from "@clegra/sdk"
import { z } from "zod"

import { task, tasksOf } from "./task"

export const complete = defineAction({
  name: "complete",
  on: task,
  title: "Complete",
  description: "Marks an open task as done",
  input: z.object({}),
  permission: "tasks.edit",
  // Writes ask the person first (confirm defaults to always).
  run: (_input, ctx, record) => {
    const stored = tasksOf(ctx.installation).find((t) => t.id === record.id)
    if (!stored || stored.status === "done") throw new AppError("conflict", "The task is already done.")
    stored.status = "done"
    return { message: \`\${record.title}: done.\`, record: record.id }
  },
})
`
  const tasks = `// The tasks page: a list of the entity's records.
import { definePage } from "@clegra/sdk"

import { task } from "./task"

export const tasks = definePage({ name: "tasks", title: "Tasks", icon: "check-square", list: task, columns: ["title", "status", "due"] })
`
  const app = `// Your app as a Clegra app: its entities, actions and pages assembled (nothing here is served). It becomes a manifest
// for workspace hosts, an OpenAPI index and a plain MCP server for ChatGPT, Claude and any MCP client.
import { defineApp } from "@clegra/sdk"

import { complete } from "./complete"
import { task } from "./task"
import { tasks } from "./tasks"

export const app = defineApp({
  name: ${JSON.stringify(name)},
  title: ${JSON.stringify(title)},
  version: "0.1.0",
  permissions: {
    "tasks.edit": { label: "Complete tasks", default: true },
  },
  entities: [task],
  actions: [complete],
  pages: [tasks],
})
`
  const index = `// How the app runs: who may call it. Served by app/api/clegra/[...path]/route.${ext}; next.config's withClegra puts it at
// /mcp, /.well-known/clegra.json and /openapi.json.
import { timingSafeEqual } from "node:crypto"

import { serve${T(", type ResolvedCaller", "")} } from "@clegra/sdk"

import { app } from "./app"

// The public origin (CLEGRA_PUBLIC_URL, like https://app.example.com): its /mcp is the only audience tokens are
// accepted for. Required in production; unset locally, the app answers at whatever address you reach it by.
const site = process.env.CLEGRA_PUBLIC_URL?.replace(/\\/+$/, "")
const resource = site ? \`\${site}/mcp\` : undefined

/**
 * Local first: the bearer in .env.local (${LOCAL_TOKEN_ENV}, written by init), so you can see the app before your
 * sign-in issues tokens. Never in production: NODE_ENV is "production" in \`next build\`, \`next start\` and every
 * deployment, and then this answers null whatever the environment holds.
 */
function localCaller(token${T(": string", "")})${T(": ResolvedCaller | null", "")} {
  const expected = process.env.${LOCAL_TOKEN_ENV}
  if (process.env.NODE_ENV === "production" || !expected) return null
  const given = Buffer.from(token)
  const wanted = Buffer.from(expected)
  if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) return null
  return { installation: "local", person: { id: "local-developer", name: "Local developer" }, permissions: "all" }
}

export const served = serve(app, {
  auth: {
    ...(resource ? { resource } : {}),
    // TODO(your sign-in): the app's own sign-in. With none yet, the SDK's sign-in module (createSignIn of
    // @clegra/sdk/signin, over your login or its password login) gives every MCP client a delegation your app issues:
    // auth: { signIn }. An app whose auth library already is an OAuth server names it here instead (better-auth:
    // \`\${site}/api/auth\`). Until then \`clegra check\` says it is missing.
    authorizationServers: [],
    resolve: async (token, _request, _info) => {
      const local = localCaller(token)
      if (local) return local
      // TODO(your sign-in): verify your authorization server's access token (signature, expiry, and aud ===
      // _info.resource, this server's MCP address) and say who is calling, from your own users and roles:
      //   return { installation: user.organizationId, person: { id: user.id, name: user.name }, permissions: ["tasks.edit"] }
      // Recipes: auth.md in the @clegra/sdk docs. null refuses the token (401).
      return null
    },
  },
})
`
  return [
    { file: `task.${ext}`, text: task },
    { file: `complete.${ext}`, text: complete },
    { file: `tasks.${ext}`, text: tasks },
    { file: `app.${ext}`, text: app },
    { file: `index.${ext}`, text: index },
  ]
}

/** `app/api/clegra/[...path]/route.ts`: the one route that serves MCP, the manifest, the OpenAPI index and the OAuth metadata. */
export function routeFile(input: { importPath: string }): string {
  return `import { toNextHandlers } from "@clegra/sdk/next"

import { served } from ${JSON.stringify(input.importPath)}

// MCP (/mcp), the manifest and the OAuth metadata (/.well-known/…), the index (/openapi.json, /operations/…),
// rewritten here by withClegra in next.config.
export const { GET, POST, DELETE, OPTIONS } = toNextHandlers(served)
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
export function envLines(token: string): string {
  return `# clegra: a local bearer for MCP clients and \`clegra check\` while your sign-in is not wired yet.
# Accepted only outside production (see localCaller in clegra/index). Keep this file out of git.
${LOCAL_TOKEN_ENV}=${token}
`
}
