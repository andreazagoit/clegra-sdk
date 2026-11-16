// References across apps (spec §3.2): ref.kind, the text form, no titles, the resolver's not_found, the view, conformance.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { z } from "zod"

import { defineApp, ref, type AuthOptions } from "./index"
import { checkApp, formatReport, type Report } from "../spec/src/conformance"
import { CROSS_APP_HINT, CROSS_INPUT_HINT } from "./server"
import { testClient } from "./testing"
import { viewHtml } from "./view"

const local = { remoteAddress: "127.0.0.1" }
const auth = { dev: { keyFile: false, code: "TEST1" } } as AuthOptions

type Deal = { id: string; name: string; customer?: string }

function dealsApp(stored: () => Deal[] = () => [{ id: "d1", name: "Forty seats", customer: "clegra://erp/customer/42" }, { id: "d2", name: "Pilot" }]) {
  const deals = new Map(stored().map((d) => [d.id, d]))
  return defineApp({
    name: "deals",
    title: "Deals",
    version: "1.0.0",
    auth,
    entities: {
      deal: {
        label: "Deal",
        schema: z.object({
          id: z.string(),
          name: z.string().meta({ role: "title", search: true }),
          customer: ref.kind("organization").optional().meta({ label: "Customer", filter: true }),
        }),
        get: (id) => deals.get(id) ?? null,
        list: (q) => ({ rows: [...deals.values()].filter((d) => q.filters.customer === undefined || d.customer === q.filters.customer) }),
      },
    },
    actions: {
      link_customer: {
        on: "deal",
        title: "Link the customer",
        input: z.object({ customer: ref.kind("organization").meta({ label: "Customer" }) }),
        confirm: "optional",
        expose: { plain: true },
        run: (input, _ctx, deal) => {
          deals.set(deal.id, { ...deal, customer: input.customer })
          return { message: "Linked.", record: deal.id }
        },
      },
    },
  })
}

describe("refs across apps: definition", () => {
  test("ref.kind takes a kind of the spec or a namespaced one", () => {
    assert.throws(() => ref.kind("company"), /not a kind of this specification/)
    assert.throws(() => ref.kind("message"), /reserved/)
    assert.doesNotThrow(() => ref.kind("com.example.shipment"))
  })

  test("the manifest says { kind } on the field and on the action input; the value is a record URI", () => {
    const manifest = dealsApp().manifest()
    const field = manifest.entities[0]!.fields.find((f) => f.name === "customer")!
    assert.deepEqual(field.ref, { kind: "organization" })
    const input = manifest.actions[0]!.input as { properties: Record<string, { ref?: unknown; pattern?: string }> }
    assert.deepEqual(input.properties.customer!.ref, { kind: "organization" })
    assert.ok(input.properties.customer!.pattern, "the input checks the URI's syntax")
    assert.equal(ref.kind("organization").safeParse("clegra://erp/customer/42").success, true)
    for (const bad of ["42", "https://erp.example/customer/42", "clegra://erp/customer", "clegra://ERP/customer/42", "clegra://erp/customer/42/x"]) assert.equal(ref.kind("organization").safeParse(bad).success, false, bad)
  })
})

describe("refs across apps: the MCP server", () => {
  test("a model reads { uri, kind }; structuredContent keeps the URI; no refs title is sent; the tools say how to open it", async () => {
    const c = await testClient(dealsApp())
    const r = await c.call("deal_list", {})
    const text = JSON.parse(r.content![0]!.text!) as { rows: Record<string, unknown>[] }
    assert.deepEqual(text.rows[0]!.customer, { uri: "clegra://erp/customer/42", kind: "organization" })
    assert.equal(text.rows[1]!.customer, undefined)
    const s = r.structuredContent as { rows: Deal[]; refs: Record<string, unknown> }
    assert.equal(s.rows[0]!.customer, "clegra://erp/customer/42")
    assert.ok(!("customer" in s.refs), "the app never names another app's record")
    const got = JSON.parse((await c.call("deal_get", { id: "d1" })).content![0]!.text!)
    assert.deepEqual(got.customer, { uri: "clegra://erp/customer/42", kind: "organization" })
    const tools = new Map((await c.listTools()).map((t) => [t.name, t]))
    assert.ok(tools.get("deal_list")!.description!.endsWith(CROSS_APP_HINT), "no kind: the hint ends it")
    assert.ok(tools.get("deal_link_customer")!.description!.endsWith(CROSS_INPUT_HINT))
    assert.equal((tools.get("deal_link_customer")!.inputSchema.properties as Record<string, { type: string; pattern?: string }>).customer!.type, "string")
  })

  test("an action accepts any record URI, never calls the other app, and refuses what is not one, field by field", async () => {
    const c = await testClient(dealsApp())
    const ok = await c.call("deal_link_customer", { id: "d2", customer: "clegra://warehouse/customer/7" })
    assert.ok(!ok.isError, JSON.stringify(ok))
    assert.equal(((await c.call("deal_get", { id: "d2" })).structuredContent as { record: Deal }).record.customer, "clegra://warehouse/customer/7")
    const bad = await c.call("deal_link_customer", { id: "d2", customer: "Hartley Engineering" })
    const error = (bad.structuredContent as { error: { code: string; fields: Record<string, string> } }).error
    assert.equal(error.code, "invalid_input")
    assert.match(error.fields.customer!, /record URI/)
    // The record's view offers the action with a { kind } input: a host's picker, or a URI box in the generated view.
    const view = ((await c.call("deal_get", { id: "d1" })).structuredContent as { view: { actions: { input: { properties: Record<string, { ref?: unknown }> } }[] } }).view
    assert.deepEqual(view.actions[0]!.input.properties.customer!.ref, { kind: "organization" })
  })

  test("the resolver answers not_found for another app's URI, gone for its own missing record", async () => {
    const c = await testClient(dealsApp())
    const r = await c.call("clegra_resolve", { uris: ["clegra://erp/customer/42", "clegra://deals/deal/zz", "clegra://deals/deal/d1", "not a uri"] })
    assert.deepEqual((r.structuredContent as { results: { state: string }[] }).results.map((x) => x.state), ["not_found", "gone", "ok", "not_found"])
  })

  test("the generated view shows the state the host resolved, and otherwise the app and entity the URI names, never a title", () => {
    const html = viewHtml("Deals")
    const script = html.split("<script>")[1]!.split("</script>")[0]!
    assert.doesNotThrow(() => new Function(script), "the view's script parses")
    assert.ok(script.includes("m.resolved") && script.includes('"unknown-app": "refUnknownApp"') && script.includes('"no-access": "noAccess"'))
    assert.ok(script.includes('m[1] + " · " + m[2]'), "a plain host: app · entity")
    assert.ok(script.includes('placeholder="clegra://…"'), "an input for another app's record takes its URI")
  })
})

/** The app's fetch with one tool's result changed: an app built some other way, and wrong. */
function changedCall(app: ReturnType<typeof dealsApp>, tool: string, change: (result: Record<string, unknown>) => void) {
  return async (request: Request): Promise<Response> => {
    const body = request.method === "POST" ? await request.clone().text() : ""
    const response = await app.fetch(request, local)
    if (!body.includes(`"name":"${tool}"`)) return response
    const raw = await response.text()
    const json = JSON.parse(response.headers.get("content-type")?.includes("text/event-stream") ? raw.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).pop()! : raw)
    change(json.result)
    return Response.json(json)
  }
}
const byId = (report: Report, id: string) => report.checks.find((c) => c.id === id)!

describe("refs across apps: conformance", () => {
  test("refs.cross and resolve.foreign pass on a good app", async () => {
    const app = dealsApp()
    const report = await checkApp({ url: "http://127.0.0.1:3961", token: await app.devToken(), fetch: (r) => app.fetch(r, local) })
    assert.ok(report.ok && report.complete, formatReport(report))
    assert.ok(!byId(report, "refs.cross").skipped && byId(report, "refs.cross").ok)
    assert.ok(byId(report, "resolve.foreign").ok)
  })

  test("refs.cross fails when the field holds a name instead of a URI", async () => {
    const app = dealsApp(() => [{ id: "d1", name: "Forty seats", customer: "Hartley Engineering" }])
    const report = await checkApp({ url: "http://127.0.0.1:3961", token: await app.devToken(), fetch: (r) => app.fetch(r, local) })
    assert.equal(byId(report, "refs.cross").ok, false)
    assert.match(byId(report, "refs.cross").detail!, /"Hartley Engineering"/)
  })

  test("refs.cross fails when the app sends a title for another app's record", async () => {
    const app = dealsApp()
    const fetch = changedCall(app, "deal_list", (r) => {
      const refs = (r.structuredContent as { refs?: Record<string, unknown> } | undefined)?.refs
      if (refs) refs.customer = { "clegra://erp/customer/42": "Hartley Engineering" }
    })
    const report = await checkApp({ url: "http://127.0.0.1:3961", token: await app.devToken(), fetch })
    assert.match(byId(report, "refs.cross").detail!, /sends refs titles for customer/)
  })

  test("resolve.foreign fails when the resolver answers for another app", async () => {
    const app = dealsApp()
    const fetch = changedCall(app, "clegra_resolve", (r) => void ((r.structuredContent as { results: { state: string }[] }).results[0]!.state = "gone"))
    const report = await checkApp({ url: "http://127.0.0.1:3961", token: await app.devToken(), fetch })
    assert.equal(byId(report, "resolve.foreign").ok, false)
  })

  test("an app without cross-app references: refs.cross is skipped, resolve.foreign still runs", async () => {
    const app = defineApp({ name: "solo", title: "S", version: "1", auth, entities: { n: { label: "N", schema: z.object({ id: z.string(), t: z.string().meta({ role: "title" }) }), get: () => null, list: () => ({ rows: [] }) } } })
    const report = await checkApp({ url: "http://127.0.0.1:3961", token: await app.devToken(), fetch: (r) => app.fetch(r, local) })
    assert.ok(report.ok && report.complete, formatReport(report))
    assert.ok(byId(report, "refs.cross").skipped)
    assert.ok(byId(report, "resolve.foreign").ok && !byId(report, "resolve.foreign").skipped)
  })
})
