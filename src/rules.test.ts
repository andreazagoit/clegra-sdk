import assert from "node:assert/strict"
import { test } from "node:test"

import { z } from "zod"

import { defineApp } from "./index"

/** Every rule of spec/src/rules.ts fails at definition time, naming the place (the conformance checks run the same rules). */

const entities = {
  task: { label: "Task", schema: z.object({ id: z.string(), title: z.string().meta({ role: "title" }) }), get: () => null, list: () => ({ rows: [] }) },
}
const actions = {
  add: { title: "Add", input: z.object({ title: z.string(), when: z.iso.datetime(), note: z.string().optional() }), confirm: false as const, run: () => {} },
  close: { on: "task" as const, title: "Close", input: z.object({}), run: () => {} },
  read: { title: "Read", input: z.object({}), readOnly: true, run: () => {} },
  remove: { title: "Remove", input: z.object({}), run: () => {} },
  hide: { title: "Hide", input: z.object({}), readOnly: true, visibility: "app" as const, run: () => {} },
}
const fragments = {
  count: { title: "Count", description: "Count", params: z.object({}), template: "stat" as const, data: () => ({ label: "n", value: 1 }) },
  per_project: { title: "Per project", description: "Per project", params: z.object({ project: z.string() }), template: "stat" as const, data: () => ({ label: "n", value: 1 }) },
  items: { title: "Items", description: "Items", params: z.object({}), template: "list" as const, data: () => ({ items: [] }) },
}

// Loosely typed on purpose: these definitions are wrong, and the point is the error each one gets at run time.
const make = (extra: Record<string, unknown>) => () => defineApp({ name: "rules", title: "Rules", version: "1", entities, actions, fragments, ...extra } as never)
const pages = { list: { title: "Tasks", list: "task", columns: ["title"] }, board: { title: "Board", dashboard: [] }, task: { record: "task" } }

test("a valid definition with every new key holds", () => {
  const app = make({
    pages: { ...pages, list: { ...pages.list, actions: ["add", "read"], badge: "count" } },
    nav: [{ section: "Work", pages: ["list"] }, { pages: ["board"] }],
    schedules: { nightly: { action: "read", every: 1440, maxSeconds: 300 }, cleanup: { action: "read", every: 5 } },
    notifications: { done: { label: "Done" } },
  })()
  assert.equal(app.manifest().schedules!.length, 2)
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
  assert.throws(make({ pages, nav: [{ pages: ["nope"] }] }), /nav section 1: "nope" is not a page of this app/)
  assert.throws(make({ pages, nav: [{ pages: ["task"] }] }), /nav section 1: "task" is a record page/)
  assert.throws(make({ pages, nav: [{ pages: ["list"] }, { pages: ["list"] }] }), /nav section 2: page "list" is in the navigation twice/)
  assert.throws(make({ pages, nav: [{ pages: [] }] }), /nav section 1: no pages/)
})

test("page actions: global, declared, at most 8, not on record pages", () => {
  assert.throws(make({ pages: { ...pages, list: { ...pages.list, actions: ["nope"] } } }), /page "list": "nope" is not an action of this app/)
  assert.throws(make({ pages: { ...pages, list: { ...pages.list, actions: ["close"] } } }), /page "list": "close" works on one task: a page offers global actions/)
  assert.throws(make({ pages: { ...pages, list: { ...pages.list, actions: Array(9).fill("add") } } }), /page "list": at most 8 actions/)
  assert.throws(make({ pages: { ...pages, task: { record: "task", actions: ["add"] } } }), /page "task": a record page has no page actions/)
})

test("page badge: a stat fragment without required params, not on record pages", () => {
  assert.throws(make({ pages: { ...pages, list: { ...pages.list, badge: "items" } } }), /page "list": badge "items" is not a stat fragment/)
  assert.throws(make({ pages: { ...pages, list: { ...pages.list, badge: "per_project" } } }), /page "list": badge "per_project" has required params \(project\)/)
  assert.throws(make({ pages: { ...pages, list: { ...pages.list, badge: "nope" } } }), /page "list": badge "nope" is not a fragment type/)
  assert.throws(make({ pages: { ...pages, task: { record: "task", badge: "count" } } }), /page "task": a record page has no badge/)
})

test("an agent may not use an app-only item", () => {
  assert.throws(make({ agents: { helper: { title: "H", description: "h", instructions: "h", uses: ["hide"] } } }), /agent "helper": hide is the tool of action "hide", which is app-only/)
})

test("schedules: a global action called with {}, never a write the person confirms; bounds", () => {
  assert.throws(make({ schedules: { s: { action: "remove", every: 60 } } }), /schedule "s": "remove" is a write the person confirms \(confirm "always"\)/)
  assert.throws(make({ schedules: { s: { action: "add", every: 60 } } }), /schedule "s": "add" has required inputs \(title, when\)/)
  assert.throws(make({ schedules: { s: { action: "close", every: 60 } } }), /schedule "s": "close" works on one task/)
  assert.throws(make({ schedules: { s: { action: "read", every: 4 } } }), /schedule "s": every is whole minutes from 5 to 1440/)
  assert.throws(make({ schedules: { s: { action: "read", every: 60, maxSeconds: 301 } } }), /schedule "s": maxSeconds is whole seconds from 1 to 300/)
  assert.throws(make({ schedules: { "Bad-Name": { action: "read", every: 60 } } }), /schedule "Bad-Name": lowercase letters/)
  assert.throws(make({ schedules: { s: { action: "nope", every: 60 } } }), /schedule "s": "nope" is not an action of this app/)
  assert.throws(make({ schedules: { clegra_later: { action: "read", every: 5 } } }), /schedule "clegra_later" is reserved/)
  assert.throws(make({ schedules: Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`s${i}`, { action: "read", every: 60 }])) }), /schedules: at most 10/)
})

test("notification types: a declared permission, names not reserved", () => {
  assert.throws(make({ notifications: { done: { label: "Done", permission: "nope.read" } } }), /notification "done": permission "nope.read" is not/)
  assert.throws(make({ notifications: { clegra_later: { label: "x" } } }), /notification "clegra_later" is reserved/)
})

test("targets: global actions, known fields and kinds, input keys of the action, placeholders of what is needed, short labels", () => {
  const withTargets = (targets: unknown[], action = "add") => make({ actions: { ...actions, [action]: { ...actions[action as "add"], targets } } })
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
  assert.throws(withTargets([{ target: "mail.message", needs: [] }], "close"), /action "close": targets are for global actions/)
})

test("later: a confirmed write, a required date-time input, a window from 10 minutes to a week", () => {
  const withLater = (action: string, later: unknown) => make({ actions: { ...actions, [action]: { ...actions[action as "add"], later } } })
  assert.doesNotThrow(make({ actions: { ...actions, remove: { ...actions.remove, input: z.object({ when: z.iso.datetime() }), later: { at: "when", window: 10080 } } } }))
  assert.throws(withLater("add", { at: "when" }), /action "add": later is for a write the person confirms/)
  assert.throws(withLater("read", { at: "when" }), /action "read": later is for a write the person confirms/)
  assert.throws(make({ actions: { ...actions, remove: { ...actions.remove, input: z.object({ when: z.iso.datetime().optional() }), later: { at: "when" } } } }), /"when" must be a required input/)
  assert.throws(make({ actions: { ...actions, remove: { ...actions.remove, input: z.object({ when: z.string() }), later: { at: "when" } } } }), /"when" must be a date-time string/)
  assert.throws(make({ actions: { ...actions, remove: { ...actions.remove, input: z.object({ when: z.iso.datetime() }), later: { at: "when", window: 5 } } } }), /window is whole minutes from 10 to 10080/)
  assert.throws(make({ actions: { ...actions, remove: { ...actions.remove, input: z.object({}), later: { at: "when" } } } }), /"when" is not an input of the action/)
})

test("the installation's tool names are reserved", () => {
  for (const name of ["clegra_later", "clegra_export", "clegra_delete", "clegra_installation"]) assert.throws(make({ actions: { ...actions, [name]: actions.read } }), /taken or reserved/, name)
  assert.throws(make({ lifecycle: { archive: () => {} } }), /lifecycle: "archive" is not installation, export or delete/)
})
