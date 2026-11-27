import assert from "node:assert/strict"
import { createHash, randomBytes } from "node:crypto"
import { createServer, type Server } from "node:http"
import { after, before, describe, test } from "node:test"

import { chromium, type Browser } from "playwright"
import { z } from "zod"

import { defineApp, defineEntity, defineTool, MemoryStore, serve } from "../src/index"
import { listen } from "../src/node"
import { devSignIn } from "../src/signin"
import { testClient } from "../src/testing"

// IN A REAL CHROMIUM: what a unit test cannot see, the browser's own rules on the SDK's pages. Chromium checks a
// page's CSP `form-action` on every redirect of a form's navigation, so the consent's «Allow» (a POST answered by a
// 303 to the client's redirect_uri on another origin) must reach that address, and «Deny» too; the confirmation page
// confirms in the browser. The app listens on localhost, the client's callback on 127.0.0.1 (another origin).
// Run: npm run test:browser (needs Playwright's Chromium: npx playwright install chromium).

const CODE = "BROWSER1"
const CLIENT_ID = "https://client.example.test/clegra-browser.json"
const verifier = randomBytes(32).toString("base64url")
const challenge = createHash("sha256").update(verifier).digest("base64url")

type Job = { id: string; title: string }
const jobs = new Map<string, Job>([["1", { id: "1", title: "Replace boiler" }]])
const job = defineEntity({
  name: "job",
  title: "Job",
  description: "A job",
  path: "/jobs/{id}",
  schema: z.object({ id: z.string(), title: z.string() }),
  card: { title: "title" },
  get: ({ id }) => jobs.get(id ?? "") ?? null,
})
let sent = 0
const sendReport = defineTool({
  name: "job.send_report",
  title: "Send report",
  description: "Sends the job's report",
  input: z.object({ id: z.string() }),
  annotations: { readOnly: false, destructive: false, openWorld: true },
  entity: job,
  on: "record",
  confirm: { message: (_i, _c, r) => `Send the report of «${r.title}»?` },
  run: () => ({ data: { sent: ++sent } }),
})
const app = defineApp({ name: "jobs", title: "Jobs", description: "Job requests", version: "1.0.0", entities: [job], tools: [sendReport] })

let browser: Browser
let appServer: { url: string; close: () => Promise<void> }
let clientServer: Server
let callback = ""
let origin = ""
let served: ReturnType<typeof serve>
let signIn: ReturnType<typeof devSignIn>

before(async () => {
  // The client's redirect_uri: another origin, answering a page with what it received.
  clientServer = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" })
    res.end(`<!doctype html><title>callback</title><p id="q">${new URL(req.url ?? "/", "http://x").search.replace(/[<>&"]/g, "")}</p>`)
  })
  await new Promise<void>((resolve) => clientServer.listen(0, "127.0.0.1", resolve))
  const address = clientServer.address()
  callback = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/api/apps/link/callback`

  // The app on localhost: a free port first, then the origin the sign-in and the pages are made for.
  const probe = createServer()
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve))
  const port = (probe.address() as { port: number }).port
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  origin = `http://localhost:${port}`
  const clientMetadata = {
    fetch: (async (input: RequestInfo | URL) => (String(input) === CLIENT_ID ? Response.json({ client_id: CLIENT_ID, client_name: "Browser test", redirect_uris: [callback] }) : new Response("no", { status: 404 }))) as typeof fetch,
    lookup: async () => ["93.184.215.14"],
  }
  signIn = devSignIn(app, { issuer: origin, code: CODE, people: [{ id: "ada", name: "Ada" }], clientMetadata })
  served = serve(app, { origin, auth: { signIn }, store: new MemoryStore(), confirmWaitMs: 0 })
  appServer = await listen(served, { port, host: "localhost", log: false })
  browser = await chromium.launch()
})

after(async () => {
  await browser?.close()
  await appServer?.close()
  await new Promise<void>((resolve) => (clientServer ? clientServer.close(() => resolve()) : resolve()))
})

const authorizeUrl = () =>
  `${origin}/oauth/authorize?${new URLSearchParams({ response_type: "code", client_id: CLIENT_ID, redirect_uri: callback, state: "s1", code_challenge: challenge, code_challenge_method: "S256", resource: `${origin}/mcp` })}`

async function consentPage() {
  const context = await browser.newContext()
  const page = await context.newPage()
  const violations: string[] = []
  page.on("console", (m) => {
    if (/Content Security Policy|form-action/i.test(m.text())) violations.push(m.text())
  })
  await page.goto(authorizeUrl())
  // The development sign-in, then back to the same request: the consent.
  await page.fill("#code", CODE)
  await Promise.all([page.waitForURL((u) => u.pathname === "/oauth/authorize"), page.click("button[type=submit]")])
  return { context, page, violations }
}

describe("in Chromium", () => {
  test("the consent's «Allow» reaches the client's redirect_uri on another origin with the code", async () => {
    const { context, page, violations } = await consentPage()
    const csp = (await page.request.get(page.url())).headers()["content-security-policy"] ?? ""
    assert.match(csp, new RegExp(`form-action 'self' ${new URL(callback).origin.replace(/[.]/g, "\\.")}(;|$)`))
    await Promise.all([page.waitForURL((u) => u.toString().startsWith(callback), { timeout: 10_000 }), page.click("button[value=allow]")])
    const back = new URL(page.url())
    assert.ok(back.searchParams.get("code"), `a code at the callback: ${page.url()}`)
    assert.equal(back.searchParams.get("state"), "s1")
    assert.deepEqual(violations, [])
    await context.close()
  })

  test("«Deny» reaches it too, with access_denied", async () => {
    const { context, page, violations } = await consentPage()
    await Promise.all([page.waitForURL((u) => u.toString().startsWith(callback), { timeout: 10_000 }), page.click("button[value=deny]")])
    assert.equal(new URL(page.url()).searchParams.get("error"), "access_denied")
    assert.deepEqual(violations, [])
    await context.close()
  })

  test("the confirmation page: the person confirms in the browser and the call runs once", async () => {
    const client = testClient(served, { token: await signIn.dev.token({ person: "ada" }) })
    const first = await client.call("job.send_report", { id: "1" })
    const url = first.inputRequests!.confirm!.params.url!
    const context = await browser.newContext()
    const page = await context.newPage()
    const violations: string[] = []
    page.on("console", (m) => {
      if (/Content Security Policy|form-action/i.test(m.text())) violations.push(m.text())
    })
    await page.goto(url)
    // Not signed in: the development sign-in, back to the confirmation.
    await page.fill("#code", CODE)
    await Promise.all([page.waitForURL((u) => u.toString() === url), page.click("button[type=submit]")])
    await page.click("button.p")
    await page.waitForLoadState()
    assert.equal(new URL(page.url()).toString(), url)
    const run = await client.call("job.send_report", { id: "1" }, { inputResponses: { confirm: { action: "accept" } }, requestState: first.requestState! })
    assert.deepEqual(run.structuredContent, { sent: 1 }, JSON.stringify(run))
    assert.equal(sent, 1)
    assert.deepEqual(violations, [])
    await context.close()
  })
})
