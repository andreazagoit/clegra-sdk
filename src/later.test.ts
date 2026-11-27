import assert from "node:assert/strict"
import { after, before, beforeEach, describe, mock, test } from "node:test"

import { PGlite } from "@electric-sql/pglite"
import { z } from "zod"

import { argsHash, defineAction, defineApp, defineEntity, MemoryStore, serve, SqlStore, type IdempotencyStore, type LaterInfo } from "./index"
import { devSignIn } from "./signin"
import { installationClient, testClient, type ToolCallResult } from "./testing"

/**
 * «Approve now, act later»: a write the person confirms now, kept with the host's proof, run by the installation's
 * `clegra_later` schedule when it is due — once, exactly as confirmed, within its deadline.
 */

const randomUUID = () => crypto.randomUUID()
const pg = new PGlite()
before(async () => {
  await pg.exec(SqlStore.schema("posts_store"))
  // The SQL is idempotent: a later migration may run it again.
  await pg.exec(SqlStore.schema("posts_store"))
})
after(async () => {
  await pg.close()
})

type Published = { text: string; person: string | null; later: LaterInfo | null; schedule: string | null; settings: unknown }
const published: Published[] = []
beforeEach(() => void (published.length = 0))

const WINDOW = 30

const post = defineEntity({ name: "post", label: "Post", schema: z.object({ id: z.string(), text: z.string().meta({ role: "title" }) }), get: () => null, list: () => ({ rows: [] }) })

function makeApp(store: IdempotencyStore) {
  const publish = defineAction({
    name: "publish",
    title: "Publish",
    input: z.object({ text: z.string().meta({ label: "Text" }), when: z.iso.datetime().meta({ label: "When" }) }),
    permission: "posts.publish",
    later: { at: "when", window: WINDOW },
    expose: { plain: true },
    run: (input, ctx) => {
      published.push({ text: input.text, person: ctx.person?.id ?? null, later: ctx.later, schedule: ctx.schedule, settings: ctx.settings.signature })
      ctx.notify({ title: `Published ${input.text}` })
      return { message: "Published." }
    },
  })
  const withdraw = defineAction({ name: "withdraw", title: "Withdraw", input: z.object({ id: z.string() }), confirm: false, run: async (input, ctx) => ({ message: String(await ctx.cancelLater(input.id)) }) })
  const app = defineApp({
    name: "posts",
    title: "Posts",
    version: "1.0.0",
    permissions: { "posts.publish": { label: "Publish posts" } },
    settings: { signature: { label: "Signature", type: "text", default: "—" } },
    entities: [post],
    actions: [publish, withdraw],
  })
  return serve(app, { auth: { signIn: devSignIn(app, { code: "LATER1" }) }, store })
}

const minutes = (n: number) => new Date(Date.now() + n * 60_000).toISOString()
const deadline = (at: string) => Math.floor(Date.parse(at) / 1000) + WINDOW * 60
const later = (r: ToolCallResult) => (r.structuredContent as { data: { later: { id: string; at: string; until: number } } }).data.later
const runs = (r: ToolCallResult) => (r.structuredContent as { runs: { id: string; tool: string; at: string; status: string; message: string }[] }).runs
const notes = (r: ToolCallResult) => ((r._meta as { clegra?: { notifications?: unknown[] } } | undefined)?.clegra?.notifications ?? []) as Record<string, unknown>[]
const code = (r: ToolCallResult) => (r.structuredContent as { error?: { code: string; message: string } }).error

const stores: [string, () => IdempotencyStore][] = [
  ["MemoryStore", () => new MemoryStore()],
  ["SqlStore (PGlite)", () => new SqlStore((text, params) => pg.query(text, params), { table: "posts_store" })],
]

for (const [name, store] of stores) {
  describe(`later runs, ${name}`, () => {
    test("confirmed now, kept, run once by clegra_later as its author, with ctx.later and the host's settings", async () => {
      const app = makeApp(store())
      const m = app.manifest()
      assert.deepEqual(m.actions.find((a) => a.name === "publish")!.later, { at: "when", window: WINDOW })
      assert.ok(m.schedules?.some((s) => s.name === "clegra_later" && s.tool === "clegra_later" && s.every === 5 && s.action === undefined))
      assert.ok(m.notifications?.some((n) => n.type === "clegra_later"))

      const person = await testClient(app, { permissions: "all", host: "workspace" })
      const when = minutes(-1)
      const r = await person.confirmed("publish", { text: "hello", when })
      assert.equal(r.isError, undefined, JSON.stringify(r))
      assert.equal((r.structuredContent as { message: string }).message, `Scheduled for ${when}.`)
      const kept = later(r)
      assert.deepEqual({ at: kept.at, until: kept.until }, { at: when, until: deadline(when) })
      assert.equal(published.length, 0, "nothing ran yet")

      const inst = await installationClient(app)
      assert.ok((await inst.listTools()).some((t) => t.name === "clegra_later"))
      const done = await inst.runLater({ signature: "The team" })
      assert.deepEqual(runs(done), [{ id: kept.id, tool: "publish", at: when, status: "done", message: "Published." }])
      assert.deepEqual(notes(done), [{ title: "Published hello", to: ["test-person"] }])
      assert.equal(published.length, 1)
      assert.equal(published[0]!.person, "test-person")
      assert.equal(published[0]!.schedule, "clegra_later")
      assert.equal(published[0]!.settings, "The team")
      assert.equal(published[0]!.later!.id, kept.id)
      assert.equal(published[0]!.later!.until, kept.until)
      assert.ok(Math.abs(published[0]!.later!.confirmedAt - Date.now() / 1000) < 60)
      assert.deepEqual(runs(await inst.runLater()), [], "a run runs once")
    })

    test("single use: two passes at the same moment run it once", async () => {
      const app = makeApp(store())
      const person = await testClient(app, { permissions: "all", host: "workspace" })
      await person.confirmed("publish", { text: "once", when: minutes(-1) })
      const [a, b] = await Promise.all([installationClient(app), installationClient(app)])
      const both = await Promise.all([a.runLater(), b.runLater(), a.runLater()])
      assert.equal(both.flatMap(runs).length, 1)
      assert.equal(published.length, 1)
    })

    test("a later run past its deadline expires, and its author is told", async () => {
      const app = makeApp(store())
      const person = await testClient(app, { permissions: "all", host: "workspace" })
      const when = minutes(0)
      await person.confirmed("publish", { text: "late", when })
      mock.timers.enable({ apis: ["Date"], now: Date.now() + (WINDOW + 5) * 60_000 })
      try {
        const r = await (await installationClient(app)).runLater()
        assert.equal(runs(r)[0]!.status, "expired")
        assert.deepEqual(notes(r), [{ type: "clegra_later", title: "«Publish» did not run", body: runs(r)[0]!.message, to: ["test-person"] }])
      } finally {
        mock.timers.reset()
      }
      assert.equal(published.length, 0)
    })

    test("the proof must carry the run's deadline; the time is checked before anyone is asked", async () => {
      const app = makeApp(store())
      const person = await testClient(app, { permissions: "all", host: "workspace" })
      const when = minutes(10)
      const wrong = await person.confirmed("publish", { text: "x", when }, randomUUID(), { until: deadline(when) + 60 })
      assert.equal(code(wrong)?.code, "confirmation_required")
      assert.match(code(wrong)!.message, /another deadline/)
      const unproven = await person.call("publish", { text: "x", when })
      assert.equal(code(unproven)?.code, "confirmation_required")
      assert.deepEqual((unproven.structuredContent as { error: { confirm: { later: unknown } } }).error.confirm.later, { at: when, until: deadline(when) })
      for (const at of [minutes(-10), minutes(400 * 24 * 60), "tomorrow"]) assert.equal(code(await person.confirmed("publish", { text: "x", when: at }))?.code, "invalid_input", at)
      // Idempotent on the call id, as any write.
      const call = randomUUID()
      const first = await person.confirmed("publish", { text: "y", when }, call)
      assert.equal(later(await person.confirmed("publish", { text: "y", when }, call)).id, later(first).id)
    })

    test("cancel: a pending run of the caller's tenant only", async () => {
      const app = makeApp(store())
      const person = await testClient(app, { permissions: "all", host: "workspace" })
      const { id } = later(await person.confirmed("publish", { text: "maybe", when: minutes(-1) }))
      const other = await testClient(app, { permissions: "all", host: "workspace", installation: "other" })
      assert.equal(((await other.call("withdraw", { id })).structuredContent as { message: string }).message, "false", "another tenant's run")
      assert.equal(((await person.call("withdraw", { id })).structuredContent as { message: string }).message, "true")
      assert.equal(((await person.call("withdraw", { id })).structuredContent as { message: string }).message, "false", "already cancelled")
      assert.deepEqual(runs(await (await installationClient(app)).runLater()), [])
    })

    test("a plain client's confirmation is kept without a proof and runs; app.runLater runs due runs too", async () => {
      const app = makeApp(store())
      const plain = await testClient(app, { permissions: "all" })
      // A plain client confirms with its own prompt (destructiveHint) or elicitation; no host proof exists.
      const r = await plain.call("publish", { text: "plain", when: minutes(-1) })
      assert.equal(r.isError, undefined, JSON.stringify(r))
      const report = await app.runLater("dev@clegra-dev", { settings: { signature: "S" } })
      assert.deepEqual(report.runs.map((x) => x.status), ["done"])
      assert.deepEqual(report.notifications, [{ title: "Published plain", to: ["test-person"] }])
      assert.equal(published[0]!.settings, "S")
    })
  })
}

describe("later runs: what is kept is checked again", () => {
  const sql = () => new SqlStore((text, params) => pg.query(text, params), { table: "posts_store" })
  const confirmOne = async (text: string) => {
    const app = makeApp(sql())
    const person = await testClient(app, { permissions: "all", host: "workspace" })
    const kept = later(await person.confirmed("publish", { text, when: minutes(-1) }))
    return { app, kept }
  }

  test("arguments changed in the store are refused, with or without their hash; the author is told", async () => {
    const { app, kept } = await confirmOne("original")
    const evil = { text: "evil", when: kept.at }
    await pg.query("UPDATE posts_store_later SET args = $2 WHERE id = $1", [kept.id, JSON.stringify(evil)])
    const r = await (await installationClient(app)).runLater()
    assert.deepEqual(runs(r).map((x) => [x.status, x.message]), [["refused", "its arguments are not the ones confirmed"]])
    assert.equal(notes(r)[0]!.type, "clegra_later")

    const second = await confirmOne("original")
    const evil2 = { text: "evil", when: second.kept.at }
    await pg.query("UPDATE posts_store_later SET args = $2, args_hash = $3 WHERE id = $1", [second.kept.id, JSON.stringify(evil2), await argsHash(evil2)])
    const r2 = await (await installationClient(second.app)).runLater()
    assert.deepEqual(runs(r2).map((x) => [x.status, x.message]), [["refused", "the proof is for other arguments"]])
    assert.equal(published.length, 0)
  })

  test("a deadline or a time changed in the store is refused", async () => {
    const { app, kept } = await confirmOne("deadline")
    await pg.query("UPDATE posts_store_later SET until = until + 86400 WHERE id = $1", [kept.id])
    assert.deepEqual(runs(await (await installationClient(app)).runLater()).map((x) => x.message), ["the proof is for another deadline"])
    const second = await confirmOne("early")
    await pg.query("UPDATE posts_store_later SET at = $2 WHERE id = $1", [second.kept.id, minutes(-2)])
    assert.deepEqual(runs(await (await installationClient(second.app)).runLater()).map((x) => x.message), ["its time is not the one confirmed"])
    assert.equal(published.length, 0)
  })

  test("deleting the tenant's data deletes its later runs too", async () => {
    const store = sql()
    const publish = defineAction({ name: "publish", title: "Publish", input: z.object({ when: z.iso.datetime() }), later: { at: "when" }, run: () => {} })
    const defined = defineApp({ name: "posts2", title: "Posts", version: "1", entities: [post], actions: [publish], lifecycle: { delete: () => ({ counts: { posts: 0 } }) } })
    const app = serve(defined, { auth: { signIn: devSignIn(defined, { code: "LATER1" }) }, store })
    assert.equal(app.manifest().actions[0]!.later!.window, 60, "the default window")
    await (await testClient(app, { host: "workspace", installation: "deleting" })).confirmed("publish", { when: minutes(30) })
    const inst = await installationClient(app, { installation: "deleting" })
    assert.deepEqual((await inst.call("clegra_delete")).structuredContent, { deleted: true, counts: { posts: 0, later_runs: 1 } })
    assert.deepEqual((await inst.call("clegra_delete")).structuredContent, { deleted: true, counts: { posts: 0 } })
  })

  test("a later action needs a store with a later part", () => {
    const bare: IdempotencyStore = { begin: async () => null, finish: async () => {}, abandon: async () => {}, once: async () => true, put: async () => {}, get: async () => null, hit: async () => 1 }
    assert.throws(() => makeApp(bare), /action "publish": later keeps the confirmed call in the store, and this store has no later part/)
  })
})
