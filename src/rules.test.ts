import assert from "node:assert/strict"
import { test } from "node:test"

import { z } from "zod"

import { APP_ACCENTS, DEFAULT_APP_ACCENT, defineAction, defineAgent, defineApp, defineArtifact, defineEntity, definePage, manifestSchema, type Action, type Page } from "./index"

/** Every rule of spec/src/rules.ts fails at definition time, naming the place (the conformance checks run the same rules). */

const task = defineEntity({ name: "task", label: "Task", schema: z.object({ id: z.string(), title: z.string().meta({ role: "title" }) }), get: () => null, list: () => ({ rows: [] }) })
const add = defineAction({ name: "add", title: "Add", input: z.object({ title: z.string(), when: z.iso.datetime(), note: z.string().optional() }), confirm: false, run: () => {} })
const close = defineAction({ name: "close", on: task, title: "Close", input: z.object({}), run: () => {} })
const read = defineAction({ name: "read", title: "Read", input: z.object({}), readOnly: true, run: () => {} })
const remove = defineAction({ name: "remove", title: "Remove", input: z.object({}), run: () => {} })
const hide = defineAction({ name: "hide", title: "Hide", input: z.object({}), readOnly: true, visibility: "app", run: () => {} })
const actions: Action[] = [add, close, read, remove, hide]
const count = defineArtifact({ name: "count", title: "Count", description: "Count", params: z.object({}), template: "stat", data: () => ({ label: "n", value: 1 }) })
const perProject = defineArtifact({ name: "per_project", title: "Per project", description: "Per project", params: z.object({ project: z.string() }), template: "stat", data: () => ({ label: "n", value: 1 }) })
const items = defineArtifact({ name: "items", title: "Items", description: "Items", params: z.object({}), template: "list", data: () => ({ items: [] }) })
const artifacts = [count, perProject, items]

// Loosely typed on purpose: these definitions are wrong, and the point is the error each one gets at run time.
const make = (extra: Record<string, unknown>) => () => defineApp({ name: "rules", title: "Rules", version: "1", entities: [task], actions, artifacts, ...extra } as never)
const listPage = (more: Record<string, unknown> = {}) => definePage({ name: "list", title: "Tasks", list: task, columns: ["title"], ...more } as never)
const board = definePage({ name: "board", title: "Board", dashboard: [] })
const taskPage = (more: Record<string, unknown> = {}) => definePage({ name: "task", record: task, ...more } as never)
const list = listPage()
const record = taskPage()
const pages: Page[] = [list, board, record]
const withList = (more: Record<string, unknown>) => [listPage(more), board, record]
/** An action changed (same name), in place of the original. */
const swap = (original: Action, more: Record<string, unknown>) => {
  const changed = defineAction({ ...original.definition, ...more } as never)
  return { actions: actions.map((a) => (a === original ? changed : a)) }
}

test("a valid definition with every new key holds", () => {
  const withActions = listPage({ actions: [add, read], badge: count })
  const app = make({
    pages: [withActions, board, record],
    nav: [{ section: "Work", pages: [withActions] }, { pages: [board] }],
    schedules: [
      { name: "nightly", action: read, every: 1440, maxSeconds: 300 },
      { name: "cleanup", action: read, every: 5 },
    ],
    notifications: { done: { label: "Done" } },
  })()
  assert.equal(app.manifest().schedules!.length, 2)
})

test("accent: one name of the palette, in the manifest as declared; absent is none (hosts use blue); a colour is refused", () => {
  assert.equal(make({ pages, accent: "red" })().manifest().accent, "red")
  assert.equal(make({ pages })().manifest().accent, undefined)
  assert.equal(DEFAULT_APP_ACCENT, "blue")
  for (const name of APP_ACCENTS) assert.equal(make({ pages, accent: name })().manifest().accent, name)
  assert.throws(make({ pages, accent: "#FF0000" }), /accent: "#FF0000" is not one of blue, indigo, purple, pink, red, orange, yellow, green, teal, gray/)
  assert.throws(make({ pages, accent: "Red" }), /accent: "Red" is not one of/)
  const schema = manifestSchema.safeParse({ ...make({ pages })().manifest(), accent: "rose" })
  assert.equal(schema.success, false)
})

test("publisher: a name and an https address, in the manifest as declared; it grants nothing", () => {
  const publisher = { name: "Example Software Ltd", url: "https://example.com" }
  assert.deepEqual(make({ pages, publisher })().manifest().publisher, publisher)
  assert.equal(make({ pages })().manifest().publisher, undefined)
  assert.throws(make({ pages, publisher: { name: "Example", url: "http://example.com" } }), /publisher: url "http:\/\/example.com" is not an absolute https address/)
  assert.throws(make({ pages, publisher: { name: "Example", url: "example.com" } }), /publisher: url "example.com" is not an absolute https address/)
  assert.throws(make({ pages, publisher: { name: "Example", url: "https://me:pw@example.com" } }), /publisher: url carries credentials/)
  assert.throws(make({ pages, publisher: { name: " Example", url: "https://example.com" } }), /publisher: the name is empty or has spaces around it/)
  assert.throws(make({ pages, publisher: { name: "", url: "https://example.com" } }), /publisher: the name is empty/)
  assert.throws(make({ pages, publisher: { name: "Ex\u0007ample", url: "https://example.com" } }), /publisher: the name has control characters/)
  assert.throws(make({ pages, publisher: { name: "x".repeat(101), url: "https://example.com" } }), /publisher: the name is longer than 100 characters/)
})

test("nav: pages that exist, no record page, each once, no empty section", () => {
  assert.throws(make({ pages, nav: [{ pages: [definePage({ name: "nope", title: "Nope", dashboard: [] })] }] }), /nav: page "nope" is not one of defineApp's pages/)
  assert.throws(make({ pages, nav: [{ pages: [record] }] }), /nav section 1: "task" is a record page/)
  assert.throws(make({ pages, nav: [{ pages: [list] }, { pages: [list] }] }), /nav section 2: page "list" is in the navigation twice/)
  assert.throws(make({ pages, nav: [{ pages: [] }] }), /nav section 1: no pages/)
})

test("page actions: global, declared, at most 8, not on record pages", () => {
  const nope = defineAction({ name: "nope", title: "Nope", input: z.object({}), run: () => {} })
  assert.throws(make({ pages: withList({ actions: [nope] }) }), /page "list": action "nope" is not one of defineApp's actions/)
  assert.throws(make({ pages: withList({ actions: [close] }) }), /page "list": "close" works on one task: a page offers global actions/)
  assert.throws(make({ pages: withList({ actions: Array(9).fill(add) }) }), /page "list": at most 8 actions/)
  assert.throws(make({ pages: [list, board, taskPage({ actions: [add] })] }), /page "task": a record page has no page actions/)
})

test("page badge: a stat artifact without required params, not on record pages", () => {
  assert.throws(make({ pages: withList({ badge: items }) }), /page "list": badge "items" is not a stat artifact/)
  assert.throws(make({ pages: withList({ badge: perProject }) }), /page "list": badge "per_project" has required params \(project\)/)
  const stray = defineArtifact({ name: "nope", title: "Nope", description: "Nope", params: z.object({}), template: "stat", data: () => null })
  assert.throws(make({ pages: withList({ badge: stray }) }), /page "list": artifact "nope" is not one of defineApp's artifacts/)
  assert.throws(make({ pages: [list, board, taskPage({ badge: count })] }), /page "task": a record page has no badge/)
})

test("an agent may not use an app-only item", () => {
  assert.throws(make({ agents: [defineAgent({ name: "helper", title: "H", description: "h", instructions: "h", uses: [hide] })] }), /agent "helper": hide is the tool of action "hide", which is app-only/)
})

test("schedules: a global action called with {}, never a write the person confirms; bounds", () => {
  assert.throws(make({ schedules: [{ name: "s", action: remove, every: 60 }] }), /schedule "s": "remove" is a write the person confirms \(confirm "always"\)/)
  assert.throws(make({ schedules: [{ name: "s", action: add, every: 60 }] }), /schedule "s": "add" has required inputs \(title, when\)/)
  assert.throws(make({ schedules: [{ name: "s", action: close, every: 60 }] }), /schedule "s": "close" works on one task/)
  assert.throws(make({ schedules: [{ name: "s", action: read, every: 4 }] }), /schedule "s": every is whole minutes from 5 to 1440/)
  assert.throws(make({ schedules: [{ name: "s", action: read, every: 60, maxSeconds: 301 }] }), /schedule "s": maxSeconds is whole seconds from 1 to 300/)
  assert.throws(make({ schedules: [{ name: "Bad-Name", action: read, every: 60 }] }), /schedule "Bad-Name": lowercase letters/)
  const nope = defineAction({ name: "nope", title: "Nope", input: z.object({}), readOnly: true, run: () => {} })
  assert.throws(make({ schedules: [{ name: "s", action: nope, every: 60 }] }), /schedule "s": action "nope" is not one of defineApp's actions/)
  assert.throws(make({ schedules: [{ name: "clegra_later", action: read, every: 5 }] }), /schedule "clegra_later" is reserved/)
  assert.throws(make({ schedules: Array.from({ length: 11 }, (_, i) => ({ name: `s${i}`, action: read, every: 60 })) }), /schedules: at most 10/)
})

test("notification types: a declared permission, names not reserved", () => {
  assert.throws(make({ notifications: { done: { label: "Done", permission: "nope.read" } } }), /notification "done": permission "nope.read" is not/)
  assert.throws(make({ notifications: { clegra_later: { label: "x" } } }), /notification "clegra_later" is reserved/)
})

test("targets: global actions, known fields and kinds, input keys of the action, placeholders of what is needed, short labels", () => {
  const withTargets = (targets: unknown[], action: Action = add) => make(swap(action, { targets }))
  assert.doesNotThrow(withTargets([{ target: "mail.message", needs: ["subject", "from"], input: { title: "{subject}", note: "From {from.address}: {uri}" }, label: { en: "Add a task from this email" } }, { target: "record:organization", needs: ["legalName"], input: { title: "{title} ({legalName})" } }, { target: "record:com.example.shipment", needs: ["trackingNumber"] }]))
  assert.throws(withTargets([{ target: "mail.message", needs: ["sender"] }]), /action "add", target 1 \(mail\.message\): "sender" is not a field of mail\.message/)
  assert.throws(withTargets([{ target: "record:organization", needs: ["shoeSize"] }]), /"shoeSize" is not a property of kind organization/)
  assert.throws(withTargets([{ target: "record:message", needs: [] }]), /kind "message" is reserved/)
  assert.throws(withTargets([{ target: "calendar.event", needs: [] }]), /target is mail\.message or record:<kind>/)
  assert.throws(withTargets([{ target: "mail.message", needs: ["subject"], input: { headline: "{subject}" } }]), /input "headline" is not an input of the action/)
  assert.throws(withTargets([{ target: "mail.message", needs: ["subject"], input: { title: "{text}" } }]), /\{text\} names "text", which is not uri or a needed field/)
  assert.throws(withTargets([{ target: "mail.message", needs: ["subject"], input: { title: "{title}" } }]), /names "title"/, "an email has no title")
  assert.throws(withTargets([{ target: "mail.message", needs: [], label: "x".repeat(41) }]), /label \(en\) is longer than 40 characters/)
  assert.throws(withTargets(Array(5).fill({ target: "mail.message", needs: [] })), /action "add": at most 4 targets/)
  assert.throws(withTargets([{ target: "mail.message", needs: [] }], close), /action "close": targets are for global actions/)
})

test("later: a confirmed write, a required date-time input, a window from 10 minutes to a week", () => {
  const withLater = (action: Action, later: unknown) => make(swap(action, { later }))
  assert.doesNotThrow(make(swap(remove, { input: z.object({ when: z.iso.datetime() }), later: { at: "when", window: 10080 } })))
  assert.throws(withLater(add, { at: "when" }), /action "add": later is for a write the person confirms/)
  assert.throws(withLater(read, { at: "when" }), /action "read": later is for a write the person confirms/)
  assert.throws(make(swap(remove, { input: z.object({ when: z.iso.datetime().optional() }), later: { at: "when" } })), /"when" must be a required input/)
  assert.throws(make(swap(remove, { input: z.object({ when: z.string() }), later: { at: "when" } })), /"when" must be a date-time string/)
  assert.throws(make(swap(remove, { input: z.object({ when: z.iso.datetime() }), later: { at: "when", window: 5 } })), /window is whole minutes from 10 to 10080/)
  assert.throws(make(swap(remove, { input: z.object({}), later: { at: "when" } })), /"when" is not an input of the action/)
})

test("the installation's tool names are reserved", () => {
  for (const name of ["clegra_later", "clegra_export", "clegra_delete", "clegra_installation"]) assert.throws(make({ actions: [...actions, defineAction({ ...read.definition, name } as never)] }), /taken or reserved/, name)
  assert.throws(make({ lifecycle: { archive: () => {} } }), /lifecycle: "archive" is not installation, export or delete/)
})
