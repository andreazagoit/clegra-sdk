import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { z } from "zod"

import { defineAction, defineApp, defineEntity, serve, type Action, type AuthOptions } from "./index"
import { testClient } from "./testing"

// PUBLIC OPERATIONS (spec §7 «Public operations»; owner, 2026-11-25: signing in is not mandatory for an app): with
// `auth.public` a call without a token reaches only the actions declared `public`, in production too; a public write
// is always confirmed (the host asks the person, destructiveHint), and the public caller sees no record.
const station = defineEntity({
  name: "station",
  label: "Station",
  schema: z.object({ id: z.string(), name: z.string().meta({ role: "title", label: "Name" }) }),
  get: () => ({ id: "s1", name: "Verona" }),
  list: () => ({ rows: [{ id: "s1", name: "Verona" }] }),
})
const forecast = defineAction({ name: "forecast", title: "Forecast", input: z.object({ city: z.string() }), readOnly: true, public: true, run: ({ city }) => ({ message: `Sunny in ${city}` }) })
const subscribe = defineAction({ name: "subscribe", title: "Subscribe to alerts", input: z.object({ email: z.string() }), public: true, run: ({ email }) => ({ message: `Subscribed ${email}` }) })
const purge = defineAction({ name: "purge", title: "Purge stations", input: z.object({}), confirm: "always", run: () => ({ message: "purged" }) })

const weather = (extra: { actions?: Action[]; permissions?: Record<string, { label: string }>; auth?: AuthOptions } = {}) =>
  serve(
    defineApp({ name: "weather", title: "Weather", version: "1.0.0", locale: "en", entities: [station], actions: extra.actions ?? [forecast, subscribe, purge], ...(extra.permissions ? { permissions: extra.permissions } : {}) }),
    { auth: extra.auth ?? { public: { installation: "public" } } },
  )

const asProduction = <T>(fn: () => T): T => {
  const env = process.env as Record<string, string | undefined>
  const was = env.NODE_ENV
  env.NODE_ENV = "production"
  try {
    return fn()
  } finally {
    env.NODE_ENV = was
  }
}

describe("public operations", () => {
  test("allowed in production, said in the manifest", () => {
    const app = asProduction(() => weather())
    const actions = app.manifest().actions
    assert.equal(actions.find((a) => a.name === "forecast")?.public, true)
    assert.equal(actions.find((a) => a.name === "subscribe")?.confirm, "always")
    assert.equal(actions.find((a) => a.name === "purge")?.public, undefined)
  })

  test("a caller without a token: only the public actions, no record", async () => {
    const c = await testClient(weather(), { token: null })
    assert.equal(c.status, 200)
    const tools = await c.listTools()
    const names = tools.map((t) => t.name)
    assert.ok(names.includes("forecast") && names.includes("subscribe"), names.join(", "))
    assert.ok(!names.includes("purge") && !names.includes("station_list") && !names.includes("station_get"), names.join(", "))
    // The public write is always confirmed: the host asks the person (MCP annotations).
    assert.equal(tools.find((t) => t.name === "subscribe")?.annotations?.destructiveHint, true)
    assert.equal(tools.find((t) => t.name === "forecast")?.annotations?.readOnlyHint, true)
    const read = await c.call("forecast", { city: "Verona" })
    assert.notEqual(read.isError, true)
    assert.match(JSON.stringify(read.content), /Sunny in Verona/)
    const refused = await c.call("purge", {})
    assert.equal(refused.isError, true)
  })

  test("refused when it would not be safe: a record action, a permission, a write not always confirmed, hidden from clients", () => {
    const action = (a: Record<string, unknown>) => () => weather({ actions: [defineAction({ name: "x", title: "X", input: z.object({}), public: true, run: () => ({ message: "x" }), ...a } as never)] })
    assert.throws(action({ confirm: "never" }), /public write is always confirmed/)
    assert.throws(action({ confirm: "optional" }), /public write is always confirmed/)
    assert.throws(action({ on: station, readOnly: true }), /public action is global/)
    assert.throws(action({ readOnly: true, expose: { plain: false } }), /for every client/)
    assert.throws(() => weather({ permissions: { "x.use": { label: "Use" } }, actions: [defineAction({ name: "x", title: "X", input: z.object({}), readOnly: true, public: true, permission: "x.use", run: () => ({ message: "x" }) })] }), /needs no permission/)
    assert.throws(() => weather({ auth: { public: { installation: "public" }, anonymous: { installation: "demo", permissions: [] } } }), /one or the other/)
  })
})
