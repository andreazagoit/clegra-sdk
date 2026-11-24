import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, describe, test } from "node:test"

import Ajv2020 from "ajv/dist/2020"
import { z } from "zod"

import { appCatalog, BASIC_CATALOG_ID, CLEGRA_A2UI_CATALOG, CLEGRA_CATALOG_ID, componentSurface, STYLE_EXTENSION, templateSurface, type A2uiComponent, type A2uiSurface } from "./a2ui"
import { defineApp, manifestSchema, type AuthOptions } from "./index"
import { testClient } from "./testing"

/**
 * ARTIFACTS AS A2UI 1.0 SURFACES (spec §5.4): every surface the SDK writes is valid against A2UI 1.0's own schemas
 * (test/a2ui/v1_0, unchanged from the A2UI repository) with the Basic Catalog, Clegra's catalog and the app's catalog
 * mixed in, and its tree holds together (one root, every child there, UAX #31 ids, no theme).
 */

const schema = (name: string) => JSON.parse(readFileSync(new URL(`../test/a2ui/v1_0/${name}`, import.meta.url), "utf8")) as Record<string, unknown>
const basic = schema("basic_catalog.json") as { components: Record<string, unknown>; functions: Record<string, unknown>; $defs: Record<string, { oneOf?: unknown[] }> }

/** A validator of agent-to-renderer messages whose `catalog.json` is the Basic Catalog with the given catalogs mixed in. */
function validatorWith(...catalogs: { components: Record<string, unknown>; functions?: Record<string, unknown> }[]) {
  const components = Object.assign({}, basic.components, ...catalogs.map((c) => c.components))
  const functions = Object.assign({}, basic.functions, ...catalogs.map((c) => c.functions ?? {}))
  // The envelope refers to the catalog as `catalog.json` beside it (A2UI's placeholder for the renderer's catalog).
  const merged = {
    ...basic,
    $id: "https://a2ui.org/specification/v1_0/catalog.json",
    components,
    functions,
    $defs: { ...basic.$defs, anyComponent: { oneOf: Object.keys(components).map((k) => ({ $ref: `#/components/${k}` })) }, anyFunction: { oneOf: Object.keys(functions).map((k) => ({ $ref: `#/functions/${k}` })) } },
  }
  const ajv = new Ajv2020({ strict: false, validateFormats: false, allErrors: true })
  ajv.addSchema(schema("common_types.json"))
  ajv.addSchema(merged)
  return ajv.compile(schema("agent_to_renderer.json"))
}

const UAX31 = /^[\p{XID_Start}_][\p{XID_Continue}]*$/u

/** The tree's own rules: one `root`, every referenced child present, ids UAX #31, nothing unreachable, no theme. */
function assertTree(surface: A2uiSurface) {
  assert.equal(surface.length, 1)
  const [message] = surface
  assert.equal(message.version, "1.0")
  assert.ok(!("theme" in message.createSurface), "A2UI 1.0: no theme")
  const byId = new Map(message.createSurface.components.map((c) => [c.id, c]))
  assert.equal(byId.size, message.createSurface.components.length, "ids are unique")
  assert.ok(byId.has("root"))
  const children = (c: A2uiComponent): string[] => [
    ...(typeof c.child === "string" ? [c.child] : []),
    ...(Array.isArray(c.children) ? (c.children as string[]) : c.children && typeof c.children === "object" ? [(c.children as { componentId: string }).componentId] : []),
  ]
  const seen = new Set<string>()
  const walk = (id: string) => {
    assert.ok(byId.has(id), `child "${id}" is there`)
    if (seen.has(id)) return
    seen.add(id)
    for (const child of children(byId.get(id)!)) walk(child)
  }
  walk("root")
  assert.deepEqual([...byId.keys()].filter((id) => !seen.has(id)), [], "every component is reachable from root")
  for (const id of byId.keys()) assert.match(id, UAX31)
}

const valid = validatorWith(CLEGRA_A2UI_CATALOG as never)
const assertValid = (surface: A2uiSurface, validate = valid) => {
  for (const message of surface) assert.ok(validate(message), JSON.stringify(validate.errors?.slice(0, 3), null, 1))
  assertTree(surface)
}
const ofId = (surface: A2uiSurface, id: string) => surface[0].createSurface.components.find((c) => c.id === id)

describe("template surfaces", () => {
  const input = { surfaceId: "clegra://crm/x/e30", title: "Open pipeline", actions: [{ tool: "create_deal", title: "New deal" }] }

  test("card: the title opens the record, fields as a templated list, status as a hint", () => {
    const s = templateSurface("card", { title: "Acme renewal", subtitle: "Acme Corp", status: "Proposal", fields: [{ label: "Value", value: "€ 12,000" }], uri: "clegra://crm/deal/d1" }, input)
    assertValid(s)
    assert.equal(s[0].createSurface.catalogId, BASIC_CATALOG_ID)
    assert.deepEqual(ofId(s, "title")!.action, { functionCall: { "@call": "openRecord", catalogId: CLEGRA_CATALOG_ID, args: { uri: { "@path": "/uri" } } } })
    assert.deepEqual(ofId(s, "fields")!.children, { path: "/fields", componentId: "field" })
    assert.deepEqual(ofId(s, "status")!["@metadata"], { extensions: { [STYLE_EXTENSION]: "status" } })
    assert.deepEqual(s[0].createSurface.dataModel.fields, [{ label: "Value", value: "€ 12,000" }], "the data model is the data as sent")
    // No record text is ever pasted into the tree: every text of the data is a binding.
    assert.ok(!JSON.stringify(s[0].createSurface.components).includes("Acme"))
  })

  test("card without uri, subtitle or status: those parts are left out", () => {
    const s = templateSurface("card", { title: "Note", fields: [] }, input)
    assertValid(s)
    assert.equal(ofId(s, "title")!.component, "Text")
    assert.equal(ofId(s, "subtitle"), undefined)
    assert.equal(ofId(s, "fields"), undefined)
  })

  test("stat: money, percent, number and text values", () => {
    const money = templateSurface("stat", { label: "3 open deals", value: 48000, format: "money", currency: "EUR" }, input)
    assertValid(money)
    assert.deepEqual(ofId(money, "value")!.text, { "@call": "formatCurrency", args: { value: { "@path": "/value" }, currency: { "@path": "/currency" } } })
    const percent = templateSurface("stat", { label: "Won", value: 0.42, format: "percent" }, input)
    assertValid(percent)
    assert.equal((ofId(percent, "value")!.text as { "@call": string })["@call"], "formatPercent")
    const count = templateSurface("stat", { label: "Open", value: 7, hint: "this week" }, input)
    assertValid(count)
    assert.equal((ofId(count, "value")!.text as { "@call": string })["@call"], "formatNumber")
    assert.ok(ofId(count, "hint"))
    const word = templateSurface("stat", { label: "State", value: "ok" }, { ...input, actions: [] })
    assertValid(word)
    assert.deepEqual(ofId(word, "value")!.text, { "@path": "/value" })
    assert.equal(ofId(word, "actions"), undefined)
  })

  test("list: items from the data model, each opening its record", () => {
    const s = templateSurface("list", { items: [{ title: "Acme renewal", subtitle: "12 Dec", status: "Proposal", uri: "clegra://crm/deal/d1" }, { title: "Loose" }] }, input)
    assertValid(s)
    assert.deepEqual(ofId(s, "items")!.children, { path: "/items", componentId: "item" })
    assert.deepEqual((ofId(s, "item_title")!.action as { functionCall: { args: unknown } }).functionCall.args, { uri: { "@path": "uri" } }, "relative inside the template")
    const plain = templateSurface("list", { items: [{ title: "a" }] }, input)
    assertValid(plain)
    assert.equal(ofId(plain, "item_title")!.component, "Text")
  })

  test("chart: Clegra's Chart bound to the points", () => {
    const s = templateSurface("chart", { kind: "bar", points: [{ label: "Lead", value: 3 }], format: "number" }, input)
    assertValid(s)
    assert.deepEqual(ofId(s, "chart"), { id: "chart", component: "Chart", "@catalogId": CLEGRA_CATALOG_ID, kind: { "@path": "/kind" }, points: { "@path": "/points" }, format: { "@path": "/format" } })
  })

  test("actions: an event per action, the first primary", () => {
    const s = templateSurface("stat", { label: "x", value: 1 }, { ...input, actions: [{ tool: "create_deal", title: "New deal" }, { tool: "log_call", title: "Log call" }] })
    assertValid(s)
    assert.deepEqual(ofId(s, "action_0")!.action, { event: { name: "create_deal", context: {} } })
    assert.equal(ofId(s, "action_0")!.variant, "primary")
    assert.equal(ofId(s, "action_1")!.variant, "default")
  })

  test("a surface naming an unknown component is not valid A2UI", () => {
    const s = templateSurface("stat", { label: "x", value: 1 }, input)
    const broken = structuredClone(s)
    broken[0].createSurface.components.push({ id: "odd", component: "Sparkline" })
    assert.equal(valid(broken[0]), false)
  })
})

describe("the app's own components", () => {
  const keyFile = join(tmpdir(), `clegra-a2ui-key-${randomUUID()}.json`)
  after(() => rmSync(keyFile, { force: true }))
  const app = defineApp({
    name: "crm",
    title: "CRM",
    version: "1.0.0",
    auth: { dev: { keyFile, code: "TEST1" } } as AuthOptions,
    entities: {},
    actions: { create_deal: { title: "New deal", input: z.object({ name: z.string() }), run: () => ({ message: "ok" }) } },
    components: {
      StageFunnel: {
        title: "Stage funnel",
        description: "Deals narrowing stage by stage",
        props: z.object({ stages: z.array(z.object({ label: z.string(), count: z.number() })), currency: z.string().optional() }),
        view: { html: "<!doctype html><title>funnel</title>" },
        actions: ["create_deal"],
      },
    },
    artifacts: {
      funnel: { title: "Funnel", description: "The funnel", params: z.object({}), component: "StageFunnel", actions: ["create_deal"], data: () => ({ stages: [{ label: "Lead", count: 4 }] }) },
      broken: { title: "Broken", description: "Bad props", params: z.object({}), component: "StageFunnel", data: () => ({ stages: "no" }) },
      total: { title: "Total", description: "A figure", params: z.object({}), template: "stat", data: () => ({ label: "Open", value: 2 }) },
    },
  })

  test("manifest: components, each artifact naming its component; valid against the manifest schema", () => {
    const m = app.manifest()
    assert.ok(manifestSchema.safeParse(m).success)
    assert.deepEqual(m.components?.StageFunnel?.view, "ui://crm/components/StageFunnel")
    assert.deepEqual(m.components?.StageFunnel?.actions, ["create_deal"])
    assert.equal(m.artifacts.find((a) => a.type === "funnel")?.component, "StageFunnel")
  })

  test("show_: the surface in structuredContent and as an application/a2ui+json resource; valid with the app's catalog", async () => {
    const c = await testClient(app, { permissions: "all" })
    const catalog = JSON.parse((await c.readResource("a2ui://crm/catalog.json"))[0]!.text!) as ReturnType<typeof appCatalog>
    assert.equal(catalog.catalogId, "a2ui://crm/catalog.json")
    assert.equal(catalog.protocolVersion, "1.0")
    const withApp = validatorWith(CLEGRA_A2UI_CATALOG as never, catalog as never)
    const r = await c.call("show_funnel", {})
    const sc = r.structuredContent as { a2ui: A2uiSurface; uri: string }
    assertValid(sc.a2ui, withApp)
    const component = ofId(sc.a2ui, "component")!
    assert.deepEqual(component, { id: "component", component: "StageFunnel", "@catalogId": "a2ui://crm/catalog.json", stages: { "@path": "/stages" }, currency: { "@path": "/currency" } })
    assert.equal(sc.a2ui[0].createSurface.surfaceId, sc.uri)
    const embedded = (r.content as { type: string; resource?: { uri: string; mimeType: string; text: string } }[]).find((x) => x.type === "resource")
    assert.equal(embedded?.resource?.mimeType, "application/a2ui+json")
    assert.equal(embedded?.resource?.uri, "a2ui://crm/surfaces/funnel")
    assert.deepEqual(JSON.parse(embedded!.resource!.text), sc.a2ui)
    // The page is a view like any other, served with view tickets.
    assert.equal((await c.readResource("ui://crm/components/StageFunnel"))[0]!.mimeType, "text/html;profile=mcp-app")
  })

  test("resolve carries the surface; props that fail the schema are an error, never half drawn", async () => {
    const c = await testClient(app, { permissions: "all" })
    const total = await c.call("show_total", {})
    const uri = (total.structuredContent as { uri: string }).uri
    const resolved = await c.call("clegra_resolve", { uris: [uri], want: "artifact" })
    const [one] = (resolved.structuredContent as { results: { a2ui?: A2uiSurface }[] }).results
    assertValid(one!.a2ui!)
    const broken = await c.call("show_broken", {})
    assert.equal(broken.isError, true)
  })

  test("definition errors: reserved names, unknown components", () => {
    const base = { name: "xx", title: "X", version: "1", auth: { dev: { keyFile, code: "TEST1" } } as AuthOptions, entities: {} }
    const view = { html: "<p>" }
    assert.throws(() => defineApp({ ...base, components: { Card: { title: "c", props: z.object({}), view } } }), /Basic Catalog or Clegra/)
    assert.throws(() => defineApp({ ...base, components: { lower: { title: "c", props: z.object({}), view } } }), /capital letter/)
    assert.throws(() => defineApp({ ...base, artifacts: { a: { title: "a", description: "a", params: z.object({}), component: "Nope", data: () => ({}) } } }), /not a component/)
  })

  test("componentSurface binds each prop by JSON Pointer", () => {
    const s = componentSurface("crm", "Odd", { "a/b": 1 }, ["a/b"], { surfaceId: "s", title: "t" })
    assert.deepEqual(ofId(s, "component")!["a/b"], { "@path": "/a~1b" })
  })
})

describe("records, creatable types, widgets and what changed", () => {
  const keyFile = join(tmpdir(), `clegra-a2ui-key-${randomUUID()}.json`)
  after(() => rmSync(keyFile, { force: true }))
  type Deal = { id: string; name: string; stage: "lead" | "proposal" | "won"; value: number; due: string; owner: string; note?: string }
  const deals = new Map<string, Deal>([["d1", { id: "d1", name: "Acme renewal", stage: "proposal", value: 12000, due: "2026-12-01", owner: "o1", note: "call back" }]])
  const make = () =>
    defineApp({
      name: "crm",
      title: "CRM",
      version: "1.0.0",
      locale: "en",
      auth: { dev: { keyFile, code: "TEST1" } } as AuthOptions,
      permissions: { "deals.edit": { label: "Edit deals" } },
      entities: {
        owner: {
          label: "Owner",
          schema: z.object({ id: z.string(), name: z.string().meta({ role: "title" }) }),
          get: (id) => (id === "o1" ? { id, name: "Ada" } : null),
          list: () => ({ rows: [{ id: "o1", name: "Ada" }] }),
        },
        deal: {
          label: { en: "Deal", it: "Trattativa" },
          schema: z.object({
            id: z.string(),
            name: z.string().meta({ role: "title" }),
            stage: z.enum(["lead", "proposal", "won"]).meta({ role: "status", labels: { proposal: { en: "Proposal", it: "Proposta" } }, tones: { proposal: "info" } }),
            value: z.number().meta({ label: { en: "Value", it: "Valore" }, currency: "EUR", filter: true }),
            due: z.iso.date().meta({ label: { en: "Due", it: "Scadenza" } }),
            owner: z.string().meta({ label: { en: "Owner", it: "Responsabile" }, ref: "owner" }),
            note: z.string().optional(),
          }),
          record: { fields: ["value", "due", "owner"], actions: ["win", "lose"] },
          create: { action: "new_deal", title: { en: "Deal draft", it: "Bozza di trattativa" } },
          get: (id) => deals.get(id) ?? null,
          list: () => ({ rows: [...deals.values()] }),
        },
      },
      actions: {
        win: { on: "deal", title: "Mark won", input: z.object({}), confirm: false, expose: { plain: true }, run: (_i, _ctx, d) => ({ message: `${d.name} won` }) },
        lose: { on: "deal", title: "Mark lost", input: z.object({}), confirm: false, permission: "deals.edit", run: () => ({ message: "lost" }) },
        new_deal: {
          title: "New deal",
          input: z.object({ name: z.string().default("Untitled") }),
          confirm: false,
          expose: { plain: true },
          run: ({ name }, ctx) => {
            const id = `d${deals.size + 1}`
            deals.set(id, { id, name, stage: "lead", value: 0, due: "2026-12-31", owner: "o1", note: "" })
            ctx.changed("pipeline")
            return { record: ctx.uri("deal", id) }
          },
        },
      },
      artifacts: {
        pipeline: { title: "Pipeline", description: "Open deals", params: z.object({}), template: "stat", data: () => ({ label: "Open", value: deals.size }) },
        top: { title: "Top deals", description: "The biggest", params: z.object({ limit: z.number() }), template: "list", data: () => ({ items: [] }) },
      },
      widgets: { pipeline: { sizes: ["small", "medium"] } },
    })

  test("manifest: the record template, the creatable type and the widgets; valid against the manifest schema", () => {
    const m = make().manifest()
    assert.ok(manifestSchema.safeParse(m).success, JSON.stringify(manifestSchema.safeParse(m).error?.issues.slice(0, 2)))
    assert.deepEqual(m.entities.find((e) => e.name === "deal")?.record, { fields: ["value", "due", "owner"], actions: ["win", "lose"] })
    assert.deepEqual(m.artifacts.find((a) => a.type === "deal")?.create, { action: "new_deal", title: { en: "Deal draft", it: "Bozza di trattativa" } })
    assert.deepEqual(m.widgets, [{ artifact: "pipeline", sizes: ["small", "medium"], size: "small" }])
  })

  test("record: the surface from the template, values in the reader's language, only the actions the caller may use", async () => {
    const c = await testClient(make(), { permissions: [], locale: "it" })
    const r = await c.call("clegra_resolve", { uris: ["clegra://crm/deal/d1"], want: "artifact" })
    const [one] = (r.structuredContent as { results: { a2ui: A2uiSurface }[] }).results
    assertValid(one!.a2ui)
    const model = one!.a2ui[0].createSurface.dataModel as { title: string; status: string; tone: string; uri: string; fields: { name: string; label: string; value: string }[] }
    assert.equal(model.title, "Acme renewal")
    assert.equal(model.status, "Proposta")
    assert.equal(model.tone, "info")
    assert.equal(model.uri, "clegra://crm/deal/d1")
    assert.deepEqual(model.fields.map((f) => [f.name, f.label]), [["value", "Valore"], ["due", "Scadenza"], ["owner", "Responsabile"]])
    assert.match(model.fields[0]!.value, /12\.000/)
    assert.equal(model.fields[2]!.value, "Ada")
    assert.equal(ofId(one!.a2ui, "title")!.component, "Button")
    // «lose» needs deals.edit: not offered. «win» carries the record's id.
    assert.equal(ofId(one!.a2ui, "action_1"), undefined)
    assert.deepEqual(ofId(one!.a2ui, "action_0")!.action, { event: { name: "deal_win", context: { id: "d1" } } })
  })

  test("a write says what it changed: the record it acted on, the record it made, what the handler named", async () => {
    const c = await testClient(make(), { permissions: "all" })
    const won = await c.call("deal_win", { id: "d1" })
    assert.deepEqual((won._meta?.clegra as { changed?: string[] }).changed, ["clegra://crm/deal/d1"])
    const made = await c.call("new_deal", {})
    assert.ok(!made.isError, JSON.stringify(made))
    const uri = (made.structuredContent as { record: string }).record
    assert.match(uri, /^clegra:\/\/crm\/deal\//)
    assert.deepEqual((made._meta?.clegra as { changed?: string[] }).changed, [uri, "pipeline"])
  })

  test("definition errors: a record field or action that isn't the entity's, a create that needs input or confirmation, a widget with params", () => {
    const base = { name: "xx", title: "X", version: "1", auth: { dev: { keyFile, code: "TEST1" } } as AuthOptions }
    const thing = (extra: Record<string, unknown>) => ({ thing: { label: "Thing", schema: z.object({ id: z.string(), name: z.string().meta({ role: "title" }) }), get: () => null, list: () => ({ rows: [] }), ...extra } })
    const make = { title: "Make", input: z.object({ name: z.string() }), run: () => ({}) }
    assert.throws(() => defineApp({ ...base, entities: thing({ record: { fields: ["nope"] } }) as never }), /"nope" is not a field of thing/)
    assert.throws(() => defineApp({ ...base, entities: thing({ record: { fields: ["name"], actions: ["make"] } }) as never, actions: { make } }), /not an action on one thing/)
    assert.throws(() => defineApp({ ...base, entities: thing({ create: { action: "make" } }) as never, actions: { make } }), /required inputs \(name\)/)
    assert.throws(() => defineApp({ ...base, entities: thing({ create: { action: "make" } }) as never, actions: { make: { ...make, input: z.object({}) } } }), /confirm "always"/)
    const top = { title: "Top", description: "Top", params: z.object({ limit: z.number() }), template: "stat" as const, data: () => null }
    assert.throws(() => defineApp({ ...base, entities: {}, artifacts: { top }, widgets: { top: {} } }), /required params \(limit\)/)
    assert.throws(() => defineApp({ ...base, entities: {}, artifacts: { top: { ...top, params: z.object({}) } }, widgets: { top: { sizes: ["small"], size: "large" } } }), /not one of its sizes/)
    assert.throws(() => defineApp({ ...base, entities: {}, widgets: { gone: {} } as never }), /not an artifact type/)
  })

  test("ctx.changed names only this app's artifacts", async () => {
    const app = defineApp({
      name: "yy",
      title: "Y",
      version: "1",
      auth: { dev: { keyFile, code: "TEST1" } } as AuthOptions,
      entities: {},
      actions: { poke: { title: "Poke", input: z.object({}), confirm: false, expose: { plain: true }, run: (_i, ctx) => ctx.changed("clegra://other/x/1") } },
    })
    const c = await testClient(app, { permissions: "all" })
    const r = await c.call("poke", {})
    assert.equal(r.isError, true)
  })
})
