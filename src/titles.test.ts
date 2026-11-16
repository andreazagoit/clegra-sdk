import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, describe, test } from "node:test"

import { z } from "zod"

import { defineApp, type AuthOptions } from "./index"
import { testClient } from "./testing"

/**
 * A record is named by its title wherever a person reads about it (spec §6 rule 10, §7): the model reads each
 * record's title beside its URI, an action on a record takes a title hint for the client's own approval prompt,
 * and the app never trusts that hint: it names the record from its id, and a hint naming another record stops the call.
 */

const keyFile = join(tmpdir(), `clegra-titles-key-${randomUUID()}.json`)
after(() => rmSync(keyFile, { force: true }))

type Deal = { id: string; name: string; stage: string }

function makeApp() {
  const deals: Deal[] = [
    { id: "d1", name: "Hartley Engineering", stage: "open" },
    { id: "d2", name: "Acme <Tools>", stage: "open" },
  ]
  const ran: unknown[] = []
  const app = defineApp({
    name: "sales",
    title: "Sales",
    version: "1.0.0",
    locale: "en",
    auth: { dev: { keyFile, code: "TITLE1" } } as AuthOptions,
    entities: {
      deal: {
        label: "Deal",
        schema: z.object({ id: z.string(), name: z.string().meta({ role: "title", label: "Deal", search: true, untrusted: true }), stage: z.string().meta({ role: "status", label: "Stage" }) }),
        get: (id) => deals.find((d) => d.id === id) ?? null,
        list: () => ({ rows: deals }),
      },
    },
    actions: {
      mark_won: {
        on: "deal",
        title: "Mark as won",
        input: z.object({ note: z.string().optional() }),
        confirm: true,
        expose: { plain: true },
        run: (input, _ctx, deal) => {
          ran.push({ input, id: deal.id })
          return { message: `${deal.name} marked as won.`, record: deal.id }
        },
      },
    },
  })
  return { app, ran }
}

const textOf = (r: { content?: { text?: string }[] }) => JSON.parse(r.content?.[0]?.text ?? "null")

describe("records named by their title", () => {
  test("list and get texts carry each record's title next to its URI (an outsider's title wrapped)", async () => {
    const { app } = makeApp()
    const c = await testClient(app, { permissions: "all" })
    const list = textOf(await c.call("deal_list", {})) as { rows: { uri: string; title: string }[] }
    assert.deepEqual(list.rows.map((r) => [r.uri, r.title]), [
      ["clegra://sales/deal/d1", "<untrusted>Hartley Engineering</untrusted>"],
      ["clegra://sales/deal/d2", "<untrusted>Acme &lt;Tools&gt;</untrusted>"],
    ])
    const one = textOf(await c.call("deal_get", { id: "d1" })) as { uri: string; title: string }
    assert.equal(one.title, "<untrusted>Hartley Engineering</untrusted>")
    const found = textOf(await c.call("search", { query: "Hartley" })) as { results: { id: string; title: string }[] }
    assert.equal(found.results[0]!.title, "<untrusted>Hartley Engineering</untrusted>")
  })

  test("an action on a record takes id and an optional record_title, both described for the model", async () => {
    const { app } = makeApp()
    const c = await testClient(app, { permissions: "all" })
    const tool = (await c.listTools()).find((t) => t.name === "deal_mark_won")!
    const schema = tool.inputSchema as { properties: Record<string, { type?: string; description?: string; maxLength?: number }>; required?: string[] }
    assert.deepEqual(Object.keys(schema.properties), ["id", "record_title", "note"])
    assert.deepEqual(schema.required, ["id"])
    assert.equal(schema.properties.record_title!.type, "string")
    assert.match(schema.properties.id!.description!, /name the deal by its title, never by this id/)
    assert.match(schema.properties.record_title!.description!, /Display only: the app names the deal from its id/)
    assert.match(tool.description!, /On one deal: its `id`, and its title in `record_title`\./)
    // The manifest's input is the developer's: the SDK's id and hint are not in it.
    assert.deepEqual(Object.keys(app.manifest().actions[0]!.input.properties ?? {}), ["note"])
  })

  test("the hint never reaches the handler; a matching one (as the model copied it) runs, another record's stops the call", async () => {
    const { app, ran } = makeApp()
    const c = await testClient(app, { permissions: "all" })
    const ok = await c.call("deal_mark_won", { id: "d2", record_title: "<untrusted>acme &lt;tools&gt;</untrusted>", note: "yes" })
    assert.ok(!ok.isError, JSON.stringify(ok))
    assert.deepEqual(ran, [{ input: { note: "yes" }, id: "d2" }])
    assert.ok(!(await c.call("deal_mark_won", { id: "d1", record_title: " «Hartley  ENGINEERING» " })).isError)
    assert.ok(!(await c.call("deal_mark_won", { id: "d1" })).isError, "the hint is optional")
    const wrong = await c.call("deal_mark_won", { id: "d1", record_title: "Acme Tools" })
    const error = (wrong.structuredContent as { error: { code: string; message: string; fields: Record<string, string> } }).error
    assert.equal(error.code, "invalid_input")
    assert.match(error.message, /record_title doesn't match the deal with id d1: read it again \(deal_get\)/)
    assert.ok(error.fields.record_title)
    assert.equal(ran.length, 3, "the mismatched call did not run")
    assert.ok((await c.call("deal_mark_won", { id: "d1", record_title: 7 })).isError, "a hint is text")
  })

  test("a workspace host's confirmation names the record from the app, never from the hint", async () => {
    const { app } = makeApp()
    const c = await testClient(app, { host: "workspace", permissions: "all" })
    const asked = await c.call("deal_mark_won", { id: "d1", record_title: "Hartley Engineering" }, { clegra: { call: "c1" } })
    const confirm = (asked.structuredContent as { error: { code: string; confirm: { record: { title: string; uri: string } } } }).error
    assert.equal(confirm.code, "confirmation_required")
    assert.deepEqual([confirm.confirm.record.uri, confirm.confirm.record.title], ["clegra://sales/deal/d1", "Hartley Engineering"])
  })

  test("an action can't declare the SDK's record_title", () => {
    assert.throws(
      () =>
        defineApp({
          name: "xy",
          title: "X",
          version: "1",
          auth: { dev: { keyFile } } as AuthOptions,
          entities: { a: { label: "A", schema: z.object({ id: z.string(), n: z.string().meta({ role: "title" }) }), get: () => null, list: () => ({ rows: [] }) } },
          actions: { go: { on: "a", title: "Go", input: z.object({ record_title: z.string() }), run: () => ({ message: "ok" }) } },
        }),
      /record_title/,
    )
  })
})
