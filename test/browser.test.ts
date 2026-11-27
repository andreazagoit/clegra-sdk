import assert from "node:assert/strict"
import { createHash, randomBytes } from "node:crypto"
import { createServer, type Server } from "node:http"
import { after, before, describe, test } from "node:test"

import { chromium, type Browser } from "playwright"
import { z } from "zod"

import { defineApp, defineEntity, definePage, defineTool, MemoryStore, serve } from "../src/index"
import { toNodeHandler } from "../src/node"
import { devSignIn } from "../src/signin"
import { testClient } from "../src/testing"

// IN A REAL CHROMIUM: what a unit test cannot see, the browser's own rules on the SDK's pages. Chromium checks a
// page's CSP `form-action` on every redirect of a form's navigation, so the consent's «Allow» (a POST answered by a
// 303 to the client's redirect_uri on another origin) must reach that address, and «Deny» too; the confirmation page
// confirms in the browser; a session transferred into a client's frame on a local stack (a cross-site frame on http
// loopback, a secure context) keeps its partitioned cookie. The app is http://app.localhost:<port>, the client (its
// redirect_uri, its framing page) http://localhost:<port>: two sites.
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
const jobPage = definePage({ name: "job", title: "Job", path: "/jobs/{id}", role: "record", entity: job, frame: true })
const app = defineApp({ name: "jobs", title: "Jobs", description: "Job requests", version: "1.0.0", entities: [job], tools: [sendReport], pages: [jobPage] })

let browser: Browser
let appServer: Server
let clientServer: Server
let callback = ""
let origin = ""
let clientOrigin = ""
let served: ReturnType<typeof serve>
let signIn: ReturnType<typeof devSignIn>

/** Listens on every loopback address (Chromium may try ::1 or 127.0.0.1 for a *.localhost name). */
const listenAnywhere = (server: Server) => new Promise<number>((resolve) => server.listen(0, () => resolve((server.address() as { port: number }).port)))

before(async () => {
  // The client: its redirect_uri answers a page with what it received; /frame frames a session transfer, posting the
  // redeem with its verifier into the frame as a client does.
  clientServer = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x")
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" })
    if (url.pathname === "/frame") {
      const attr = (v: string) => v.replace(/[<>&"]/g, "")
      res.end(`<!doctype html><title>client</title><iframe name="app" style="width:800px;height:400px"></iframe>
<form id="go" method="post" target="app" action="${attr(url.searchParams.get("redeem") ?? "")}"><input type="hidden" name="verifier" value="${attr(url.searchParams.get("verifier") ?? "")}"></form>
<script>document.getElementById("go").submit()</script>`)
      return
    }
    res.end(`<!doctype html><title>callback</title><p id="q">${url.search.replace(/[<>&"]/g, "")}</p>`)
  })
  clientOrigin = `http://localhost:${await listenAnywhere(clientServer)}`
  callback = `${clientOrigin}/api/apps/link/callback`

  // The app: the port first, then the origin the sign-in and the pages are made for.
  let handle: ReturnType<typeof toNodeHandler> | null = null
  appServer = createServer((req, res) => void handle?.(req, res))
  origin = `http://app.localhost:${await listenAnywhere(appServer)}`
  const clientMetadata = {
    fetch: (async (input: RequestInfo | URL) => (String(input) === CLIENT_ID ? Response.json({ client_id: CLIENT_ID, client_name: "Browser test", redirect_uris: [callback] }) : new Response("no", { status: 404 }))) as typeof fetch,
    lookup: async () => ["93.184.215.14"],
  }
  signIn = devSignIn(app, { issuer: origin, code: CODE, people: [{ id: "ada", name: "Ada" }], clientMetadata })
  served = serve(app, { origin, auth: { signIn }, store: new MemoryStore(), confirmWaitMs: 0, pages: "generated", clientOrigins: [clientOrigin] })
  handle = toNodeHandler(served)
  browser = await chromium.launch()
})

after(async () => {
  await browser?.close()
  for (const server of [appServer, clientServer]) await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))
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

  test("a session transferred into the client's frame on a local stack keeps its partitioned cookie", async () => {
    const client = testClient(served, { token: await signIn.dev.token({ person: "ada" }) })
    const v = randomBytes(32).toString("base64url")
    const c = createHash("sha256").update(v).digest("base64url")
    const target = `${origin}/jobs/1`
    const issued = await client.call("create_bound_browser_session", { target, challenge: c })
    const redeem = (issued.structuredContent as { url: string }).url
    const context = await browser.newContext()
    const page = await context.newPage()
    await page.goto(`${clientOrigin}/frame?${new URLSearchParams({ redeem, verifier: v })}`)
    const frame = page.frame({ name: "app" })!
    await frame.waitForURL(target, { timeout: 10_000 })
    assert.match(await frame.locator("body").innerText(), /Ada/)
    const cookies = (await context.cookies(origin)).filter((k) => k.name.startsWith("__Host-"))
    assert.equal(cookies.length, 1, JSON.stringify(await context.cookies()))
    assert.equal(cookies[0]!.secure, true)
    assert.equal(cookies[0]!.sameSite, "None")
    // The frame's next load still carries the session: the cookie was kept in the client's partition.
    await frame.goto(target)
    assert.match(await frame.locator("body").innerText(), /Signed in as Ada/)
    await context.close()
  })
})
