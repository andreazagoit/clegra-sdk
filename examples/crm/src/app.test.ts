import assert from "node:assert/strict"
import { beforeEach, test } from "node:test"

import { testClient } from "@mcpw/server/testing"

process.env.MCPW_DEV_CODE ??= "TEST"
const { app, resetData } = await import("./app")

beforeEach(() => resetData())

test("the card validates and lists the CRM", () => {
  const card = app.card()
  assert.deepEqual(card.entities.map((e) => e.name), ["company", "contact", "deal"])
  assert.deepEqual(card.pages.map((p) => p.name).sort(), ["companies", "company", "contact", "contacts", "deal", "deals", "forecast", "pipeline"])
})

test("a sales rep doesn't see deal values; a manager does", async () => {
  const rep = await testClient(app, { person: "bruno", permissions: ["deals.view", "deals.edit", "contacts.edit"] })
  const rows = ((await rep.call("deal_list", { stage: "proposal" })).structuredContent as { rows: Record<string, unknown>[] }).rows
  assert.equal(rows.length, 1)
  assert.ok(!("value" in rows[0]!))
  assert.ok(!(await rep.listTools()).some((t) => t.name === "show_pipeline_total" || t.name === "open_forecast"))
  const manager = await testClient(app, { person: "ada", permissions: "all" })
  const all = ((await manager.call("deal_list", { sort: "value", dir: "desc" })).structuredContent as { rows: { value: number }[] }).rows
  assert.equal(all[0]!.value, 18000)
})

test("marking a deal won from a workspace host needs the confirmation", async () => {
  const c = await testClient(app, { person: "ada", permissions: "all", host: "workspace" })
  const asked = await c.call("deal_mark_won", { id: "d1" }, { "mcpw/call": "w1" })
  assert.equal((asked.structuredContent as { error: { code: string } }).error.code, "confirmation_required")
  const done = await c.confirmed("deal_mark_won", { id: "d1" }, "w1")
  assert.ok(!done.isError, JSON.stringify(done))
  const deal = ((await c.call("deal_get", { id: "d1" })).structuredContent as { record: { stage: string } }).record
  assert.equal(deal.stage, "won")
})

test("the pipeline dashboard resolves its fragments", async () => {
  const c = await testClient(app, { person: "ada", permissions: "all" })
  const r = await c.call("open_pipeline", { days: 365 })
  const fragments = (r.structuredContent as { fragments: { state: string; template: string; data: Record<string, unknown> }[] }).fragments
  assert.deepEqual(fragments.map((f) => f.template), ["stat", "chart", "list"])
  assert.equal(fragments[0]!.data.value, 36500)
})
