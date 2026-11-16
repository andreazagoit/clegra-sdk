import { AuthError, defineApp } from "modelapp"
import { z } from "zod"

// A tiny MAP app for the real-Next test. Its "own tokens" are one random bearer the test passes in the environment
// (FIXTURE_TOKEN), accepted only for the configured audience — enough to run `modelapp check` with a token.
const resource = `${process.env.MODELAPP_PUBLIC_URL ?? "http://127.0.0.1:3941"}/mcp`
const notes = [
  { id: "n1", title: "First note", org: "org-a" },
  { id: "n2", title: "Second note", org: "org-a" },
]

export const app = defineApp({
  name: "fixture-notes",
  title: "Fixture notes",
  version: "1.0.0",
  auth: {
    resource,
    authorizationServers: [`${new URL(resource).origin}/api/auth`],
    resolve: (token, _request, info) => {
      if (!process.env.FIXTURE_TOKEN || token !== process.env.FIXTURE_TOKEN) return null
      if (info.resource !== resource) throw new AuthError("the token is for another server")
      return { installation: "org-a", person: { id: "u1", name: "Test person" }, permissions: "all" }
    },
  },
  permissions: { "notes.view": { label: "See notes", default: true } },
  // The embedded page (app/embed/board): framed by the test's host harness on http://localhost (another site than
  // 127.0.0.1), signed in with a ticket. Development origins are refused in production: next start declares none.
  embed: {
    frameAncestors: process.env.NODE_ENV === "production" ? ["https://host.example"] : ["http://localhost:*"],
    secret: process.env.FIXTURE_EMBED_SECRET,
  },
  pages: { board: { title: "Board", url: "/embed/board", permission: "notes.view" } },
  entities: {
    note: {
      label: "Note",
      permission: "notes.view",
      schema: z.object({ id: z.string(), title: z.string().meta({ role: "title", search: true, sort: true }) }),
      get: (id, ctx) => notes.find((n) => n.id === id && n.org === ctx.installation) ?? null,
      list: (_q, ctx) => ({ rows: notes.filter((n) => n.org === ctx.installation).map(({ id, title }) => ({ id, title })) }),
    },
  },
})
