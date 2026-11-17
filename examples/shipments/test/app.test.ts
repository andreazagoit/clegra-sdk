import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { describe, it } from "node:test"

import { META_KEY } from "@clegra/sdk"
import { checkApp, formatReport } from "@clegra/sdk/spec"
import { installationClient, testClient } from "@clegra/sdk/testing"

import { shipmentsAuth } from "../src/auth"
import { createCourier, createShipmentsApp, devTenant, PERMISSIONS, SHIPMENTS_PEOPLE, SHIPMENTS_SETTINGS, SHIPMENTS_URL, shipmentsManifest } from "../src/fixture"

/**
 * THE SHIPMENTS APP IN-PROCESS: `app.fetch` with the SDK's dev authority, data
 * and write store in memory. No port, no network.
 */

type Rows = { rows: Record<string, unknown>[]; total?: number; next?: string }
const rowsOf = (r: { structuredContent?: Record<string, unknown> }) => (r.structuredContent as Rows).rows
const ids = (r: { structuredContent?: Record<string, unknown> }) => rowsOf(r).map((x) => x.id)
const errorOf = (r: { structuredContent?: Record<string, unknown> }) => r.structuredContent?.error as { code: string; message: string; fields?: Record<string, string> } | undefined
const fresh = () => {
  const courier = createCourier()
  return { courier, app: createShipmentsApp({ courier }) }
}
const ALL = Object.keys(PERMISSIONS)

/** A confirmed write as a workspace host makes it: call id, proof, and the installation's settings. */
async function confirmed(app: ReturnType<typeof createShipmentsApp>, person: string, installation: string, tool: string, args: Record<string, unknown>, call = randomUUID()) {
  const client = await testClient(app, { person, permissions: person === "ada" ? "all" : SHIPMENTS_PEOPLE.find((p) => p.id === person)!.permissions, host: "workspace", installation })
  const confirmation = await app.devConfirmation({ tool, args, call, person, installation })
  return client.call(tool, args, { [META_KEY]: { call, confirmation, settings: SHIPMENTS_SETTINGS } })
}

describe("the manifest", () => {
  const manifest = createShipmentsApp().manifest()
  const entity = (name: string) => manifest.entities.find((e) => e.name === name)!
  const field = (e: string, f: string) => entity(e).fields.find((x) => x.name === f)!

  it("shipments have the namespaced kind, keyed by tracking number; pickups are events", () => {
    assert.deepEqual(manifest.entities.map((e) => [e.name, e.kind ?? null]), [
      ["shipment", "com.clegra.shipment"],
      ["pickup", "event"],
    ])
    assert.deepEqual(manifest.kinds?.["com.clegra.shipment"]?.properties.trackingNumber, { type: "string", key: true })
    assert.deepEqual([field("shipment", "trackingNumber").as, field("shipment", "trackingNumber").filter], ["trackingNumber", true])
    assert.deepEqual([field("pickup", "date").as, field("pickup", "depot").as], ["startDate", "location"])
    assert.deepEqual([field("shipment", "cost").permission, field("shipment", "cost").currency], ["shipments.prices", "EUR"])
    assert.deepEqual(
      entity("shipment").fields.filter((f) => f.untrusted).map((f) => f.name),
      ["customer", "destination"],
    )
  })

  it("writes: booking and cancelling a pickup always confirmed, the delivery check never asks and is app-only", () => {
    assert.deepEqual(
      manifest.actions.map((a) => [a.tool.name, a.readOnly, a.confirm, a.permission ?? null, a.visibility ?? null, a.tool.plain]),
      [
        ["book_pickup", false, "always", "shipments.book", null, false],
        ["pickup_cancel_pickup", false, "always", "shipments.book", null, false],
        ["check_deliveries", false, "never", "shipments.view", "app", false],
      ],
    )
    assert.deepEqual(manifest.permissions.map((p) => [p.id, p.default]), [
      ["shipments.view", true],
      ["shipments.prices", false],
      ["shipments.book", false],
    ])
    assert.deepEqual(manifest.settings.map((s) => [s.id, s.type, s.required]), [["depot", "text", true]])
  })

  it("navigation, page actions, the late badge; schedule, typed notifications, lifecycle; one agent", () => {
    assert.deepEqual(manifest.nav, [{ section: { en: "Courier", it: "Corriere" }, pages: ["shipments", "pickups", "overview"] }])
    const page = (name: string) => manifest.pages.find((p) => p.name === name)!
    assert.equal(page("shipments").badge, "late_shipments")
    assert.deepEqual([page("pickups").actions, page("overview").actions], [["book_pickup"], ["book_pickup"]])
    assert.deepEqual(manifest.schedules, [{ name: "delivery_check", action: "check_deliveries", tool: "check_deliveries", every: 15, maxSeconds: 30 }])
    assert.deepEqual(manifest.notifications?.map((n) => [n.type, n.default, n.permission]), [
      ["delivered", true, "shipments.view"],
      ["late", true, "shipments.view"],
    ])
    assert.deepEqual(manifest.lifecycle, { export: "clegra_export", delete: "clegra_delete" })
    assert.deepEqual(manifest.agents.map((a) => [a.name, a.tier]), [["logistics", "fast"]])
  })

  it("every label is in English and Italian", () => {
    const labels: Record<string, unknown>[] = []
    const walk = (v: unknown, key = "") => {
      if (Array.isArray(v)) v.forEach((x) => walk(x))
      else if (v && typeof v === "object") {
        const o = v as Record<string, unknown>
        const isLabel = Object.keys(o).length > 0 && Object.keys(o).every((k) => /^[a-z]{2}$/.test(k)) && Object.values(o).every((x) => typeof x === "string")
        if (["label", "title", "plural", "description", "section"].includes(key) && isLabel && !(key === "label" && o.en === "id" && Object.keys(o).length === 1)) labels.push(o)
        else for (const [k, x] of Object.entries(o)) walk(x, k)
      }
    }
    walk(manifest)
    assert.ok(labels.length > 40)
    assert.deepEqual(labels.filter((m) => typeof m.en !== "string" || typeof m.it !== "string"), [])
  })

  it("the fixture's manifest is the served one, for its public address", async () => {
    const { app } = fresh()
    const served = (await (await app.fetch(new Request("http://127.0.0.1/.well-known/clegra.json"), { remoteAddress: "127.0.0.1" })).json()) as Record<string, unknown>
    const { auth: servedAuth, ...rest } = served
    const { auth, ...fixture } = shipmentsManifest
    assert.deepEqual(rest, JSON.parse(JSON.stringify(fixture)))
    assert.deepEqual(auth, { resource: `${SHIPMENTS_URL}/mcp`, authorizationServers: ["https://node.example.com"] })
    assert.ok(servedAuth)
  })
})

describe("conformance", () => {
  it("passes the conformance checks, in-process", async () => {
    const { app } = fresh()
    const token = await app.devToken({ person: "ada", permissions: "all", installation: "conformance" })
    const report = await checkApp({ url: "http://127.0.0.1:4319", token, fetch: (request: Request) => app.fetch(request, { remoteAddress: "127.0.0.1" }) })
    assert.ok(report.ok && report.complete, formatReport(report))
    const skipped = report.checks.filter((c) => c.skipped).map((c) => c.id)
    // No same-site pages (no embed), no references to other apps' records.
    assert.deepEqual(skipped.sort(), ["embed.frame-ancestors", "embed.ticket", "refs.cross"].sort(), formatReport(report))
  })
})

describe("lists, records, search and money", () => {
  it("shipments by status, by tracking number (the kind's key), by words; pages", async () => {
    const { app } = fresh()
    const c = await testClient(app, { person: "ada", permissions: "all", installation: "lists" })
    assert.deepEqual(ids(await c.call("shipment_list", { status: "late" })), ["AC1002"])
    assert.deepEqual(ids(await c.call("shipment_list", { trackingNumber: "AC1003" })), ["AC1003"])
    assert.deepEqual(ids(await c.call("shipment_list", { trackingNumber: { in: ["AC1001", "AC1005"] }, sort: "trackingNumber" })), ["AC1001", "AC1005"])
    assert.deepEqual(ids(await c.call("shipment_list", { expectedDelivery: { gte: "2026-11-12", lte: "2026-11-18" }, sort: "expectedDelivery" })), ["AC1005", "AC1001"])
    assert.deepEqual(ids(await c.call("shipment_list", { query: "bristol" })), ["AC1002"])
    const first = (await c.call("shipment_list", { limit: 2 })).structuredContent as Rows
    assert.deepEqual([first.rows.length, first.total, first.next], [2, 5, "2"])
    assert.equal(rowsOf(await c.call("shipment_list", { limit: 2, cursor: "4" })).length, 1)
    const found = (await c.call("search", { query: "harbor" })).structuredContent as { results: { id: string; kind?: string }[] }
    assert.deepEqual(found.results.map((r) => r.kind), ["com.clegra.shipment"])
  })

  it("who may not see the costs gets none, and can't sort by them; nor book a pickup", async () => {
    const { app } = fresh()
    const bruno = await testClient(app, { person: "bruno", permissions: ["shipments.view"], installation: "money" })
    assert.ok(rowsOf(await bruno.call("shipment_list", {})).every((r) => !("cost" in r)))
    assert.equal("cost" in ((await bruno.call("shipment_get", { id: "AC1001" })).structuredContent!.record as Record<string, unknown>), false)
    assert.equal((await bruno.call("shipment_list", { sort: "cost" })).isError, true)
    const tools = (await bruno.listTools()).map((t) => t.name)
    assert.ok(!tools.includes("show_shipping_costs") && !tools.includes("book_pickup"))
    const ada = await testClient(app, { person: "ada", permissions: "all", installation: "money" })
    assert.equal((await ada.call("show_shipping_costs", {})).isError, undefined)
  })

  it("tenants are apart: a pickup booked in one installation is not in another", async () => {
    const { app } = fresh()
    const made = await confirmed(app, "ada", "one", "book_pickup", { date: "2030-01-15", parcels: 2 })
    assert.equal(made.isError, undefined, JSON.stringify(made))
    const other = await testClient(app, { person: "ada", permissions: "all", installation: "two" })
    assert.deepEqual(ids(await other.call("pickup_list", {})), ["PK1"])
  })
})

describe("pickups, each confirmed by the person", () => {
  it("a pickup waits for the confirmation, is booked once per call id, from the installation's depot, by its author", async () => {
    const { app, courier } = fresh()
    const workspace = await testClient(app, { person: "ada", permissions: "all", host: "workspace", installation: "pickups" })
    assert.equal(errorOf(await workspace.call("book_pickup", { date: "2030-01-15", parcels: 3 }))?.code, "confirmation_required")
    const call = randomUUID()
    const made = await confirmed(app, "ada", "pickups", "book_pickup", { date: "2030-01-15", parcels: 3, note: "Ring at the back door" }, call)
    assert.equal(made.isError, undefined, JSON.stringify(made))
    const again = await confirmed(app, "ada", "pickups", "book_pickup", { date: "2030-01-15", parcels: 3, note: "Ring at the back door" }, call)
    assert.deepEqual(again.structuredContent, made.structuredContent)
    assert.deepEqual(courier.pickups(devTenant("pickups")).map((p) => [p.id, p.status, p.depot, p.bookedBy ?? null]), [
      ["PK1", "done", "North depot", null],
      ["PK2", "booked", "North depot", "ada"],
    ])
    const record = await workspace.call("pickup_get", { id: "PK2" })
    assert.equal((record.structuredContent!.record as { bookedBy: string }).bookedBy, "ada")
    assert.match(JSON.stringify(record.structuredContent), /Ada Rossi/)
  })

  it("refuses a past date, a missing depot, and a second cancellation", async () => {
    const { app } = fresh()
    const past = await confirmed(app, "ada", "refusals", "book_pickup", { date: "2020-01-01", parcels: 1 })
    assert.deepEqual([errorOf(past)?.code, Object.keys(errorOf(past)?.fields ?? {})], ["invalid_input", ["date"]])
    const client = await testClient(app, { person: "ada", permissions: "all", host: "workspace", installation: "refusals" })
    const args = { date: "2030-01-15", parcels: 1 }
    const call = randomUUID()
    const noDepot = await client.call("book_pickup", args, { [META_KEY]: { call, confirmation: await app.devConfirmation({ tool: "book_pickup", args, call, person: "ada", installation: "refusals" }) } })
    assert.match(errorOf(noDepot)?.message ?? "", /depot is not set/)
    const booked = await confirmed(app, "ada", "refusals", "book_pickup", args)
    assert.equal(booked.isError, undefined, JSON.stringify(booked))
    const cancelled = await confirmed(app, "ada", "refusals", "pickup_cancel_pickup", { id: "PK2" })
    assert.equal(cancelled.isError, undefined, JSON.stringify(cancelled))
    assert.equal(errorOf(await confirmed(app, "ada", "refusals", "pickup_cancel_pickup", { id: "PK2" }))?.code, "conflict")
    assert.equal(errorOf(await confirmed(app, "ada", "refusals", "pickup_cancel_pickup", { id: "PK1" }))?.code, "conflict")
  })
})

describe("the delivery check: a schedule with typed notifications", () => {
  it("tells whoever sees shipments of each delivery and delay, once", async () => {
    const { app, courier } = fresh()
    const host = await installationClient(app, { installation: "deliveries", permissions: ["shipments.view"] })
    const quiet = await host.schedule("delivery_check", SHIPMENTS_SETTINGS)
    assert.equal(quiet.isError, undefined, JSON.stringify(quiet))
    assert.equal(((quiet._meta?.[META_KEY] as { notifications?: unknown[] } | undefined)?.notifications ?? []).length, 0)

    courier.report(devTenant("deliveries"), "AC1001", "delivered", "2026-11-17")
    courier.report(devTenant("deliveries"), "AC1004", "late")
    const run = await host.schedule("delivery_check", SHIPMENTS_SETTINGS)
    const sent = (run._meta?.[META_KEY] as { notifications: { type: string; uri: string; to: unknown; title: string }[] }).notifications
    assert.deepEqual(
      sent.map((n) => [n.type, n.uri, n.to]),
      [
        ["delivered", "clegra://shipments/shipment/AC1001", { permission: "shipments.view" }],
        ["late", "clegra://shipments/shipment/AC1004", { permission: "shipments.view" }],
      ],
    )
    const again = await host.schedule("delivery_check", SHIPMENTS_SETTINGS)
    assert.equal(((again._meta?.[META_KEY] as { notifications?: unknown[] } | undefined)?.notifications ?? []).length, 0)
  })

  it("is the host's machinery: no person may run it as a schedule, no model sees it", async () => {
    const { app } = fresh()
    const ada = await testClient(app, { person: "ada", permissions: "all", host: "workspace", installation: "deliveries" })
    assert.equal(errorOf(await ada.schedule("delivery_check"))?.code, "permission_denied")
    const tool = (await ada.listTools()).find((t) => t.name === "check_deliveries")
    assert.deepEqual((tool?._meta?.ui as { visibility?: string[] } | undefined)?.visibility, ["app"])
  })
})

describe("pages and fragments", () => {
  it("the shipments page's badge counts the late ones; the dashboards draw; the pickups page offers «Book a pickup»", async () => {
    const { app } = fresh()
    const c = await testClient(app, { person: "ada", permissions: "all", host: "workspace", installation: "pages", locale: "it" })
    const page = await c.call("open_pickups", {})
    const view = (page.structuredContent as { view: { actions?: { tool: string }[]; nav?: { pages: { name: string; badge?: string }[] }[] } }).view
    assert.deepEqual(view.actions?.map((a) => a.tool), ["book_pickup"])
    assert.deepEqual(view.nav?.[0]?.pages.map((p) => [p.name, p.badge ?? null]), [
      ["shipments", "show_late_shipments"],
      ["pickups", null],
      ["overview", null],
    ])
    assert.equal(((await c.call("show_late_shipments", {})).structuredContent!.data as { value: number }).value, 1)
    const overview = await c.call("open_overview", {})
    assert.equal(overview.isError, undefined, JSON.stringify(overview))
    const chart = (await c.call("show_shipments_by_status", {})).structuredContent!.data as { points: { label: string; value: number }[] }
    assert.deepEqual(chart.points, [
      { label: "In transito", value: 2 },
      { label: "In ritardo", value: 1 },
      { label: "Consegnata", value: 2 },
    ])
  })
})

describe("the lifecycle", () => {
  it("the tenant's data exported, then deleted once; a second delete finds nothing", async () => {
    const { app } = fresh()
    await confirmed(app, "ada", "leaving", "book_pickup", { date: "2030-02-01", parcels: 1 })
    const host = await installationClient(app, { installation: "leaving" })
    const { file } = await host.exportData()
    assert.ok(file)
    const data = JSON.parse(file.body.toString("utf8")) as { shipments: unknown[]; pickups: { id: string }[]; people: Record<string, string> }
    assert.deepEqual([data.shipments.length, data.pickups.map((p) => p.id), data.people], [5, ["PK1", "PK2"], { ada: "Ada Rossi" }])
    assert.deepEqual(((await host.call("clegra_delete", {})).structuredContent as { counts: Record<string, number> }).counts, { shipments: 5, pickups: 2 })
    assert.deepEqual(((await host.call("clegra_delete", {})).structuredContent as { counts: Record<string, number> }).counts, { shipments: 0, pickups: 0 })
    assert.equal((await host.exportData()).file, null)
    const plain = await testClient(app, { person: "ada", permissions: "all", installation: "leaving" })
    assert.ok(!(await plain.listTools()).some((t) => ["clegra_export", "clegra_delete"].includes(t.name)))
  })
})

describe("who may call", () => {
  it("one public address and one or more nodes, each named once", () => {
    assert.deepEqual(shipmentsAuth({ SHIPMENTS_PUBLIC_URL: "https://shipments.example.com/", CLEGRA_ISSUERS: "https://a.example.com, https://b.example.com|https://b.example.com/keys" }), {
      resource: "https://shipments.example.com/mcp",
      issuers: [{ issuer: "https://a.example.com" }, { issuer: "https://b.example.com", jwksUri: "https://b.example.com/keys" }],
    })
    assert.throws(() => shipmentsAuth({ CLEGRA_ISSUERS: "https://a.example.com" }), /SHIPMENTS_PUBLIC_URL is not set/)
    assert.throws(() => shipmentsAuth({ SHIPMENTS_PUBLIC_URL: "https://s.example.com" }), /CLEGRA_ISSUERS is not set/)
    assert.throws(() => shipmentsAuth({ SHIPMENTS_PUBLIC_URL: "https://s.example.com?x=1", CLEGRA_ISSUERS: "https://a.example.com" }), /query or a fragment/)
    assert.throws(() => shipmentsAuth({ SHIPMENTS_PUBLIC_URL: "https://s.example.com", CLEGRA_ISSUERS: "https://a.example.com,https://a.example.com" }), /named twice/)
    assert.deepEqual(ALL, ["shipments.view", "shipments.prices", "shipments.book"])
  })
})
