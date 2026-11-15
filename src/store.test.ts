import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { PGlite } from "@electric-sql/pglite"

import { MemoryStore, SqlStore, type IdempotencyStore } from "./store"

// The two stores keep the same contract (spec §7: idempotency is atomic, a host token is used once).

const pg = new PGlite()
before(async () => {
  await pg.exec(SqlStore.schema())
})
after(async () => {
  await pg.close()
})
const sql = new SqlStore((text, params) => pg.query(text, params))

const contract = (name: string, store: () => IdempotencyStore) =>
  describe(name, () => {
    test("begin claims a free key once; a second begin sees it running, then finished", async () => {
      const s = store()
      const key = `k-${Math.random()}`
      assert.equal(await s.begin(key, "args-1", 60_000), null)
      assert.deepEqual(await s.begin(key, "args-1", 60_000), { args: "args-1" })
      await s.finish(key, { args: "args-1", result: { content: [{ type: "text", text: "Done." }] } }, 60_000)
      assert.deepEqual(await s.begin(key, "args-2", 60_000), { args: "args-1", result: { content: [{ type: "text", text: "Done." }] } })
    })

    test("abandon frees a key that never finished", async () => {
      const s = store()
      const key = `k-${Math.random()}`
      assert.equal(await s.begin(key, "a", 60_000), null)
      await s.abandon(key)
      assert.equal(await s.begin(key, "a", 60_000), null)
    })

    test("an expired key is free again", async () => {
      const s = store()
      const key = `k-${Math.random()}`
      assert.equal(await s.begin(key, "a", 1), null)
      await new Promise((r) => setTimeout(r, 20))
      assert.equal(await s.begin(key, "b", 60_000), null)
    })

    test("once is true the first time only, also when asked at the same moment", async () => {
      const s = store()
      const key = `jti-${Math.random()}`
      const answers = await Promise.all(Array.from({ length: 8 }, () => s.once(key, 60_000)))
      assert.equal(answers.filter(Boolean).length, 1)
      assert.equal(await s.once(key, 60_000), false)
    })

    test("two begins at the same moment: exactly one runs", async () => {
      const s = store()
      const key = `k-${Math.random()}`
      const answers = await Promise.all(Array.from({ length: 8 }, () => s.begin(key, "x", 60_000)))
      assert.equal(answers.filter((a) => a === null).length, 1)
    })
  })

contract("MemoryStore", () => new MemoryStore())
contract("SqlStore (Postgres, PGlite)", () => sql)

test("SqlStore refuses a table name that isn't a plain SQL name", () => {
  assert.throws(() => new SqlStore(async () => [], { table: "x; drop table users" }), /plain lowercase/)
  assert.throws(() => SqlStore.schema("Bad-Name"), /plain lowercase/)
})

test("SqlStore takes a driver that answers with an array of rows", async () => {
  const s = new SqlStore(async (text, params) => (await pg.query(text, params)).rows as Record<string, unknown>[])
  assert.equal(await s.once(`jti-${Math.random()}`, 60_000), true)
})
