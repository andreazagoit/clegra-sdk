import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, describe, test } from "node:test"

import { z } from "zod"

import { defineApp, ref, type AuthOptions } from "./index"
import { testClient } from "./testing"
import { viewHtml } from "./view"

/**
 * Sorting, references and forms (spec §4, §5): what a list may be sorted by,
 * how a referenced record reaches a model and a form, and what an invalid
 * input says.
 */

const keyFile = join(tmpdir(), `modelapp-test-key-${randomUUID()}.json`)
after(() => rmSync(keyFile, { force: true }))

type Task = { id: string; title: string; project: string; cost: number; due: string }
const projects = [
  { id: "p1", name: "Alpha" },
  { id: "p2", name: "Beta" },
]
const tasks: Task[] = [
  { id: "t1", title: "Write", project: "p2", cost: 30, due: "2026-12-01" },
  { id: "t2", title: "Review", project: "p1", cost: 10, due: "2026-11-20" },
]

function makeApp() {
  return defineApp({
    name: "tasks",
    title: "Tasks",
    version: "1.0.0",
    locale: "en",
    auth: { dev: { keyFile, code: "TEST1" } } as AuthOptions,
    permissions: { "tasks.costs": { label: "See costs" } },
    entities: {
      project: {
        label: "Project",
        // A project's name is typed in by outsiders.
        schema: z.object({ id: z.string(), name: z.string().meta({ role: "title", label: { en: "Name", it: "Nome" }, search: true, untrusted: true }) }),
        get: (id) => projects.find((p) => p.id === id) ?? null,
        list: (q) => ({ rows: projects.filter((p) => !q.text || p.name.toLowerCase().includes(q.text.toLowerCase())) }),
      },
      task: {
        label: "Task",
        schema: z.object({
          id: z.string(),
          title: z.string().meta({ role: "title", label: "Title", sort: true }),
          project: ref("project").meta({ label: "Project" }),
          cost: z.number().meta({ role: "amount", currency: "EUR", label: "Cost", sort: true, permission: "tasks.costs" }),
          due: z.string().meta({ role: "date", label: "Due", sort: true }),
        }),
        get: (id) => tasks.find((t) => t.id === id) ?? null,
        list: (q) => {
          const rows = [...tasks]
          if (q.sort) rows.sort((a, b) => (String(a[q.sort!.field as keyof Task]) < String(b[q.sort!.field as keyof Task]) ? -1 : 1) * (q.sort!.dir === "desc" ? -1 : 1))
          return { rows }
        },
      },
    },
    actions: {
      create: {
        title: { en: "New task", it: "Nuova attività" },
        input: z.object({
          title: z.string().min(2).meta({ label: { en: "Title", it: "Titolo" } }),
          project: ref("project").meta({ label: { en: "Project", it: "Progetto" } }),
          cost: z.number().min(0).optional().meta({ label: { en: "Cost", it: "Costo" }, currency: "EUR" }),
          due: z.iso.date().meta({ label: { en: "Due", it: "Scadenza" } }),
          kind: z.enum(["bug", "idea"]).optional().meta({ label: "Kind", labels: { bug: { en: "Bug", it: "Difetto" }, idea: "Idea" } }),
        }),
        expose: { plain: true },
        run: (input) => ({ message: `Created ${input.title}` }),
      },
    },
    fragments: { board: { title: "Board", description: "The board", params: z.object({}), template: "stat", actions: ["create"], data: () => ({ label: "tasks", value: tasks.length }) } },
    pages: {
      tasks: { list: "task", title: "Tasks", columns: ["title", "project", "cost", "due"] },
      urgent: { list: "task", title: "Urgent", columns: ["title", "due"], params: z.object({ days: z.number().optional() }), query: () => ({ sort: { field: "due", dir: "asc" as const } }) },
    },
  })
}

type ListView = { columns: { name: string; sort?: boolean }[]; sort?: { field: string; dir: string } }

describe("sorting", () => {
  test("a list is sorted by a field declared sortable; the view knows which columns sort and how it is sorted now", async () => {
    const c = await testClient(makeApp(), { permissions: "all" })
    const r = await c.call("open_tasks", { sort: "due", dir: "desc" })
    const s = r.structuredContent as { rows: Task[]; view: ListView }
    assert.deepEqual(s.rows.map((t) => t.id), ["t1", "t2"])
    assert.deepEqual(s.view.sort, { field: "due", dir: "desc" })
    assert.deepEqual(s.view.columns.filter((col) => col.sort).map((col) => col.name), ["title", "cost", "due"])
    const asc = (await c.call("task_list", { sort: "title" })).structuredContent as { rows: Task[]; view: ListView }
    assert.deepEqual(asc.rows.map((t) => t.id), ["t2", "t1"])
    assert.deepEqual(asc.view.sort, { field: "title", dir: "asc" })
  })

  test("a field that is not sortable, or that the caller may not see, is refused: nothing is ordered by a hidden value", async () => {
    const c = await testClient(makeApp(), { permissions: [] })
    const tools = await c.listTools()
    const sortable = ((tools.find((t) => t.name === "task_list")!.inputSchema.properties as Record<string, { enum?: string[] }>).sort!.enum ?? []).sort()
    assert.deepEqual(sortable, ["due", "title"], "a hidden field is not offered")
    for (const tool of ["task_list", "open_tasks"]) {
      const hidden = await c.call(tool, { sort: "cost" })
      assert.ok(hidden.isError, `${tool}: sort by a hidden field`)
    }
    assert.ok((await c.call("task_list", { sort: "project" })).isError, "not declared sortable")
    const view = ((await c.call("open_tasks", {})).structuredContent as { view: ListView }).view
    assert.ok(!view.columns.some((col) => col.name === "cost"))
  })

  test("a page with parameters of its own keeps its order: its columns don't sort from outside", async () => {
    const c = await testClient(makeApp(), { permissions: "all" })
    const s = (await c.call("open_urgent", {})).structuredContent as { rows: Task[]; view: ListView }
    assert.deepEqual(s.rows.map((t) => t.id), ["t2", "t1"])
    assert.ok(!s.view.columns.some((col) => col.sort) && !s.view.sort)
  })

  test("the manifest says which fields sort", () => {
    const fields = makeApp().manifest().entities.find((e) => e.name === "task")!.fields
    assert.deepEqual(fields.filter((f) => f.sort).map((f) => f.name), ["title", "cost", "due"])
  })
})

describe("references", () => {
  test("a model reads a referenced record as { id, title }, never a bare id; an outsider's title is wrapped and pointed to", async () => {
    const c = await testClient(makeApp(), { permissions: "all" })
    const list = await c.call("task_list", {})
    const rows = (JSON.parse(list.content![0]!.text!) as { rows: { project: unknown }[] }).rows
    assert.deepEqual(rows[0]!.project, { id: "p2", title: "<untrusted>Beta</untrusted>" })
    assert.deepEqual((list.structuredContent as { rows: Task[]; refs: unknown }).rows[0]!.project, "p2", "the structured rows keep the id, with the titles beside")
    assert.deepEqual((list.structuredContent as { refs: unknown }).refs, { project: { p2: "Beta", p1: "Alpha" } })
    assert.ok((list._meta?.modelapp as { untrusted: string[] }).untrusted.includes("/refs/project/p2"))
    const one = JSON.parse((await c.call("task_get", { id: "t2" })).content![0]!.text!) as { project: unknown }
    assert.deepEqual(one.project, { id: "p1", title: "<untrusted>Alpha</untrusted>" })
    const page = JSON.parse((await c.call("open_tasks", {})).content![0]!.text!) as { rows: { project: unknown }[] }
    assert.deepEqual(page.rows[1]!.project, { id: "p1", title: "<untrusted>Alpha</untrusted>" })
    const fetched = JSON.parse((await c.call("fetch", { id: "modelapp://tasks/task/t1" })).content![0]!.text!) as { text: string }
    assert.deepEqual((JSON.parse(fetched.text) as { project: unknown }).project, { id: "p2", title: "<untrusted>Beta</untrusted>" })
  })

  test("a form's reference input is a picker: the entity's list tool, the field that names a record, whether it searches", async () => {
    const c = await testClient(makeApp(), { permissions: "all", locale: "it" })
    const board = (await c.call("show_board", {})).structuredContent as { actions: { tool: string; input: { required: string[]; properties: Record<string, Record<string, unknown>> } }[] }
    const input = board.actions[0]!.input
    assert.deepEqual(input.properties.project!.ref, { entity: "project", tool: "project_list", title: "name", search: true })
    assert.equal(input.properties.project!.title, "Progetto")
    assert.equal(input.properties.cost!.currency, "EUR")
    assert.deepEqual(input.properties.kind!.labels, { bug: "Difetto", idea: "Idea" })
    assert.deepEqual(input.required, ["title", "project", "due"])
    // What a workspace host draws its own form and confirmation from.
    const declared = makeApp().manifest().actions.find((a) => a.name === "create")!.input as { properties: Record<string, Record<string, unknown>> }
    assert.equal(declared.properties.project!.ref, "project")
    assert.equal(declared.properties.cost!.currency, "EUR")
    assert.deepEqual(declared.properties.kind!.labels, { bug: { en: "Bug", it: "Difetto" }, idea: { en: "Idea" } })
    // A plain MCP client's tool schema stays plain JSON Schema.
    const tool = (await c.listTools()).find((t) => t.name === "create")!
    assert.ok(!("ref" in (tool.inputSchema.properties as Record<string, object>).project!) && !("currency" in (tool.inputSchema.properties as Record<string, object>).cost!))
  })
})

describe("forms", () => {
  test("an invalid input is said field by field, in the caller's language, as a tool error", async () => {
    const it = await testClient(makeApp(), { permissions: "all", locale: "it" })
    const bad = await it.call("create", { title: "x", project: "p1", cost: -1, due: "soon" })
    assert.ok(bad.isError)
    const error = (bad.structuredContent as { error: { code: string; message: string; fields: Record<string, string> } }).error
    assert.equal(error.code, "invalid_input")
    assert.deepEqual(Object.keys(error.fields).sort(), ["cost", "due", "title"])
    assert.match(error.message, /^Titolo: .+; Costo: .+; Scadenza: /)
    const en = await testClient(makeApp(), { permissions: "all" })
    const english = ((await en.call("create", { project: "p1", due: "2026-12-01" })).structuredContent as { error: { fields: Record<string, string> } }).error.fields
    assert.notEqual(english.title, undefined)
    assert.notEqual(english.title, ((await it.call("create", { project: "p1", due: "2026-12-01" })).structuredContent as { error: { fields: Record<string, string> } }).error.fields.title)
    const ok = await en.call("create", { title: "Plan", project: "p1", due: "2026-12-01" })
    assert.ok(!ok.isError, JSON.stringify(ok))
  })

  test("the generated view marks required fields, checks each field before sending, shows the app's per-field errors, picks references and sorts columns", () => {
    const html = viewHtml("Tasks")
    for (const needle of ['class="req"', "aria-required", "data-err", "error.fields", "data-ref-search", "p.ref.tool", "aria-sort", "th.sort", "Obbligatorio", "Required"]) assert.ok(html.includes(needle), needle)
    // The form stays until the call succeeds (it used to be removed before the answer came).
    assert.ok(!html.includes("f.remove(); run(args)"))
    const script = html.slice(html.indexOf("<script>") + 8, html.lastIndexOf("</script>"))
    assert.doesNotThrow(() => new Function(script), "the view's script parses")
  })
})
