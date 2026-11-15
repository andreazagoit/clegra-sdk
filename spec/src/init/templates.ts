/**
 * The files `modelapp init` writes. Plain strings: no template engine. Each takes `ts` (TypeScript or plain
 * JavaScript, as the project is written) and gives the file's text.
 */

/** The environment variable of the local bearer (`.env.local`): accepted by the generated `resolve` outside production only. */
export const LOCAL_TOKEN_ENV = "MODELAPP_LOCAL_TOKEN"

/** `modelapp.ts`: a small working app on in-file sample data, with the places to plug the database and the sign-in marked TODO. */
export function modelappFile(input: { name: string; title: string; ts: boolean }): string {
  const { name, title, ts } = input
  const T = (typed: string, plain: string) => (ts ? typed : plain)
  return `// Your app as a MAP app (Model App Protocol): one defineApp object that becomes a manifest for workspace hosts
// and a plain MCP server for ChatGPT, Claude and any MCP client. Served by app/api/modelapp/[...path]/route${ts ? ".ts" : ".js"};
// next.config's withModelApp puts it at /mcp and /.well-known/modelapp.json. Written by \`npx modelapp init\`.
import { timingSafeEqual } from "node:crypto"

import { AppError, defineApp${T(", type ResolvedCaller", "")} } from "modelapp"
import { z } from "zod"

// ------------------------------------------------------------------ data
// TODO(your data): replace the sample tasks with your database (any database, ORM or API). Scope every read and
// write by ctx.installation: the tenant your resolve() below names (an organization, a workspace, an account).
${T('type Task = { id: string; title: string; status: "open" | "done"; due: string }\n', "")}const sample${T(": Task[]", "")} = [
  { id: "t1", title: "Send the spring catalog to the printer", status: "open", due: "2026-03-02" },
  { id: "t2", title: "Renew the domain name", status: "open", due: "2026-03-15" },
  { id: "t3", title: "Archive last year's invoices", status: "done", due: "2026-01-31" },
]
const tasksByInstallation = new Map${T("<string, Task[]>", "")}()
function tasksOf(installation${T(": string", "")})${T(": Task[]", "")} {
  let tasks = tasksByInstallation.get(installation)
  if (!tasks) tasksByInstallation.set(installation, (tasks = sample.map((t) => ({ ...t }))))
  return tasks
}

// ------------------------------------------------------------------ auth
// The public origin (MODELAPP_PUBLIC_URL, like https://app.example.com): its /mcp is the only audience tokens are
// accepted for. Required in production; unset locally, the app answers at whatever address you reach it by.
const site = process.env.MODELAPP_PUBLIC_URL?.replace(/\\/+$/, "")
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

// ------------------------------------------------------------------ the app

export const app = defineApp({
  name: ${JSON.stringify(name)},
  title: ${JSON.stringify(title)},
  version: "0.1.0",
  auth: {
    ...(resource ? { resource } : {}),
    // TODO(your sign-in): the OAuth authorization server that issues your users' tokens to MCP clients, named in the
    // protected-resource metadata (better-auth: \`\${site}/api/auth\`). Until then \`modelapp check\` says it is missing.
    authorizationServers: [],
    resolve: async (token, _request, _info) => {
      const local = localCaller(token)
      if (local) return local
      // TODO(your sign-in): verify your sign-in's access token (signature, expiry, and aud === _info.resource, this
      // server's MCP address) and say who is calling, from your own users and roles:
      //   return { installation: user.organizationId, person: { id: user.id, name: user.name }, permissions: ["tasks.edit"] }
      // Recipes for better-auth, Clerk, Auth0 and WorkOS: auth.md in the modelapp docs. null refuses the token (401).
      return null
    },
  },

  permissions: {
    "tasks.edit": { label: "Complete tasks", default: true },
  },

  entities: {
    task: {
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
    },
  },

  actions: {
    complete: {
      on: "task",
      title: "Complete",
      description: "Marks an open task as done",
      input: z.object({}),
      permission: "tasks.edit",
      // Writes ask the person first (confirm defaults to always); plain MCP clients see them only with plain: true.
      expose: { plain: true },
      run: (_input, ctx, task) => {
        const stored = tasksOf(ctx.installation).find((t) => t.id === task.id)
        if (!stored || stored.status === "done") throw new AppError("conflict", "The task is already done.")
        stored.status = "done"
        return { message: \`\${task.title}: done.\`, record: task.id }
      },
    },
  },

  pages: {
    tasks: { title: "Tasks", icon: "check-square", list: "task", columns: ["title", "status", "due"] },
  },
})
`
}

/** `app/api/modelapp/[...path]/route.ts`: the one route that serves MCP, the manifest and the OAuth metadata. */
export function routeFile(input: { importPath: string }): string {
  return `import { toNextHandlers } from "modelapp/next"

import { app } from ${JSON.stringify(input.importPath)}

// MCP (/mcp), the manifest and the OAuth metadata (/.well-known/…), rewritten here by withModelApp in next.config.
export const { GET, POST, DELETE, OPTIONS } = toNextHandlers(app)
`
}

/** A next.config for a project without one. */
export function nextConfigFile(ts: boolean): string {
  return ts
    ? `import type { NextConfig } from "next"
import { withModelApp } from "modelapp/next"

const nextConfig: NextConfig = {}

export default withModelApp(nextConfig)
`
    : `import { withModelApp } from "modelapp/next"

/** @type {import("next").NextConfig} */
const nextConfig = {}

export default withModelApp(nextConfig)
`
}

/** The lines added to `.env.local`. */
export function envLines(token: string): string {
  return `# modelapp: a local bearer for MCP clients and \`modelapp check\` while your sign-in is not wired yet.
# Accepted only outside production (see localCaller in modelapp.ts). Keep this file out of git.
${LOCAL_TOKEN_ENV}=${token}
`
}
