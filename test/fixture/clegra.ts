import { AuthError, defineApp, type ClegraOptions } from "@clegra/sdk"
import { z } from "zod"

// A tiny Clegra app for the real-Next test. Its "own tokens" are one random bearer the test passes in the environment
// (FIXTURE_TOKEN), accepted only for the configured audience — enough to run `clegra check` with a token. It also
// trusts the test's core (FIXTURE_CORE: its issuer and key set, and the harness's client origin), so a Clegra client
// (the test's harness) shows its own site (app/board, app/notes) signed in with a site ticket (spec §5.1).
const core = process.env.FIXTURE_CORE ? (JSON.parse(process.env.FIXTURE_CORE) as Pick<ClegraOptions, "issuer" | "jwks" | "clientOrigins">) : null
const resource = `${process.env.CLEGRA_PUBLIC_URL ?? "http://127.0.0.1:3941"}/mcp`
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
    ...(core ? { clegra: { ...core, allowedCompanies: "any" as const, registrationId: "11111111-2222-4333-8444-555555555555" } } : {}),
  },
  permissions: { "notes.view": { label: "See notes", default: true } },
  ...(core ? { site: { start: "/board", secret: process.env.FIXTURE_SITE_SECRET } } : {}),
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
