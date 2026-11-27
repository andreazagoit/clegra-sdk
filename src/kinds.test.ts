// Kinds (spec §3.1, §6, §8): definition-time rules, key filters, tool descriptions, search by kind, conformance.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, test } from "node:test"

import { z } from "zod"

import { defineApp, defineEntity, manifestSchema, serve, type App, type Query } from "./index"
import { devSignIn } from "./signin"
import { checkApp, formatReport, type Report } from "../spec/src/conformance"
import { kindsDocument, normaliseKey, valueProblem, KINDS } from "../spec/src/kinds"
import { MANIFEST_PATH, SPEC_VERSION } from "../spec/src/protocol"
import { testClient } from "./testing"

const local = { remoteAddress: "127.0.0.1" }
/** Served with the development sign-in, at the address the conformance checks reach it by. */
const served = (app: App) => serve(app, { auth: { signIn: devSignIn(app, { issuer: "http://127.0.0.1:3961", code: "TEST1" }) } })

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- rows of several shapes
type Row = any

/** An in-memory list that honours filters the way the contract asks: key filters (already normalised by the SDK) against the normalised stored value. */
function lister(rows: () => Row[], keys: Record<string, (v: string) => string | null> = {}) {
  return (q: Query) => {
    let out = rows()
    for (const [field, f] of Object.entries(q.filters)) {
      const wanted = typeof f === "object" && f !== null && "in" in f ? f.in : [f]
      const norm = keys[field] ?? ((v: string) => v)
      out = out.filter((r) => (Array.isArray(r[field]) ? (r[field] as unknown[]) : [r[field]]).some((v) => typeof v === "string" ? wanted.includes(norm(v) ?? "") : wanted.includes(v as never)))
    }
    if (q.text) out = out.filter((r) => q.textFields!.some((t) => String(r[t] ?? "").toLowerCase().includes(q.text!.toLowerCase())))
    return { rows: out.slice(0, q.limit), total: out.length }
  }
}

const contacts: Row[] = [
  { id: "c1", name: "Ada Fernley", email: "Ada.Fernley@Example.test", phone: "+15550100", updated: "2026-11-02T09:30:00Z" },
  { id: "c2", name: "Ben Carter", email: "ben@example.test", updated: "2026-11-03" },
]
const customers: Row[] = [
  { id: "k1", type: "company", name: "Hartley Engineering", vat: "GB999999973", emails: ["office@hartley.example"] },
  { id: "k2", type: "private", name: "Ellen Conway", emails: ["Ellen@conway.example", "e.conway@mail.example"] },
]
const products: Row[] = [{ id: "p1", name: "Wood screws", sku: "SCR-440", gtin: "2000000000015", price: 6.9 }]
const meetings: Row[] = [{ id: "m1", title: "Kick-off", start: "2026-11-20", uid: "A1b2-C3d4@calendar.example" }]

const lower = (v: string) => normaliseKey(v, "lowercase")
const upper = (v: string) => normaliseKey(v, "uppercase-no-spaces")

function kindApp(over: { contactList?: (q: Query) => { rows: Row[] }; contactRows?: () => Row[] } = {}) {
  const rows = over.contactRows ?? (() => contacts)
  const contact = defineEntity({
    name: "contact",
    label: { en: "Contact", it: "Contatto" },
    kind: "person",
    schema: z.object({
      id: z.string(),
      name: z.string().meta({ role: "title", search: true }),
      email: z.string().meta({ as: "email", label: { en: "Email", it: "Posta" }, filter: true, search: true }),
      phone: z.string().optional().meta({ as: "telephone" }),
      updated: z.string().meta({ as: "dateModified" }),
    }),
    get: (id) => rows().find((r) => r.id === id) ?? null,
    list: over.contactList ?? lister(rows, { email: lower }),
  })
  const customer = defineEntity({
    name: "customer",
    label: "Customer",
    kind: { by: "type", map: { company: "organization", private: "person" } },
    schema: z.object({
      id: z.string(),
      type: z.enum(["company", "private"]),
      name: z.string().meta({ role: "title", search: true }),
      vat: z.string().optional().meta({ as: "vatID", filter: true }),
      emails: z.array(z.string()).meta({ as: "email", filter: true }),
    }),
    get: (id) => customers.find((r) => r.id === id) ?? null,
    list: lister(() => customers, { vat: upper, emails: lower }),
  })
  const product = defineEntity({
    name: "product",
    label: "Product",
    kind: "product",
    schema: z.object({ id: z.string(), name: z.string().meta({ role: "title" }), sku: z.string().meta({ as: "sku" }), gtin: z.string().meta({ as: "gtin", filter: true }), price: z.number().meta({ as: "price", currency: "EUR" }) }),
    get: (id) => products.find((r) => r.id === id) ?? null,
    list: lister(() => products, { gtin: (v) => normaliseKey(v, "digits") }),
  })
  const meeting = defineEntity({
    name: "meeting",
    label: "Meeting",
    kind: "event",
    schema: z.object({ id: z.string(), title: z.string().meta({ role: "title" }), start: z.string().meta({ as: "startDate" }), uid: z.string().meta({ as: "uid", filter: true }) }),
    get: (id) => meetings.find((r) => r.id === id) ?? null,
    list: lister(() => meetings),
  })
  const shipment = defineEntity({
    name: "shipment",
    label: "Shipment",
    kind: "com.example.shipment",
    schema: z.object({ id: z.string(), code: z.string().meta({ role: "title", as: "trackingNumber", filter: true }), kg: z.number().meta({ as: "weight" }) }),
    get: () => null,
    list: () => ({ rows: [{ id: "s1", code: "TRK-1", kg: 2 }] }),
  })
  const note = defineEntity({
    name: "note",
    label: "Note",
    schema: z.object({ id: z.string(), text: z.string().meta({ role: "title", search: true }) }),
    get: () => null,
    list: () => ({ rows: [{ id: "n1", text: "Ada called" }] }),
  })
  return served(
    defineApp({
      name: "people",
      title: { en: "People", it: "Persone" },
      version: "1.0.0",
      locale: "en",
      kinds: { "com.example.shipment": { label: "Shipment", properties: { trackingNumber: { type: "string", key: true }, weight: { type: "number" } } } },
      entities: [contact, customer, product, meeting, shipment, note],
    }),
  )
}

/** An entity definition with one schema, for the definition errors. */
const one = (kind: unknown, schema: z.ZodObject, extra: Record<string, unknown> = {}) => () =>
  defineApp({ name: "k1", title: "K", version: "1", ...extra, entities: [defineEntity({ name: "e", label: "E", kind: kind as never, schema, get: () => null, list: () => ({ rows: [] }) })] })
const title = z.string().meta({ role: "title" })

describe("kinds: definition", () => {
  test("an unprefixed kind must be one of the spec's; reserved names and the like are refused", () => {
    assert.throws(one("contact", z.object({ id: z.string(), n: title })), /kind "contact" is not a kind of this specification/)
    assert.throws(one("message", z.object({ id: z.string(), n: title })), /reserved/)
    assert.throws(one("Com.Example", z.object({ id: z.string(), n: title })), /not a kind/)
    assert.doesNotThrow(one("com.example.ticket", z.object({ id: z.string(), n: title })), "a namespaced kind needs no definition")
    assert.doesNotThrow(one("person", z.object({ id: z.string(), n: title })))
  })

  test("`as` must be a property of the entity's kind, or a universal one", () => {
    assert.throws(one("person", z.object({ id: z.string(), n: title, v: z.string().meta({ as: "vatID", filter: true }) })), /as "vatID" is not a property of kind person/)
    assert.throws(one(undefined, z.object({ id: z.string(), n: title, e: z.string().meta({ as: "email", filter: true }) })), /needs a kind on the entity/)
    assert.doesNotThrow(one(undefined, z.object({ id: z.string(), n: title, d: z.string().meta({ as: "dateModified" }), u: z.string().meta({ as: "url" }) })))
    // A namespaced kind not defined here: only the universal properties.
    assert.throws(one("com.example.ticket", z.object({ id: z.string(), n: title, p: z.string().meta({ as: "priority" }) })), /not a property of kind com.example.ticket/)
  })

  test("the field's type must match the property's", () => {
    assert.throws(one("person", z.object({ id: z.string(), n: title, e: z.number().meta({ as: "email", filter: true }) })), /as "email" holds a string/)
    assert.throws(one("event", z.object({ id: z.string(), n: title, s: z.number().meta({ as: "startDate" }) })), /holds a date string/)
    assert.throws(one("product", z.object({ id: z.string(), n: title, p: z.number().meta({ as: "price" }) })), /without a currency/)
    assert.throws(one("task", z.object({ id: z.string(), n: title, c: z.string().meta({ as: "completed" }) })), /holds a boolean/)
    assert.throws(one("person", z.object({ id: z.string(), n: title, j: z.array(z.string()).meta({ as: "jobTitle" }) })), /holds a string;/)
    assert.throws(one("person", z.object({ id: z.string(), n: title, t: z.array(z.number()).meta({ as: "telephone" }) })), /an array of number/)
    assert.doesNotThrow(one("person", z.object({ id: z.string(), n: title, a: z.object({ streetAddress: z.string() }).meta({ as: "address" }), t: z.array(z.string()).meta({ as: "telephone" }) })))
  })

  test("a single-valued property is on one field at most; a many-valued one may be on several", () => {
    assert.throws(one("person", z.object({ id: z.string(), n: title, a: z.string().meta({ as: "givenName" }), b: z.string().meta({ as: "givenName" }) })), /single-valued/)
    assert.doesNotThrow(one("person", z.object({ id: z.string(), n: title, a: z.string().meta({ as: "email", filter: true }), b: z.string().meta({ as: "email", filter: true }) })))
  })

  test("the kind's required properties must be there (event: startDate)", () => {
    assert.throws(one("event", z.object({ id: z.string(), n: title })), /kind event requires a field with as "startDate"/)
    assert.doesNotThrow(one("event", z.object({ id: z.string(), n: title, s: z.string().meta({ as: "startDate" }) })))
  })

  test("a key needs filter: true", () => {
    assert.throws(one("person", z.object({ id: z.string(), n: title, e: z.string().meta({ as: "email" }) })), /is a key of its kind: the field needs filter: true/)
    assert.throws(one("organization", z.object({ id: z.string(), n: title, v: z.string().meta({ as: "vatID" }) })), /needs filter: true/)
    assert.throws(one("product", z.object({ id: z.string(), n: title, g: z.string().meta({ as: "gtin" }) })), /needs filter: true/)
    assert.throws(one("event", z.object({ id: z.string(), n: title, s: z.string().meta({ as: "startDate" }), u: z.string().meta({ as: "uid" }) })), /needs filter: true/)
    // taxID is a property, not (yet) a key.
    assert.doesNotThrow(one("organization", z.object({ id: z.string(), n: title, t: z.string().meta({ as: "taxID" }) })))
  })

  test("one kind per record: `by` is a required enum field without a permission, and `map` covers exactly its values", () => {
    const schema = (by: z.ZodType) => z.object({ id: z.string(), n: title, type: by })
    assert.throws(one({ by: "kind", map: {} }, schema(z.enum(["a"]))), /kind.by "kind" is not a field/)
    assert.throws(one({ by: "type", map: { a: "person" } }, schema(z.string())), /required enum field/)
    assert.throws(one({ by: "type", map: { a: "person" } }, schema(z.enum(["a"]).optional())), /required enum field/)
    assert.throws(one({ by: "type", map: { a: "person" } }, schema(z.enum(["a", "b"]))), /gives no kind for "b"/)
    assert.throws(one({ by: "type", map: { a: "person", c: "organization" } }, schema(z.enum(["a"]))), /"c" is not a value of type/)
    assert.throws(one({ by: "type", map: { a: "person" } }, schema(z.enum(["a"]).meta({ permission: "x.see" })), { permissions: { "x.see": { label: "See" } } }), /can't have a permission/)
    assert.throws(one({ by: "type", map: { a: "contact" } }, schema(z.enum(["a"]))), /not a kind of this specification/)
    // `as` may name a property of any mapped kind; keys of any of them need a filter.
    assert.doesNotThrow(one({ by: "type", map: { a: "person", b: "organization" } }, z.object({ id: z.string(), n: title, type: z.enum(["a", "b"]), v: z.string().meta({ as: "vatID", filter: true }), g: z.string().meta({ as: "givenName" }) })))
    assert.throws(one({ by: "type", map: { a: "person", b: "organization" } }, z.object({ id: z.string(), n: title, type: z.enum(["a", "b"]), v: z.string().meta({ as: "vatID" }) })), /needs filter: true/)
  })

  test("an app's own kinds are namespaced and typed", () => {
    const own = (kinds: unknown) => one("com.example.ticket", z.object({ id: z.string(), n: title }), { kinds })
    assert.throws(own({ ticket: { label: "T", properties: {} } }), /not a namespaced kind/)
    assert.throws(own({ "com.example.ticket": { label: "T", properties: { priority: { type: "color" } } } }), /needs a type/)
    assert.throws(own({ "com.example.ticket": { label: "T", properties: { "Bad-Name": { type: "string" } } } }), /not a name/)
    assert.throws(own({ "com.example.ticket": { label: "T", properties: { size: { type: "number", key: true } } } }), /must be a string property/)
    assert.doesNotThrow(() =>
      defineApp({ name: "k2", title: "K", version: "1", kinds: { "com.example.ticket": { label: "T", properties: { priority: { type: "string" } } } }, entities: [defineEntity({ name: "e", label: "E", kind: "com.example.ticket", schema: z.object({ id: z.string(), n: title, p: z.string().meta({ as: "priority" }) }), get: () => null, list: () => ({ rows: [] }) })] }),
    )
  })

  test("the manifest carries kind, as and kinds; it validates; kinds.json is the published vocabulary", () => {
    const manifest = kindApp().manifest()
    manifestSchema.parse(manifest)
    const contact = manifest.entities.find((e) => e.name === "contact")!
    assert.equal(contact.kind, "person")
    assert.equal(contact.fields.find((f) => f.name === "email")!.as, "email")
    assert.deepEqual(manifest.entities.find((e) => e.name === "customer")!.kind, { by: "type", map: { company: "organization", private: "person" } })
    assert.equal(manifest.entities.find((e) => e.name === "note")!.kind, undefined)
    assert.deepEqual(manifest.kinds, { "com.example.shipment": { label: { en: "Shipment" }, properties: { trackingNumber: { type: "string", key: true }, weight: { type: "number" } } } })
    const published = JSON.parse(readFileSync(new URL("../spec/kinds.json", import.meta.url), "utf8"))
    assert.deepEqual(published, JSON.parse(JSON.stringify(kindsDocument(SPEC_VERSION))), "spec/kinds.json is written by npm run schema")
    assert.deepEqual(Object.keys(published.kinds), ["person", "organization", "event", "task", "document", "product", "order"])
    assert.deepEqual(published.reserved, ["message", "place", "invoice", "project"])
    assert.deepEqual(Object.keys(published.universal), ["url", "dateCreated", "dateModified"])
    assert.deepEqual(KINDS.event!.required, ["startDate"])
  })
})

describe("kinds: key filters", () => {
  test("normalisation: email lower-cased, vatID upper-cased without spaces, gtin digits, uid exact", () => {
    assert.equal(normaliseKey("Ada.Fernley@Example.TEST", "lowercase"), "ada.fernley@example.test")
    assert.equal(normaliseKey("gb 999 9999 73", "uppercase-no-spaces"), "GB999999973")
    assert.equal(normaliseKey("2000 0000-00015", "digits"), "2000000000015")
    assert.equal(normaliseKey("2000A", "digits"), null)
    assert.equal(normaliseKey("A1b2@x", "exact"), "A1b2@x")
  })

  test("the handler receives key filters normalised; ranges and malformed values are refused before it", async () => {
    const seen: Query[] = []
    const app = kindApp({ contactList: (q) => (seen.push(q), { rows: [] }) })
    const c = await testClient(app)
    await c.call("contact_list", { email: "Ada.Fernley@Example.TEST" })
    assert.equal(seen.at(-1)!.filters.email, "ada.fernley@example.test")
    await c.call("contact_list", { email: { in: ["A@X.TEST", "b@y.test"] } })
    assert.deepEqual(seen.at(-1)!.filters.email, { in: ["a@x.test", "b@y.test"] })
    const range = await c.call("contact_list", { email: { gte: "a" } })
    assert.equal(range.isError, true)
    assert.equal(seen.length, 2, "a range never reaches the handler")
    const customers = await c.call("customer_list", { vat: "gb 999 9999 73" })
    assert.deepEqual((customers.structuredContent as { rows: Row[] }).rows.map((r) => r.id), ["k1"])
    const byEmail = await c.call("customer_list", { emails: "ELLEN@CONWAY.EXAMPLE" })
    assert.deepEqual((byEmail.structuredContent as { rows: Row[] }).rows.map((r) => r.id), ["k2"], "a multi-valued key matches any of its values")
    const gtin = await c.call("product_list", { gtin: "2000 0000 00015" })
    assert.deepEqual((gtin.structuredContent as { rows: Row[] }).rows.map((r) => r.id), ["p1"])
    const bad = await c.call("product_list", { gtin: "20000-ABC" })
    assert.equal((bad.structuredContent as { error: { code: string } }).error.code, "invalid_input")
    const uid = await c.call("meeting_list", { uid: "a1b2-c3d4@calendar.example" })
    assert.deepEqual((uid.structuredContent as { rows: Row[] }).rows, [], "uid is exact: another letter case is another uid")
  })

  test("a handler that answers an exact key filter with a row not holding the value fails the call, clearly", async () => {
    const app = kindApp({ contactList: () => ({ rows: contacts }) })
    const c = await testClient(app)
    const r = await c.call("contact_list", { email: "ben@example.test" })
    assert.equal(r.isError, true)
    const error = (r.structuredContent as { error: { code: string; message: string } }).error
    assert.equal(error.code, "internal")
    assert.match(error.message, /contact c1, whose email doesn't hold the exact email asked for \(ben@example.test\)/)
    // Without the filter the same handler is fine.
    assert.ok(!(await c.call("contact_list", {})).isError)
  })
})

describe("kinds: the MCP server", () => {
  test("entity tools end with the kind's fixed sentence and carry _meta.clegra { entity, kind }", async () => {
    const tools = new Map((await (await testClient(kindApp())).listTools()).map((t) => [t.name, t]))
    assert.ok(tools.get("contact_list")!.description!.endsWith(" Kind: person."), tools.get("contact_list")!.description)
    assert.ok(tools.get("contact_get")!.description!.endsWith(" Kind: person."))
    assert.ok(tools.get("customer_get")!.description!.endsWith(" Kind: organization or person (by type)."))
    assert.ok(tools.get("shipment_list")!.description!.endsWith(" Kind: com.example.shipment."))
    assert.deepEqual(tools.get("contact_list")!._meta!.clegra, { entity: "contact", kind: "person" })
    assert.deepEqual(tools.get("customer_get")!._meta!.clegra, { entity: "customer", kind: { by: "type", map: { company: "organization", private: "person" } } })
    assert.deepEqual(tools.get("note_list")!._meta!.clegra, { entity: "note" }, "an entity without a kind still names itself")
    assert.ok(!tools.get("note_list")!.description!.includes("Kind:"))
  })

  test("a key filter says it is exact and names its property, with a JSON Schema format where there is one; the same for every caller", async () => {
    const en = new Map((await (await testClient(kindApp())).listTools()).map((t) => [t.name, t]))
    const it = new Map((await (await testClient(kindApp(), { locale: "it" })).listTools()).map((t) => [t.name, t]))
    const email = (en.get("contact_list")!.inputSchema.properties as Record<string, { description: string; anyOf: { format?: string; type?: string; properties?: Record<string, unknown> }[] }>).email!
    assert.equal(email.description, "Email: exact email; a value or { in: [...] }")
    assert.equal(email.anyOf[0]!.format, "email")
    assert.equal(email.anyOf.length, 2, "a value or { in }, never a range")
    const vat = (en.get("customer_list")!.inputSchema.properties as Record<string, { description: string; anyOf: { format?: string }[] }>).vat!
    assert.equal(vat.description, "vat: exact vatID; a value or { in: [...] }")
    assert.equal(vat.anyOf[0]!.format, undefined, "JSON Schema has no format for a VAT number")
    assert.deepEqual(en.get("contact_list")!.inputSchema, it.get("contact_list")!.inputSchema, "descriptions are in the app's locale for every caller (spec §6 rule 2)")
  })

  test("search takes `kind`, keeps to it (also per record), and every result says its kind", async () => {
    const c = await testClient(kindApp())
    const tools = new Map((await c.listTools()).map((t) => [t.name, t]))
    assert.deepEqual((tools.get("search")!.inputSchema.properties as Record<string, { enum?: string[] }>).kind!.enum, ["person", "organization"])
    const all = ((await c.call("search", { query: "e" })).structuredContent as { results: { id: string; kind?: string }[] }).results
    assert.deepEqual(Object.fromEntries(all.map((r) => [r.id, r.kind ?? null])), {
      "clegra://people/contact/c1": "person",
      "clegra://people/contact/c2": "person",
      "clegra://people/customer/k1": "organization",
      "clegra://people/customer/k2": "person",
      "clegra://people/note/n1": null,
    })
    const orgs = await c.call("search", { query: "e", kind: "organization" })
    assert.deepEqual((orgs.structuredContent as { results: { id: string }[] }).results.map((r) => r.id), ["clegra://people/customer/k1"])
    assert.deepEqual(JSON.parse(orgs.content![0]!.text!).results, [{ id: "clegra://people/customer/k1", title: "Hartley Engineering", url: "clegra://people/customer/k1", kind: "organization" }])
    const fetched = JSON.parse((await c.call("fetch", { id: "clegra://people/customer/k2" })).content![0]!.text!)
    assert.deepEqual(fetched.metadata, { type: "customer", kind: "person" })
  })

  test("value forms (spec §3.1 rule 4)", () => {
    const def = { type: "string" as const }
    assert.equal(valueProblem("email", def, "ada@example.test"), null)
    assert.ok(valueProblem("email", def, "ada at example"))
    assert.equal(valueProblem("vatID", def, "GB999999973"), null)
    assert.ok(valueProblem("vatID", def, "GB 999 9999 73"))
    assert.equal(valueProblem("gtin", def, "2000000000015"), null)
    assert.ok(valueProblem("gtin", def, "20000"))
    assert.equal(valueProblem("startDate", { type: "date" }, "2026-11-20"), null)
    assert.equal(valueProblem("startDate", { type: "date" }, "2026-11-20T09:30:00+01:00"), null)
    assert.ok(valueProblem("startDate", { type: "date" }, "20/11/2026"))
    assert.equal(valueProblem("address", { type: "address" }, { streetAddress: "1 Main St", addressLocality: "York" }), null)
    assert.ok(valueProblem("address", { type: "address" }, { street: "1 Main St" }))
    assert.ok(valueProblem("price", { type: "money" }, "6.90"))
  })
})

// ------------------------------------------------------------------ conformance: each check passes on a good app and fails on a wrong one

/** The app's own fetch with its manifest or its tools/list answer changed: an app built some other way, and wrong. */
function tampered(app: ReturnType<typeof kindApp>, change: { manifest?: (m: Record<string, unknown>) => void; tools?: (tools: Record<string, unknown>[]) => void }) {
  return async (request: Request): Promise<Response> => {
    const body = request.method === "POST" ? await request.clone().text() : ""
    const response = await app.fetch(request, local)
    if (change.manifest && new URL(request.url).pathname === MANIFEST_PATH) {
      const m = (await response.json()) as Record<string, unknown>
      change.manifest(m)
      return Response.json(m)
    }
    if (change.tools && body.includes('"tools/list"')) {
      const raw = await response.text()
      const json = JSON.parse(response.headers.get("content-type")?.includes("text/event-stream") ? raw.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).pop()! : raw)
      change.tools(json.result.tools)
      return Response.json(json)
    }
    return response
  }
}

const KIND_CHECKS = ["kinds.known", "kinds.properties", "kinds.tools", "kinds.keys", "kinds.values"]
const byId = (report: Report, id: string) => report.checks.find((c) => c.id === id)!

async function run(app: ReturnType<typeof kindApp>, change?: Parameters<typeof tampered>[1]) {
  return checkApp({ url: "http://127.0.0.1:3961", token: await app.dev!.token(), fetch: change ? tampered(app, change) : (r) => app.fetch(r, local) })
}

describe("kinds: conformance", () => {
  test("a good app passes every kinds check, none skipped", async () => {
    const report = await run(kindApp())
    assert.ok(report.ok && report.complete, formatReport(report))
    for (const id of KIND_CHECKS) assert.ok(byId(report, id).ok && !byId(report, id).skipped, `${id}: ${formatReport(report)}`)
  })

  test("an app without kinds: the kinds checks are neutral (skipped), and the app is conformant", async () => {
    const app = served(defineApp({ name: "plainapp", title: "P", version: "1", entities: [defineEntity({ name: "note", label: "Note", schema: z.object({ id: z.string(), t: z.string().meta({ role: "title", search: true }) }), get: () => null, list: () => ({ rows: [{ id: "n1", t: "x" }] }) })] }))
    const report = await checkApp({ url: "http://127.0.0.1:3961", token: await app.dev!.token(), fetch: (r) => app.fetch(r, local) })
    assert.ok(report.ok && report.complete, formatReport(report))
    for (const id of KIND_CHECKS) assert.ok(byId(report, id).skipped, `${id} is skipped`)
    assert.match(formatReport(report), /\nConformant\.$/)
  })

  test("kinds.known fails on a kind the spec doesn't have", async () => {
    const report = await run(kindApp(), { manifest: (m) => void ((m.entities as Record<string, unknown>[])[0]!.kind = "contact") })
    assert.equal(byId(report, "kinds.known").ok, false)
    assert.match(byId(report, "kinds.known").detail!, /"contact"/)
  })

  test("kinds.properties fails on an `as` outside the kind and a key without a filter", async () => {
    const report = await run(kindApp(), {
      manifest: (m) => {
        const contact = (m.entities as { fields: Record<string, unknown>[] }[])[0]!
        contact.fields.find((f) => f.name === "phone")!.as = "vatID"
        delete contact.fields.find((f) => f.name === "email")!.filter
      },
    })
    const check = byId(report, "kinds.properties")
    assert.equal(check.ok, false)
    assert.match(check.detail!, /as "vatID" is not a property of kind person/)
    assert.match(check.detail!, /needs filter: true/)
  })

  test("kinds.tools fails when an entity tool doesn't name its kind", async () => {
    const report = await run(kindApp(), { tools: (tools) => tools.filter((t) => t.name === "contact_list").forEach((t) => ((t.description = "Contacts."), delete (t._meta as Record<string, unknown>).clegra)) })
    const check = byId(report, "kinds.tools")
    assert.ok(check, formatReport(report))
    assert.equal(check.ok, false)
    assert.match(check.detail!, /contact_list: the description doesn't end with «Kind: person\.»/)
    assert.match(check.detail!, /_meta.clegra/)
  })

  test("kinds.keys fails when a key filter compares case-sensitively (the stored address isn't normalised)", async () => {
    const strict = (q: Query) => ({ rows: contacts.filter((r) => q.filters.email === undefined || r.email === q.filters.email) })
    const report = await run(kindApp({ contactList: strict }))
    const check = byId(report, "kinds.keys")
    assert.equal(check.ok, false)
    assert.match(check.detail!, /clegra:\/\/people\/contact\/c1 is not found by its own email/)
  })

  test("kinds.keys fails when a key filter is ignored (the SDK refuses the rows; the call fails)", async () => {
    const report = await run(kindApp({ contactList: () => ({ rows: contacts }) }))
    assert.equal(byId(report, "kinds.keys").ok, false)
  })

  test("kinds.values fails on a value that only resembles the property", async () => {
    const report = await run(kindApp({ contactRows: () => [{ id: "c9", name: "Typo", email: "nobody at example", updated: "yesterday" }] }))
    const check = byId(report, "kinds.values")
    assert.equal(check.ok, false)
    assert.match(check.detail!, /email \(email\): "nobody at example" is not an email address/)
    assert.match(check.detail!, /updated \(dateModified\): "yesterday" is not an RFC 3339 date/)
  })
})
