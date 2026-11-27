import assert from "node:assert/strict"
import { after, describe, test } from "node:test"

import type { SqlQuery } from "./store"
import { SqlStore } from "./store"
import { passwordLogin } from "./signin/password"
import { SqlSignInStore } from "./signin/store"

// THE SQL STORES ON EACH DRIVER: what a value is when it is written must be what it is when it is read, and what
// Postgres holds (a jsonb object, not a jsonb string of its text), on PGlite and on a real Postgres through
// postgres.js (`sql.unsafe(text, params)`, prepared or not). postgres.js serializes a parameter by the type the
// server infers for it: a JSON text sent to `$n::jsonb` was encoded a second time.
//
// The postgres.js runs need a Postgres made for the test: CLEGRA_SDK_TEST_DATABASE_URL (`npm run test:postgres`
// starts a scratch container, runs this file and removes it). Without it they are skipped, and say so.

type Driver = { name: string; query: SqlQuery; raw: (text: string) => Promise<Record<string, unknown>[]>; close: () => Promise<void> }

const POSTGRES_URL = process.env.CLEGRA_SDK_TEST_DATABASE_URL
let schemaCount = 0

async function pglite(): Promise<Driver> {
  const { PGlite } = await import("@electric-sql/pglite")
  const db = new PGlite()
  return {
    name: "PGlite",
    query: (text, params) => db.query(text, params) as never,
    raw: async (text) => (await db.query(text)).rows as Record<string, unknown>[],
    close: () => db.close(),
  }
}

/** postgres.js on a schema of its own (dropped at the end), so runs never see each other's rows. */
async function postgresJs(prepare: boolean): Promise<Driver> {
  const { default: postgres } = await import("postgres")
  const schema = `sdk_test_${process.pid}_${++schemaCount}`
  const admin = postgres(POSTGRES_URL!, { max: 1, onnotice: () => {} })
  await admin.unsafe(`CREATE SCHEMA ${schema}`)
  const sql = postgres(POSTGRES_URL!, { max: 2, prepare, onnotice: () => {}, connection: { search_path: schema } })
  return {
    name: `postgres.js (prepare: ${prepare})`,
    query: async (text, params) => [...(await sql.unsafe(text, params as never[]))] as Record<string, unknown>[],
    raw: async (text) => [...(await sql.unsafe(text))] as Record<string, unknown>[],
    close: async () => {
      await sql.end({ timeout: 5 })
      await admin.unsafe(`DROP SCHEMA ${schema} CASCADE`)
      await admin.end({ timeout: 5 })
    },
  }
}

const drivers: { name: string; open: () => Promise<Driver>; skip?: string }[] = [
  { name: "PGlite", open: pglite },
  ...[true, false].map((prepare) => ({
    name: `postgres.js (prepare: ${prepare})`,
    open: () => postgresJs(prepare),
    ...(POSTGRES_URL ? {} : { skip: "set CLEGRA_SDK_TEST_DATABASE_URL to a test Postgres (npm run test:postgres)" }),
  })),
]

const values: [string, unknown][] = [
  ["object", { email: "ada@prova.test", n: 1, nested: { list: [1, "two", null, true] } }],
  ["string", "plain string"],
  ["json-looking string", '{"not":"an object"}'],
  ["number", 42],
  ["boolean", false],
  ["array", [{ a: 1 }, "b"]],
  ["null", null],
]

for (const d of drivers) {
  describe(`SQL stores on ${d.name}`, { skip: d.skip }, () => {
    const opened: Driver[] = []
    const open = async () => {
      const driver = await d.open()
      opened.push(driver)
      return driver
    }
    after(async () => {
      for (const driver of opened) await driver.close()
    })

    test("SqlSignInStore: every value round-trips and Postgres holds it as that jsonb value", async () => {
      const db = await open()
      for (const statement of SqlSignInStore.schema().split("\n")) await db.raw(statement)
      const store = new SqlSignInStore(db.query)
      for (const [kind, value] of values) await store.set(`v:${kind}`, value, kind === "object" ? 60_000 : null)
      for (const [kind, value] of values) assert.deepEqual(await store.get(`v:${kind}`), value, `get ${kind}`)
      const held = Object.fromEntries((await db.raw(`SELECT key, jsonb_typeof(value) AS t FROM clegra_signin WHERE key LIKE 'v:%'`)).map((r) => [r.key, r.t]))
      assert.deepEqual(held, { "v:object": "object", "v:string": "string", "v:json-looking string": "string", "v:number": "number", "v:boolean": "boolean", "v:array": "array", "v:null": "null" })
      assert.deepEqual(
        (await store.list("v:")).map((e) => [e.key, e.value]),
        values.map(([kind, value]) => [`v:${kind}`, value]).sort((a, b) => (String(a[0]) < String(b[0]) ? -1 : 1)),
      )
      assert.deepEqual(await store.take("v:object"), values[0]![1])
      assert.equal(await store.take("v:object"), null)
      await store.set("v:string", { replaced: true }, null)
      assert.deepEqual(await store.get("v:string"), { replaced: true })
      await store.delete("v:string")
      assert.equal(await store.get("v:string"), null)
      await store.set("gone", { n: 1 }, 1)
      await new Promise((r) => setTimeout(r, 20))
      assert.equal(await store.get("gone"), null)
      assert.equal(await store.take("gone"), null)
      assert.equal(await store.once("proof", 60_000), true)
      assert.equal(await store.once("proof", 60_000), false)
      assert.equal(await store.hit("h", 60_000), 1)
      assert.equal(await store.hit("h", 60_000), 2)
      assert.equal(await store.hit("h", 60_000), 3)
    })

    test("SqlSignInStore: an account made by the password login signs in", async () => {
      const db = await open()
      for (const statement of SqlSignInStore.schema().split("\n")) await db.raw(statement)
      const login = passwordLogin({ origin: "http://localhost:3000", store: new SqlSignInStore(db.query), title: { en: "Test" }, iterations: 1000 })
      await login.accounts.create({ email: "ada@prova.test", name: "Ada", password: "correct horse battery" })
      const post = (password: string) =>
        login.fetch!(new Request("http://localhost:3000/signin", { method: "POST", headers: { origin: "http://localhost:3000", "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ email: "ada@prova.test", password, return: "/" }) }))
      assert.equal((await post("correct horse battery"))?.status, 303)
      assert.equal((await post("wrong"))?.status, 401)
    })

    test("SqlStore: every value round-trips, expiry and single use hold", async () => {
      const db = await open()
      for (const statement of SqlStore.schema().split("\n")) await db.raw(statement)
      const store = new SqlStore(db.query)
      for (const [kind, value] of values) await store.set(`v:${kind}`, value, kind === "object" ? 60 : undefined)
      for (const [kind, value] of values) assert.deepEqual(await store.get(`v:${kind}`), value, `get ${kind}`)
      assert.deepEqual(
        (await store.list("v:")).map((e) => [e.key, e.value]),
        values.map(([kind, value]) => [`v:${kind}`, value]).sort((a, b) => (String(a[0]) < String(b[0]) ? -1 : 1)),
      )
      assert.equal(await store.add("v:object", "other"), false)
      assert.equal(await store.add("fresh", { n: 2 }, 60), true)
      assert.deepEqual(await store.take("fresh"), { n: 2 })
      assert.equal(await store.take("fresh"), null)
      await store.delete("v:string")
      assert.equal(await store.get("v:string"), null)
      await db.raw(`INSERT INTO clegra_store (key, value, expires_at) VALUES ('old', '1', now() - interval '1 second')`)
      assert.equal(await store.get("old"), null)
      assert.equal(await store.take("old"), null)
      assert.equal(await store.sweep(), 0)
      await db.raw(`INSERT INTO clegra_store (key, value, expires_at) VALUES ('old', '1', now() - interval '1 second')`)
      assert.equal(await store.sweep(), 1)
    })
  })
}
