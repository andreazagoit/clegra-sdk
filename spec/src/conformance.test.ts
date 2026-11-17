import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, describe, test } from "node:test"

import type { McpServer } from "@modelcontextprotocol/server"
import { z } from "zod"

import { defineApp, type AuthOptions } from "../../src/index"
import { checkApp, type Report } from "./conformance"

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
})
