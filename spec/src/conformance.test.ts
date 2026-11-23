import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, describe, test } from "node:test"

import type { McpServer } from "@modelcontextprotocol/server"
import { z } from "zod"

import { defineApp, MemoryStore, type AuthOptions } from "../../src/index"
import { deviceKey, testCore } from "../../src/testing"
import { checkApp, type ClegraCaller, type Report } from "./conformance"

/** The checks of app-only items, the installation's tools and the manifest's new rules, from outside. */

const keyFile = join(tmpdir(), `clegra-conformance-key-${randomUUID()}.json`)
after(() => rmSync(keyFile, { force: true }))
const local = { remoteAddress: "127.0.0.1" }

function makeApp(options: { full?: boolean; mcp?: (server: McpServer) => void } = {}) {
  const full = options.full !== false
  return defineApp({
    name: "checked",
    title: "Checked",
    version: "1.0.0",
    auth: { dev: { keyFile, code: "CONF1" } } as AuthOptions,
    ...(options.mcp ? { mcp: options.mcp } : {}),
    entities: {
      task: { label: "Task", schema: z.object({ id: z.string(), title: z.string().meta({ role: "title", search: true }) }), get: (id) => (id === "t1" ? { id: "t1", title: "Plan" } : null), list: () => ({ rows: [{ id: "t1", title: "Plan" }] }) },
      ...(full ? { log: { label: "Log", visibility: "app" as const, schema: z.object({ id: z.string(), line: z.string().meta({ role: "title", search: true }) }), get: () => ({ id: "l1", line: "Plan opened" }), list: () => ({ rows: [{ id: "l1", line: "Plan opened" }] }) } } : {}),
    },
    actions: {
      add: { title: "Add", input: z.object({ title: z.string() }), confirm: false, run: () => {} },
      ...(full ? { send: { title: "Send", input: z.object({ when: z.iso.datetime() }), later: { at: "when" }, run: () => {} }, refresh: { title: "Refresh", input: z.object({}), readOnly: true, visibility: "app" as const, run: () => {} } } : {}),
    },
    pages: { tasks: { title: "Tasks", list: "task", columns: ["title"], actions: ["add"] } },
    nav: [{ pages: ["tasks"] }],
    ...(full ? { lifecycle: { export: () => null, delete: () => {} } } : {}),
  })
}

const byId = (report: Report, id: string) => report.checks.find((c) => c.id === id)!
const run = async (app: ReturnType<typeof makeApp>, alter?: (manifest: Record<string, unknown>) => void) => {
  const fetch = async (request: Request) => {
    const response = await app.fetch(request, local)
    if (!alter || !request.url.endsWith("/.well-known/clegra.json")) return response
    const manifest = (await response.json()) as Record<string, unknown>
    alter(manifest)
    return new Response(JSON.stringify(manifest), { status: 200, headers: { "content-type": "application/json" } })
  }
  return checkApp({ url: "http://127.0.0.1:3930", fetch, token: await app.devToken() })
}

describe("conformance: app-only items and the installation's tools", () => {
  test("an app with app-only items, later runs and lifecycle tools passes; the checks ran", async () => {
    const report = await run(makeApp())
    for (const id of ["manifest.references", "mcp.visibility", "lifecycle.hidden"]) {
      const c = byId(report, id)
      assert.equal(c.ok, true, `${id}: ${c.detail}`)
      assert.equal(c.skipped, undefined, id)
    }
    assert.equal(report.ok, true, JSON.stringify(report.checks.filter((c) => !c.ok)))
    assert.equal(report.complete, true)
  })

  test("an app without them: both checks are skipped, and the report stays complete", async () => {
    const report = await run(makeApp({ full: false }))
    assert.equal(byId(report, "mcp.visibility").skipped, true)
    assert.equal(byId(report, "lifecycle.hidden").skipped, true)
    assert.equal(report.ok && report.complete, true)
  })

  test("a tool the manifest says is app-only but a model is given fails mcp.visibility", async () => {
    const report = await run(makeApp(), (m) => {
      const entities = m.entities as { name: string; visibility?: string }[]
      entities.find((e) => e.name === "task")!.visibility = "app"
    })
    const c = byId(report, "mcp.visibility")
    assert.equal(c.ok, false)
    assert.match(c.detail!, /task_list \(entity "task"\): _meta\.ui\.visibility is \["model","app"\], not \["app"\]/)
    assert.match(c.detail!, /search: answers with records of task, which is app-only/)
  })

  test("an installation tool listed to a plain caller fails lifecycle.hidden", async () => {
    const report = await run(makeApp({ mcp: (server) => void server.registerTool("clegra_export", { description: "Leaks", inputSchema: z.object({}) }, async () => ({ content: [] })) }))
    const c = byId(report, "lifecycle.hidden")
    assert.equal(c.ok, false)
    assert.match(c.detail!, /clegra_export is listed to a plain caller/)
  })

  test("the manifest's new rules are part of manifest.references", async () => {
    const report = await run(makeApp(), (m) => {
      m.nav = [{ pages: ["nowhere"] }]
      ;(m.schedules as unknown[]).length = 0
    })
    const c = byId(report, "manifest.references")
    assert.equal(c.ok, false)
    assert.match(c.detail!, /nav section 1: "nowhere" is not a page of this app/)
    assert.match(c.detail!, /actions with later need the schedule "clegra_later"/)
  })

  test("a publisher that is not well-formed fails manifest.references; one that is passes", async () => {
    const bad = byId(await run(makeApp(), (m) => void (m.publisher = { name: "Example", url: "http://example.com/about" })), "manifest.references")
    assert.equal(bad.ok, false)
    assert.match(bad.detail!, /publisher: url "http:\/\/example.com\/about" is not an absolute https address/)
    const extra = byId(await run(makeApp(), (m) => void (m.publisher = { name: "Example", url: "https://example.com", verified: true })), "manifest.schema")
    assert.equal(extra.ok, false, "publisher has exactly name and url")
    const good = byId(await run(makeApp(), (m) => void (m.publisher = { name: "Example Software Ltd", url: "https://example.com" })), "manifest.references")
    assert.equal(good.ok, true, good.detail)
  })

  test("an accent outside the palette fails manifest.schema; a palette name passes", async () => {
    const colour = byId(await run(makeApp(), (m) => void (m.accent = "#FF5F1F")), "manifest.schema")
    assert.equal(colour.ok, false)
    assert.match(colour.detail!, /\/accent/)
    const good = await run(makeApp(), (m) => void (m.accent = "teal"))
    assert.equal(byId(good, "manifest.schema").ok, true)
    assert.equal(byId(good, "manifest.references").ok, true)
  })
})

describe("conformance: an app in the trusted-issuer mode, checked as a Clegra caller", async () => {
  const RES = "https://deals.test/mcp"
  const core = await testCore({ resource: RES })
  const company = "co-conformance"

  /** «Deals», trusting Clegra's core alone: no authorization server of its own; one sensitive write on a record, one not. */
  function dealsApp(options: { unguarded?: boolean } = {}) {
    const deals = new Map([["d1", { id: "d1", title: "Fiber for the new office", amount: 1200 }]])
    const ran: string[] = []
    const app = defineApp({
      name: "deals",
      title: "Deals",
      version: "1.0.0",
      store: new MemoryStore(),
      auth: { resource: RES, clegra: core.options() },
      permissions: { "deals.view": { label: "See deals", default: true }, "deals.edit": { label: "Change deals" } },
      entities: {
        deal: {
          label: "Deal",
          permission: "deals.view",
          schema: z.object({ id: z.string(), title: z.string().meta({ role: "title", search: true }), amount: z.number() }),
          get: (id) => deals.get(id) ?? null,
          list: () => ({ rows: [...deals.values()] }),
        },
      },
      actions: {
        add_deal: { title: "Add a deal", input: z.object({ title: z.string().min(3), amount: z.number().int().min(10) }), confirm: options.unguarded ? false : "always", permission: "deals.edit", run: (input) => void ran.push(`add ${input.title}`) },
        close_deal: { on: "deal", title: "Close", input: z.object({}), confirm: "always", permission: "deals.edit", run: (_input, _ctx, deal) => void ran.push(`close ${deal.id}`) },
        rename_deal: { on: "deal", title: "Rename", input: z.object({ title: z.string() }), confirm: false, permission: "deals.edit", run: () => {} },
      },
      pages: { deals: { title: "Deals", list: "deal", columns: ["title"] } },
    })
    return { app, ran }
  }
  const fetchOf = (app: ReturnType<typeof dealsApp>["app"]) => (request: Request) => app.fetch(request, { remoteAddress: "203.0.113.7" })
  /** A company administrator from a Clegra client (no actor). */
  const person = async (): Promise<ClegraCaller> => {
    const device = await deviceKey()
    return { token: () => core.appToken({ company, sub: "pw-ada", role: "admin", device }), proof: device.proof }
  }
  /** Clegra's agent for that person on a server: one delegated token per call, the person's device confirming. */
  const agent = async (): Promise<ClegraCaller> => {
    const node = await deviceKey()
    const phone = await deviceKey()
    return {
      token: () => core.appToken({ company, sub: "pw-ada", role: "admin", device: node, act: "server:node-1", personJkt: phone.jkt }),
      proof: node.proof,
      confirmation: async ({ tool, args }) => {
        const token = await core.confirmation({ company, sub: "pw-ada", tool, args, device: phone })
        return { token, proof: await phone.confirm(token) }
      },
    }
  }

  test("auth.mcp takes protected-resource metadata without an authorization server; every check passes and the report is complete", async () => {
    const { app, ran } = dealsApp()
    const report = await checkApp({ url: "https://deals.test", fetch: fetchOf(app), clegra: await person() })
    assert.deepEqual(report.checks.filter((c) => !c.ok).map((c) => `${c.id}: ${c.detail}`), [])
    assert.equal(report.complete, true)
    assert.equal(byId(report, "auth.mcp").skipped, undefined)
    assert.equal(byId(report, "mcp.tools").ok, true, "the writes a plain client is not given are a person's to see")
    const confirm = byId(report, "mcp.confirm")
    assert.equal(confirm.skipped, undefined, confirm.detail)
    assert.deepEqual(ran, [], "the person's call without _meta.clegra.confirmed ran nothing")
  })

  test("an agent: refused without a confirmation and with one of other arguments, run with the core's confirmation of its own", async () => {
    const { app, ran } = dealsApp()
    const report = await checkApp({ url: "https://deals.test", fetch: fetchOf(app), clegra: await agent() })
    assert.deepEqual(report.checks.filter((c) => !c.ok).map((c) => `${c.id}: ${c.detail}`), [])
    assert.equal(byId(report, "mcp.confirm").skipped, undefined)
    assert.deepEqual(ran.sort(), ["add conformance", "close d1"])
  })

  test("a sensitive write that runs without a confirmation fails mcp.confirm", async () => {
    const { app } = dealsApp({ unguarded: true })
    const report = await run2(app, (m) => {
      for (const a of m.actions as { name: string; confirm: string }[]) if (a.name === "add_deal") a.confirm = "always"
    })
    const c = byId(report, "mcp.confirm")
    assert.equal(c.ok, false)
    assert.match(c.detail!, /add_deal: ran without a confirmation/)
  })

  test("without a Clegra caller the app's MCP checks don't run; with only its own authorization server missing it is not conformant", async () => {
    const { app } = dealsApp()
    const report = await checkApp({ url: "https://deals.test", fetch: fetchOf(app) })
    assert.equal(byId(report, "auth.mcp").ok, true)
    assert.equal(report.complete, false)
    const plain = await checkApp({ url: "https://deals.test", fetch: async (request) => {
      const response = await fetchOf(app)(request)
      if (!request.url.endsWith("/.well-known/clegra.json")) return response
      const m = (await response.json()) as Record<string, unknown>
      delete m.events
      delete m.rolesTool
      return Response.json(m)
    } })
    assert.match(byId(plain, "auth.mcp").detail ?? "", /names no authorization server/)
  })

  async function run2(app: ReturnType<typeof dealsApp>["app"], alter: (manifest: Record<string, unknown>) => void) {
    const fetch = async (request: Request) => {
      const response = await fetchOf(app)(request)
      if (!request.url.endsWith("/.well-known/clegra.json")) return response
      const manifest = (await response.json()) as Record<string, unknown>
      alter(manifest)
      return Response.json(manifest)
    }
    return checkApp({ url: "https://deals.test", fetch, clegra: await person() })
  }
})
