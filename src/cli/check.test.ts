import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { z } from "zod"

import { defineApp } from "../app"
import { defineAgent, defineBadge, defineEntity, definePage, defineTool, defineWidget } from "../define"
import { serve, type ServeOptions } from "../server"
import { devSignIn } from "../signin/dev"
import { MemoryStore } from "../store"
import { checkApp, formatReport } from "./check"

const ORIGIN = "http://localhost:3000"
type Job = { id: string; title: string; status: "open" | "done"; customer: string }

function fixture(options: { link?: boolean; mcp?: ServeOptions["mcp"] } = {}) {
  const jobs = new Map<string, Job>([["1", { id: "1", title: "Replace boiler", status: "open", customer: "Harbor Supplies Ltd" }]])
  const job = defineEntity({
    name: "job",
    title: "Job",
    path: "/jobs/{id}",
    schema: z.object({ id: z.string(), title: z.string(), status: z.enum(["open", "done"]), customer: z.string() }),
    card: { title: "title", subtitle: "customer", status: "status" },
    get: ({ id }) => jobs.get(id!) ?? null,
  })
  const open = defineBadge({ name: "open", value: () => [...jobs.values()].filter((j) => j.status === "open").length })
  const jobsPage = definePage({ name: "jobs", title: "Jobs", path: "/jobs{?status}", role: "list", entity: job, badge: open })
  const jobPage = definePage({ name: "job", title: "Job", path: "/jobs/{id}", role: "record", entity: job })
  const getJob = defineTool({ name: "job.get", title: "Get job", description: "One job", input: z.object({ id: z.string() }), annotations: { readOnly: true }, entity: job, on: "record", page: jobPage, run: (_i, _c, record) => ({ data: record }) })
  const listJobs = defineTool({ name: "job.list", title: "List jobs", description: "Jobs", input: z.object({}), annotations: { readOnly: true }, entity: job, page: jobsPage, run: () => ({ records: [...jobs.values()].map((record) => ({ entity: job, record })) }) })
  const complete = defineTool({ name: "job.complete", title: "Complete", description: "Closes a job", input: z.object({ id: z.string() }), annotations: { readOnly: false, destructive: false, idempotent: true }, entity: job, on: "record", run: (_i, _c, record) => ((record.status = "done"), { records: [{ entity: job, record }] }) })
  let sent = 0
  const send = defineTool({
    name: "job.send_report",
    title: "Send report",
    description: "Sends the report",
    input: z.object({ id: z.string() }),
    annotations: { readOnly: false, destructive: false, openWorld: true },
    entity: job,
    on: "record",
    confirm: { message: (_i, _c, r) => `Send the report of ${r.title}?` },
    run: () => ({ data: { sent: ++sent } }),
  })
  const create = defineTool({ name: "job.create", title: "New job", description: "Creates", input: z.strictObject({ title: z.string() }), annotations: { readOnly: false, destructive: false }, entity: job, accepts: [{ type: "message", title: "New job", map: { title: "headline" } }], run: () => ({}) })
  const tile = defineWidget({ name: "open-jobs", title: "Open jobs", sizes: ["small"], data: () => ({ title: "Open jobs", value: 1 }) })
  const agent = defineAgent({ name: "triage", description: "Sorts jobs", instructions: "Look.", tools: [listJobs, getJob], starters: ["What is open?"], schedules: [{ name: "m", cron: "0 8 * * 1", starter: 0 }] })
  const app = defineApp({
    name: "jobs",
    title: "Jobs",
    description: "Job requests",
    version: "1.0.0",
    entities: [job],
    tools: [getJob, listJobs, complete, send, create],
    pages: [jobsPage, jobPage],
    badges: [open],
    widgets: [tile],
    agents: [agent],
    notifications: { "job.assigned": { title: "Assigned" } },
    sessionTransfer: { link: options.link ?? false },
  })
  const signIn = devSignIn(app, { issuer: ORIGIN, people: [{ id: "ada", name: "Ada" }], code: "CODE1234" })
  const served = serve(app, { origin: ORIGIN, auth: { signIn }, store: new MemoryStore(), confirmWaitMs: 0, ...(options.mcp ? { mcp: options.mcp } : {}) })
  const fetch = (input: string, init?: RequestInit) => served.fetch(new Request(input, init))
  return { served, signIn, fetch, sent: () => sent, jobs }
}

const confirmCall = { tool: "job.send_report", arguments: { id: "1" } }

describe("clegra check", () => {
  test("a conforming app reaches A, B1, B2 and C, and nothing is run or confirmed", async () => {
    const f = fixture({ link: true })
    const report = await checkApp({ url: ORIGIN, token: await f.signIn.dev.token({ person: "ada" }), readToken: await f.signIn.dev.token({ person: "ada", scopes: ["web.read"] }), confirmCall, fetch: f.fetch })
    const failed = report.checks.filter((c) => c.ok === false)
    assert.deepEqual(failed, [], formatReport(report))
    assert.deepEqual(report.levels, ["A", "B1", "B2", "C"])
    assert.equal(report.origin, ORIGIN)
    assert.equal(report.mcpUrl, `${ORIGIN}/mcp`)
    assert.ok(report.checks.some((c) => c.id === "C.link-mode" && c.ok === true))
    assert.ok(report.checks.some((c) => c.id === "agents" && c.ok === true))
    assert.ok(report.checks.some((c) => c.id === "events" && c.ok === true))
    assert.ok(report.checks.some((c) => c.id === "share" && c.ok === true))
    assert.ok(report.checks.some((c) => c.id === "A.record-round-trip" && c.ok === true))
    assert.match(report.checks.find((c) => c.id === "A.irreversible")!.message, /job\.send_report/)
    assert.equal(f.sent(), 0, "the confirmed call never ran")
    assert.equal(f.jobs.get("1")!.status, "open", "the step-up check changed nothing")
    const text = formatReport(report)
    assert.match(text, /Level A\n {2}ok {4}A\.server-card/)
    assert.match(text, /Levels reached: A, B1, B2, C$/)
  })

  test("without --confirm-call and --read-token the level stops at A (and C)", async () => {
    const f = fixture()
    const report = await checkApp({ url: `${ORIGIN}/mcp`, token: await f.signIn.dev.token({ person: "ada" }), fetch: f.fetch })
    assert.deepEqual(report.levels, ["A", "C"])
    assert.equal(report.checks.find((c) => c.id === "B1.confirmation")?.ok, "skipped")
    assert.equal(report.checks.find((c) => c.id === "B2.step-up")?.ok, "skipped")
    assert.ok(report.ok)
  })

  test("a token without bound_browser_session does not reach C", async () => {
    const f = fixture()
    const report = await checkApp({ url: ORIGIN, token: await f.signIn.dev.token({ person: "ada", scopes: ["web.read", "web.write", "web.irreversible"] }), fetch: f.fetch })
    assert.ok(!report.levels.includes("C"))
    assert.equal(report.checks.find((c) => c.id === "C.bound-code")?.ok, false)
  })

  test("a tool whose page is on another origin fails the map (ORG-2) and the level", async () => {
    const f = fixture({
      mcp: (server) => {
        server.registerTool("bad.open", { title: "Bad", description: "Bad", inputSchema: z.object({}), annotations: { readOnlyHint: true }, _meta: { "com.clegra/web-map": { on: "collection", page: "https://evil.example/{x}" } } }, async () => ({ content: [] }))
      },
    })
    const report = await checkApp({ url: ORIGIN, token: await f.signIn.dev.token({ person: "ada" }), fetch: f.fetch })
    const map = report.checks.find((c) => c.id === "A.tool-map")!
    assert.equal(map.ok, false)
    assert.match(map.message, /bad\.open: page https:\/\/evil\.example\/\{x\} is not on/)
    assert.match(map.message, /MAP-2/)
    assert.deepEqual(report.levels, [])
    assert.equal(report.ok, false)
  })

  test("a Server Card with more than what is public, and no catalog, fail ORG-5 and ORG-1", async () => {
    const f = fixture()
    const fetch = async (input: string, init?: RequestInit) => {
      if (input.endsWith("/mcp/server-card")) return new Response(JSON.stringify({ name: "x", tools: [], remotes: [] }), { headers: { "content-type": "application/json" } })
      if (input.endsWith("/.well-known/ai-catalog.json")) return new Response("nope", { status: 404 })
      return f.fetch(input, init)
    }
    const report = await checkApp({ url: ORIGIN, token: await f.signIn.dev.token({ person: "ada" }), fetch })
    const card = report.checks.find((c) => c.id === "A.server-card")!
    assert.equal(card.ok, false)
    assert.match(card.message, /media type/)
    assert.match(card.message, /tools \(ORG-5\)/)
    assert.equal(report.checks.find((c) => c.id === "A.ai-catalog")?.ok, false)
    assert.ok(!report.levels.includes("A"))
  })
})
