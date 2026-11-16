import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { after, before, describe, test } from "node:test"

import { PGlite } from "@electric-sql/pglite"

import { MemoryStore, SqlStore, type IdempotencyStore, type LaterRun } from "./store"

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

// The later part: runs kept as confirmed, taken once.
const run = (over: Partial<LaterRun> = {}): LaterRun => ({
  id: randomUUID(),
  tenant: `t-${Math.random()}`,
  tool: "publish",
  args: { text: "hello", when: "2026-01-01T10:00:00.000Z", nested: { b: 1, a: [1, "x"] } },
  argsHash: "hash",
  at: "2026-01-01T10:00:00.000Z",
  until: 1767263400,
  author: { id: "p1", name: "Ada" },
  permissions: ["posts.publish"],
  proof: "proof.jwt.here",
  issuer: "https://host.test",
  subject: "p1",
  installation: "inst",
  call: "c1",
  confirmedAt: 1767250000,
  ...over,
})

const laterContract = (name: string, store: () => IdempotencyStore) =>
  describe(`${name}: later runs`, () => {
    test("a run comes back exactly as kept, due by its time, oldest first, per tenant", async () => {
      const s = store().later!
      const first = run({ at: "2026-01-01T09:00:00.000Z" })
      const second = run({ tenant: first.tenant, at: "2026-01-01T10:00:00+00:00", proof: null, call: null, author: null })
      const future = run({ tenant: first.tenant, at: "2099-01-01T00:00:00.000Z" })
      for (const r of [second, future, first, run()]) await s.add(r)
      const due = await s.due(first.tenant, new Date("2026-06-01T00:00:00Z"), 10)
      assert.deepEqual(due, [first, second])
      assert.deepEqual(await s.due(first.tenant, new Date("2026-06-01T00:00:00Z"), 1), [first])
      assert.deepEqual(await s.due("nobody", new Date("2100-01-01T00:00:00Z"), 10), [])
    })

    test("claim is single use, also when two ask at the same moment; another tenant can't claim it", async () => {
      const s = store().later!
      const r = run()
      await s.add(r)
      assert.equal(await s.claim(r.id, "another"), null)
      const claims = await Promise.all(Array.from({ length: 6 }, () => s.claim(r.id, r.tenant)))
      assert.equal(claims.filter(Boolean).length, 1)
      assert.deepEqual(claims.find(Boolean), r)
      assert.equal(await s.claim(r.id, r.tenant), null)
      assert.deepEqual(await s.due(r.tenant, new Date("2100-01-01T00:00:00Z"), 10), [], "a claimed run is no longer due")
      await s.finish(r.id, { status: "done", message: "Done." })
      assert.equal(await s.claim(r.id, r.tenant), null)
    })

    test("cancel takes a pending run of the tenant only; clear deletes the tenant's runs", async () => {
      const s = store().later!
      const r = run()
      const other = run({ tenant: r.tenant })
      await s.add(r)
      await s.add(other)
      assert.equal(await s.cancel(r.id, "another"), false)
      assert.equal(await s.cancel(r.id, r.tenant), true)
      assert.equal(await s.cancel(r.id, r.tenant), false)
      assert.equal(await s.claim(r.id, r.tenant), null, "a cancelled run never runs")
      assert.equal(await s.clear(r.tenant), 2)
      assert.equal(await s.clear(r.tenant), 0)
    })
  })

laterContract("MemoryStore", () => new MemoryStore())
laterContract("SqlStore (Postgres, PGlite)", () => sql)

test("SqlStore.schema creates both tables, and can run again (a new migration)", async () => {
  const db = new PGlite()
  try {
    await db.exec(SqlStore.schema("app_store"))
    await db.exec(SqlStore.schema("app_store"))
    const tables = (await db.query<{ table_name: string }>("SELECT table_name FROM information_schema.tables WHERE table_name LIKE 'app_store%' ORDER BY table_name")).rows.map((r) => r.table_name)
    assert.deepEqual(tables, ["app_store", "app_store_later"])
  } finally {
    await db.close()
  }
  assert.throws(() => SqlStore.schema("a".repeat(46)), /at most 45 characters/)
})

test("SqlStore refuses a table name that isn't a plain SQL name", () => {
  assert.throws(() => new SqlStore(async () => [], { table: "x; drop table users" }), /plain lowercase/)
  assert.throws(() => SqlStore.schema("Bad-Name"), /plain lowercase/)
})

test("SqlStore takes a driver that answers with an array of rows", async () => {
  const s = new SqlStore(async (text, params) => (await pg.query(text, params)).rows as Record<string, unknown>[])
  assert.equal(await s.once(`jti-${Math.random()}`, 60_000), true)
})
