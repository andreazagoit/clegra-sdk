import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { beforeEach, describe, test } from "node:test"

import { z } from "zod"

import { defineAction, defineAgent, defineApp, defineArtifact, defineEntity, definePage, manifestSchema, serve, type App } from "./index"
import { devSignIn } from "./signin"
import { installationClient, testClient } from "./testing"

/**
 * What an app tells a workspace host beyond its records: its navigation, page actions and badges, app-only items,
 * schedules run as the installation, typed notifications, and the lifecycle tools.
 */

type Task = { id: string; title: string; project: string; done: boolean }
const tasks = new Map<string, Task[]>()
const audits = new Map<string, { id: string; what: string }[]>()
const states: string[] = []
const tasksOf = (tenant: string) => {
  if (!tasks.has(tenant)) tasks.set(tenant, [{ id: "t1", title: "Write the spec", project: "p1", done: false }])
  return tasks.get(tenant)!
}
beforeEach(() => {
  tasks.clear()
  audits.clear()
  states.length = 0
})

const served = (app: App) => serve(app, { auth: { signIn: devSignIn(app, { code: "INST1" }) } })

function makeDefinition(options: { notify?: Record<string, unknown> } = {}) {
  const task = defineEntity({
    name: "task",
    label: "Task",
    schema: z.object({ id: z.string(), title: z.string().meta({ role: "title", label: "Title", search: true }), project: z.string().meta({ label: "Project", filter: true }), done: z.boolean().meta({ label: "Done" }) }),
    get: (id, ctx) => tasksOf(ctx.installation).find((t) => t.id === id) ?? null,
    list: (q, ctx) => ({ rows: tasksOf(ctx.installation).filter((t) => !q.text || t.title.toLowerCase().includes(q.text.toLowerCase())) }),
  })
  const audit = defineEntity({
    name: "audit",
    label: "Audit entry",
    visibility: "app",
    schema: z.object({ id: z.string(), what: z.string().meta({ role: "title", label: "What", search: true }) }),
    get: (id, ctx) => (audits.get(ctx.installation) ?? []).find((a) => a.id === id) ?? null,
    list: (_q, ctx) => ({ rows: audits.get(ctx.installation) ?? [{ id: "a1", what: "Write the spec opened" }] }),
  })
  const add = defineAction({
    name: "add",
    title: "Add task",
    input: z.object({ title: z.string().meta({ label: "Title" }), project: z.string().optional().meta({ label: "Project" }) }),
    confirm: false,
    permission: "tasks.edit",
    run: (input, ctx) => {
      tasksOf(ctx.installation).push({ id: `t${tasksOf(ctx.installation).length + 1}`, title: input.title, project: input.project ?? "", done: false })
      return { message: "Added." }
    },
  })
  const digest = defineAction({
    name: "digest",
    title: "Send the digest",
    input: z.object({}),
    readOnly: true,
    run: (_input, ctx) => {
      ctx.notify((options.notify as never) ?? { type: "digest", title: "Your digest", to: "admins" })
      return { message: `schedule ${ctx.schedule ?? "none"}, person ${ctx.person?.id ?? "none"}` }
    },
  })
  const touch = defineAction({ name: "touch", title: "Touch", input: z.object({}), readOnly: true, visibility: "app", run: () => ({ message: "touched" }) })
  const openCount = defineArtifact({ name: "open_count", title: "Open tasks", description: "How many tasks are open", params: z.object({}), template: "stat", data: (_p, ctx) => ({ label: "open", value: tasksOf(ctx.installation).filter((t) => !t.done).length }) })
  const secret = defineArtifact({ name: "secret", title: "Secret", description: "For the view only", params: z.object({}), template: "stat", visibility: "app", data: () => ({ label: "s", value: 1 }) })
  const list = definePage({ name: "list", title: "Tasks", list: task, columns: ["title", "project"], actions: [add, digest], badge: openCount })
  const board = definePage({ name: "board", title: "Board", dashboard: [{ artifact: openCount, params: {} }] })
  const hidden = definePage({ name: "hidden", title: "Hidden", dashboard: [], permission: "tasks.admin" })
  return defineApp({
    name: "tasks",
    title: "Tasks",
    version: "1.0.0",
    permissions: { "tasks.edit": { label: "Edit tasks" }, "tasks.admin": { label: "Manage tasks" } },
    entities: [task, audit],
    actions: [add, digest, touch],
    artifacts: [openCount, secret],
    pages: [list, board, hidden],
    nav: [{ section: { en: "Work", it: "Lavoro" }, pages: [list, board] }, { pages: [hidden] }],
    schedules: [{ name: "daily_digest", action: digest, every: 60 }],
    notifications: { digest: { label: "Digest", permission: "tasks.edit" }, quiet: { label: "Quiet", default: false } },
    agents: [defineAgent({ name: "helper", title: "Helper", description: "Helps", instructions: "Help.", uses: [task, add] })],
    lifecycle: {
      installation: (state, ctx) => void states.push(`${ctx.installation}:${state}:${ctx.person === null}`),
      export: (ctx) => (tasks.has(ctx.installation) ? { contentType: "application/json", body: JSON.stringify(tasksOf(ctx.installation)) } : null),
      delete: (ctx) => {
        const n = tasks.get(ctx.installation)?.length ?? 0
        tasks.delete(ctx.installation)
        return { counts: { tasks: n } }
      },
    },
  })
}

const makeApp = (options: { notify?: Record<string, unknown> } = {}) => served(makeDefinition(options))

describe("manifest", () => {
  test("carries the navigation, page actions and badges, visibility, schedules, notification types and lifecycle", () => {
    const m = makeDefinition().manifest()
    manifestSchema.parse(m)
    assert.deepEqual(m.nav, [{ section: { en: "Work", it: "Lavoro" }, pages: ["list", "board"] }, { pages: ["hidden"] }])
    const list = m.pages.find((p) => p.name === "list")!
    assert.deepEqual(list.actions, ["add", "digest"])
    assert.equal(list.badge, "open_count")
    assert.equal(m.entities.find((e) => e.name === "audit")!.visibility, "app")
    assert.equal(m.entities.find((e) => e.name === "task")!.visibility, undefined)
    assert.equal(m.actions.find((a) => a.name === "touch")!.visibility, "app")
    assert.equal(m.artifacts.find((f) => f.type === "secret")!.visibility, "app")
    assert.deepEqual(m.schedules, [{ name: "daily_digest", action: "digest", tool: "digest", every: 60, maxSeconds: 60 }])
    assert.deepEqual(m.notifications, [
      { type: "digest", label: { en: "Digest" }, default: true, permission: "tasks.edit" },
      { type: "quiet", label: { en: "Quiet" }, default: false },
    ])
    assert.deepEqual(m.lifecycle, { installation: "clegra_installation", export: "clegra_export", delete: "clegra_delete" })
  })
})

describe("visibility: app", () => {
  test("app-only tools carry visibility [\"app\"] only; search and fetch leave app-only records out", async () => {
    const c = await testClient(makeApp(), { permissions: "all", host: "workspace" })
    const tools = await c.listTools()
    const vis = (n: string) => (tools.find((t) => t.name === n)?._meta as { ui?: { visibility?: string[] }; "openai/visibility"?: string; "openai/widgetAccessible"?: boolean } | undefined)
    for (const n of ["audit_list", "audit_get", "touch", "show_secret"]) {
      assert.deepEqual(vis(n)?.ui?.visibility, ["app"], n)
      assert.equal(vis(n)?.["openai/visibility"], "private", n)
      assert.equal(vis(n)?.["openai/widgetAccessible"], true, n)
    }
    for (const n of ["task_list", "task_get", "add", "show_open_count"]) assert.deepEqual(vis(n)?.ui?.visibility, ["model", "app"], n)
    // A view still calls them.
    assert.equal(((await c.call("touch")).structuredContent as { message: string }).message, "touched")
    assert.equal(((await c.call("audit_list")).structuredContent as { rows: unknown[] }).rows.length, 1)
    const found = (await c.call("search", { query: "spec" })).structuredContent as { results: { id: string }[] }
    assert.deepEqual(found.results.map((r) => r.id), ["clegra://tasks/task/t1"], "the app-only audit entry is not found")
    const fetched = await c.call("fetch", { id: "clegra://tasks/audit/a1" })
    assert.equal(fetched.isError, true)
  })
})

describe("pages", () => {
  test("a page's view carries its actions (prefilled from its params) and the navigation the caller may use", async () => {
    const c = await testClient(makeApp(), { permissions: ["tasks.edit"], host: "workspace" })
    const r = await c.call("open_list", { project: "p1" })
    const view = (r.structuredContent as { view: Record<string, unknown> }).view
    assert.equal(view.page, "list")
    const actions = view.actions as { tool: string; title: string; confirm: string; input: { properties: Record<string, unknown> }; prefill?: Record<string, unknown> }[]
    assert.deepEqual(actions.map((a) => a.tool), ["add", "digest"])
    assert.deepEqual(actions[0]!.prefill, { project: "p1" })
    assert.equal(actions[1]!.prefill, undefined)
    assert.ok(actions[0]!.input.properties.title)
    // «hidden» needs tasks.admin: not in this caller's navigation.
    assert.deepEqual(view.nav, [{ section: "Work", pages: [{ name: "list", title: "Tasks", tool: "open_list", badge: "show_open_count" }, { name: "board", title: "Board", tool: "open_board" }] }])
    const dash = (await c.call("open_board")).structuredContent as { view: { nav?: unknown; actions?: unknown; tool: string } }
    assert.ok(dash.view.nav)
    assert.equal(dash.view.actions, undefined)
    assert.equal(dash.view.tool, "open_board")
    // A caller who may not add sees only the actions it may use.
    const reader = await testClient(makeApp(), { permissions: [], host: "workspace" })
    assert.deepEqual(((await reader.call("open_list")).structuredContent as { view: { actions: { tool: string }[] } }).view.actions.map((a) => a.tool), ["digest"])
  })
})

describe("schedules", () => {
  test("the installation runs a schedule's action: no person, ctx.schedule set, notifications say whom", async () => {
    const inst = await installationClient(makeApp())
    const r = await inst.schedule("daily_digest")
    assert.equal(r.isError, undefined)
    assert.equal((r.structuredContent as { message: string }).message, "schedule daily_digest, person none")
    assert.deepEqual((r._meta as { clegra: { notifications: unknown[] } }).clegra.notifications, [{ type: "digest", title: "Your digest", to: "admins" }])
  })

  test("a schedule meta is refused with a person, for another tool, or naming no schedule", async () => {
    const app = makeApp()
    const person = await testClient(app, { permissions: "all", host: "workspace" })
    const refused = (r: { isError?: boolean; structuredContent?: Record<string, unknown> }) => r.isError === true && (r.structuredContent as { error: { code: string } }).error.code === "permission_denied"
    assert.ok(refused(await person.call("digest", {}, { clegra: { schedule: "daily_digest" } })), "with a person")
    const inst = await installationClient(app)
    assert.ok(refused(await inst.call("touch", {}, { clegra: { schedule: "daily_digest" } })), "another tool")
    assert.ok(refused(await inst.call("digest", {}, { clegra: { schedule: "nightly" } })), "no such schedule")
    const plain = await testClient(app, { permissions: "all" })
    assert.ok(refused(await plain.call("digest", {}, { clegra: { schedule: "daily_digest" } })), "a plain client")
    // Without the meta, a person-less call is an ordinary call (its token's permissions): ctx.schedule is null.
    assert.match(((await inst.call("digest")).structuredContent as { message: string }).message, /^schedule none/)
  })
})

describe("notifications", () => {
  const failed = (r: { isError?: boolean; structuredContent?: Record<string, unknown> }) => r.isError === true && (r.structuredContent as { error: { code: string } }).error.code === "internal"
  test("an undeclared type, a missing type, a permission as recipients (Clegra keeps none), or no recipients without a person: a programming error", async () => {
    for (const notify of [{ type: "nope", title: "x", to: ["p1"] }, { title: "x", to: ["p1"] }, { type: "digest", title: "x", to: { permission: "tasks.edit" } }, { type: "digest", title: "x" }]) {
      const inst = await installationClient(makeApp({ notify }))
      assert.ok(failed(await inst.schedule("daily_digest")), JSON.stringify(notify))
    }
  })

  test("an app without types sends untyped notifications only; a person is the default recipient", async () => {
    const make = (type?: string) => {
      const n = defineEntity({ name: "n", label: "N", schema: z.object({ id: z.string(), t: z.string().meta({ role: "title" }) }), get: () => null, list: () => ({ rows: [] }) })
      const ping = defineAction({ name: "ping", title: "Ping", input: z.object({}), readOnly: true, run: (_i, ctx) => void ctx.notify({ ...(type ? { type } : {}), title: { en: "Pinged", it: "Ping" }, body: "b" }) })
      return served(defineApp({ name: "plainnotes", title: "N", version: "1", entities: [n], actions: [ping] }))
    }
    const c = await testClient(make(), { person: "test-person", host: "workspace" })
    assert.deepEqual(((await c.call("ping"))._meta as { clegra: { notifications: unknown[] } }).clegra.notifications, [{ title: "Pinged", body: "b", to: ["test-person"] }])
    assert.ok(failed(await (await testClient(make("x"), { host: "workspace" })).call("ping")))
  })
})

describe("lifecycle", () => {
  test("the lifecycle tools are listed only to the installation itself", async () => {
    const app = makeApp()
    const reserved = ["clegra_installation", "clegra_export", "clegra_delete", "clegra_later"]
    for (const c of [await testClient(app, { permissions: "all" }), await testClient(app, { permissions: "all", host: "workspace" }), await testClient(app, { person: null, permissions: "all" })]) {
      const names = (await c.listTools()).map((t) => t.name)
      assert.deepEqual(names.filter((n) => reserved.includes(n)), [])
      assert.equal((await c.call("clegra_export")).isError, true, "not callable either")
    }
    const tools = await (await installationClient(app)).listTools()
    for (const n of ["clegra_installation", "clegra_export", "clegra_delete"]) {
      const t = tools.find((x) => x.name === n)
      assert.ok(t, n)
      assert.deepEqual((t!._meta as { ui: { visibility: string[] } }).ui.visibility, ["app"])
    }
    assert.ok(!tools.some((t) => t.name === "clegra_later"), "no action has later")
  })

  test("installation state, export as one embedded file, delete (idempotent)", async () => {
    const inst = await installationClient(makeApp())
    const told = await inst.call("clegra_installation", { state: "disabled" })
    assert.deepEqual(told.structuredContent, { ok: true })
    assert.deepEqual(states, ["dev@clegra-dev:disabled:true"])
    assert.equal((await inst.call("clegra_installation", { state: "paused" })).isError, true)

    assert.deepEqual((await inst.exportData()).result.structuredContent, { empty: true }, "nothing kept yet")
    tasksOf("dev@clegra-dev")
    const { result, file } = await inst.exportData()
    const body = JSON.stringify(tasksOf("dev@clegra-dev"))
    assert.deepEqual(result.structuredContent, { name: "tasks-export.json", contentType: "application/json", bytes: Buffer.byteLength(body), sha256: createHash("sha256").update(body).digest("hex") })
    assert.equal(new TextDecoder().decode(file!.body), body)
    const resource = result.content!.find((c) => c.type === "resource")!.resource!
    assert.equal(resource.uri, "clegra://tasks/export/tasks-export.json")
    assert.equal(resource.mimeType, "application/json")

    assert.deepEqual((await inst.call("clegra_delete")).structuredContent, { deleted: true, counts: { tasks: 1 } })
    assert.deepEqual((await inst.call("clegra_delete")).structuredContent, { deleted: true, counts: { tasks: 0 } })
    assert.deepEqual((await inst.exportData()).result.structuredContent, { empty: true })
  })
})
