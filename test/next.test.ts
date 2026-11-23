import assert from "node:assert/strict"
import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { randomBytes } from "node:crypto"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { after, describe, test } from "node:test"
import { fileURLToPath } from "node:url"

import { chromium } from "playwright"

import { deviceKey, testCore } from "../src/testing"

// A REAL Next.js run of test/fixture (App Router, withClegra + toNextHandlers): `next dev`, then `next build` +
// `next start`. Through the rewrites: `clegra check` with a token, what a route handler sees of a rewritten
// request, an SSE stream arriving chunk by chunk. Servers are stopped by PID; the fixture's .next is deleted.
// In next dev, the app's own site in a real Chromium (spec §5.1): a Clegra client harness on http://localhost (another
// site than the app on 127.0.0.1) asks the app for a site ticket with a core's app token and posts it into its frame.
// (.next is removed with retries: next dev may still be writing in it while it stops.)
// Run: npm run test:next (ports 3942 dev, 3943 start, 3944 the harness; CLEGRA_TEST_NEXT_PORT=<n> uses n, n+1, n+2).

const here = dirname(fileURLToPath(import.meta.url))
const fixture = join(here, "fixture")
const root = join(here, "..")
const cli = join(here, "..", "spec", "src", "cli.ts")
const nextBin = join(root, "node_modules", "next", "dist", "bin", "next")
const token = randomBytes(24).toString("base64url")
const siteSecret = randomBytes(32).toString("base64url")
const running = new Set<ChildProcess>()
const devPort = Number(process.env.CLEGRA_TEST_NEXT_PORT || 3942)
// The harness is the Clegra client: its origin is the app's one client origin.
const harnessOrigin = `http://localhost:${devPort + 2}`
const issuer = "https://core.test"

function stop(child: ChildProcess) {
  // The process group we started (next dev forks a worker): only our own PIDs.
  if (child.pid && child.exitCode === null) {
    try {
      process.kill(-child.pid, "SIGTERM")
    } catch {}
  }
  running.delete(child)
}

after(() => {
  for (const child of running) stop(child)
  rmSync(join(fixture, ".next"), { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
})

type Core = Awaited<ReturnType<typeof testCore>>

async function serve(mode: "dev" | "start", port: number): Promise<{ base: string; core: Core; log: () => string; close: () => Promise<void> }> {
  const base = `http://127.0.0.1:${port}`
  const core = await testCore({ resource: `${base}/mcp`, issuer })
  const fixtureCore = JSON.stringify({ issuer, jwks: core.jwks, clientOrigins: [harnessOrigin] })
  let output = ""
  const child = spawn(process.execPath, [nextBin, mode, "-p", String(port), "-H", "127.0.0.1"], {
    cwd: fixture,
    detached: true,
    env: { ...process.env, FIXTURE_TOKEN: token, FIXTURE_CORE: fixtureCore, FIXTURE_SITE_SECRET: siteSecret, CLEGRA_PUBLIC_URL: base, NEXT_TELEMETRY_DISABLED: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  })
  running.add(child)
  child.stdout!.on("data", (d) => (output += d))
  child.stderr!.on("data", (d) => (output += d))
  const deadline = Date.now() + 90_000
  for (;;) {
    if (child.exitCode !== null) throw new Error(`next ${mode} exited: ${output}`)
    try {
      if ((await fetch(`${base}/api/clegra/health`)).ok) break
    } catch {}
    if (Date.now() > deadline) throw new Error(`next ${mode} did not answer: ${output}`)
    await new Promise((r) => setTimeout(r, 300))
  }
  // Until the process has exited: `next dev` writes into .next/dev while it shuts down.
  const exited = () => (child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise<void>((resolve) => child.once("exit", () => resolve())))
  return { base, core, log: () => output, close: () => (stop(child), exited()) }
}

function clegraCheck(base: string, withToken: boolean) {
  const r = spawnSync("npx", ["tsx", cli, "check", base], { cwd: root, encoding: "utf8", env: { ...process.env, ...(withToken ? { CLEGRA_TOKEN: token } : {}) } })
  return { status: r.status, out: `${r.stdout}${r.stderr}` }
}

async function expectations(base: string) {
  // clegra check: public checks without a token (exit 3: incomplete, nothing failed), everything with one.
  const pub = clegraCheck(base, false)
  assert.equal(pub.status, 3, pub.out)
  assert.doesNotMatch(pub.out, /FAIL/)
  const full = clegraCheck(base, true)
  assert.equal(full.status, 0, full.out)
  assert.match(full.out, /Conformant\./)

  // Every rewritten public path reaches the app (bare and with a path).
  for (const path of ["/.well-known/clegra.json", "/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
    assert.equal((await fetch(`${base}${path}`)).status, 200, path)
  }
  // No auth.serve in the fixture: the app's own 404, which proves the rewrite reached it (Next's 404 is HTML).
  for (const path of ["/.well-known/oauth-authorization-server", "/.well-known/oauth-authorization-server/api/auth", "/.well-known/openid-configuration", "/.well-known/openid-configuration/api/auth"]) {
    const r = await fetch(`${base}${path}`)
    assert.equal(r.status, 404, path)
    assert.match(await r.text(), /MCP at \/mcp/, path)
  }

  // What Next hands a route handler for a rewritten request: the SOURCE path (not the destination).
  const raw = (await (await fetch(`${base}/probe-src/a/raw`, { headers: { "x-forwarded-for": "10.9.9.9" } })).json()) as { url: string; nextUrl: string; forwardedFor: string }
  assert.equal(new URL(raw.url).pathname, "/probe-src/a/raw")
  assert.equal(new URL(raw.nextUrl).pathname, "/probe-src/a/raw")
  // x-forwarded-for is whatever the client sent: no basis for a loopback check (dev sign-in stays refused).
  assert.equal(raw.forwardedFor, "10.9.9.9")
  // The adapter: the public origin from CLEGRA_PUBLIC_URL.
  const echo = (await (await fetch(`${base}/api/probe/echo`)).json()) as { adapterUrl: string }
  assert.equal(echo.adapterUrl, `${base}/echo`)

  // SSE through toNextHandlers: the first event arrives long before the stream ends (3 events, 400 ms apart).
  const started = Date.now()
  const response = await fetch(`${base}/api/probe/stream`, { headers: { "accept-encoding": "gzip" } })
  assert.equal(response.headers.get("content-type"), "text/event-stream")
  const reader = response.body!.getReader()
  const first = await reader.read()
  const firstAt = Date.now() - started
  assert.match(new TextDecoder().decode(first.value), /"i":0/)
  while (!(await reader.read()).done) {}
  const endAt = Date.now() - started
  assert.ok(endAt - firstAt >= 600, `first event at ${firstAt} ms, end at ${endAt} ms: buffered`)
}

/** A Clegra client's MCP call to the app: the core's app token for Ada, DPoP-bound to her device (nonce asked once). */
async function clientCall(base: string, core: Core, name: string, args: Record<string, unknown>) {
  const device = await deviceKey()
  const htu = `${base}/mcp`
  let nonce: string | undefined
  for (let attempt = 0; attempt < 2; attempt++) {
    const t = await core.appToken({ company: "co-1", sub: "ada", name: "Ada", device })
    const r = await fetch(htu, {
      method: "POST",
      headers: { authorization: `DPoP ${t}`, dpop: await device.proof({ htm: "POST", htu, token: t, ...(nonce ? { nonce } : {}) }), "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    })
    if (r.status === 401 && r.headers.get("dpop-nonce") && !nonce) {
      nonce = r.headers.get("dpop-nonce")!
      continue
    }
    const raw = await r.text()
    return (JSON.parse(raw.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).pop() ?? raw) as { result?: { structuredContent?: Record<string, unknown>; isError?: boolean } }).result
  }
  throw new Error("no answer")
}

/**
 * The Clegra client harness: `/` frames the site (`/?path=…`: at that path) with a fresh site ticket posted into the
 * frame, records the frame's messages (from that frame and the app's origin only) in `window.messages`, and sends
 * `clegra/context` when the test calls `window.sendContext(theme, locale)`; `/direct` frames the site with no ticket; `/probe` frames the
 * unpartitioned-cookie probe.
 */
async function harness(base: string, core: Core, port: number) {
  const appOrigin = new URL(base).origin
  const host = (ticket: { action: string; field: string; ticket: string }) => `<!doctype html><meta charset="utf-8"><iframe id="v" name="site" sandbox="allow-scripts allow-same-origin allow-forms" style="width:900px;height:400px"></iframe>
<form id="f" method="post" action="${ticket.action}" target="site" hidden><input type="hidden" name="${ticket.field}" value="${ticket.ticket}"></form><script>
window.messages = [];
window.sendContext = (theme, locale) => document.getElementById("v").contentWindow.postMessage({ type: "clegra/context", theme, locale }, ${JSON.stringify(appOrigin)});
addEventListener("message", (e) => {
  if (e.source !== document.getElementById("v").contentWindow || e.origin !== ${JSON.stringify(appOrigin)}) return;
  window.messages.push(e.data);
});
document.getElementById("f").submit();
</script>`
  const server = createServer(async (req, res) => {
    const html = (body: string) => res.writeHead(200, { "content-type": "text/html" }).end(body)
    const url = new URL(req.url ?? "/", `http://localhost:${port}`)
    if (url.pathname === "/") {
      const r = await clientCall(base, core, "clegra_site", { origin: `http://localhost:${port}`, theme: "light", locale: "en", ...(url.searchParams.get("path") ? { path: url.searchParams.get("path") } : {}) })
      if (!r || r.isError) return res.writeHead(500).end(JSON.stringify(r))
      return html(host(r.structuredContent as { action: string; field: string; ticket: string }))
    }
    if (url.pathname === "/direct") return html(`<iframe id="d" src="${base}/board"></iframe>`)
    if (url.pathname === "/probe") return html(`<iframe id="p" src="${base}/probe"></iframe>`)
    res.writeHead(404).end()
  })
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve))
  return { url: `http://localhost:${port}`, close: () => new Promise<void>((resolve) => server.close(() => resolve())) }
}

async function siteInBrowser(base: string, core: Core, port: number) {
  const host = await harness(base, core, port)
  // Third-party cookies blocked (Chromium's own setting, in a fresh profile), as Safari and Firefox do and Chrome
  // users can: only a partitioned cookie can work. (The headless shell ignores the setting: the full Chromium.)
  const profile = mkdtempSync(join(tmpdir(), "clegra-site-profile-"))
  mkdirSync(join(profile, "Default"))
  writeFileSync(join(profile, "Default", "Preferences"), JSON.stringify({ profile: { cookie_controls_mode: 1, block_third_party_cookies: true } }))
  const context = await chromium.launchPersistentContext(profile, { headless: true, channel: "chromium" })
  const browser = await chromium.launch()
  try {
    const page = await context.newPage()
    await page.goto(host.url)
    const site = page.frameLocator("#v")
    const caller = site.locator("[data-caller]")
    await caller.waitFor({ timeout: 30_000 })
    assert.equal(await caller.textContent(), "Ada · co-1@https://core.test · notes.view · light · en", "the frame of another site is signed in by the ticket")
    // The browser's cookie store (every partition: Playwright reports each cookie's partition key).
    const cookies = await context.cookies()
    const session = cookies.find((c) => c.name === "__Secure-clegra-site")
    assert.ok(session, JSON.stringify(cookies))
    assert.equal(session.path, "/")
    assert.equal(session.secure, true)
    assert.equal(session.httpOnly, true)
    assert.equal(session.sameSite, "None")
    assert.equal(session.domain, "127.0.0.1", "a host-only cookie (no Domain)")
    assert.equal(session.partitionKey, "http://localhost", "the cookie is kept under the client's top-level site only")
    assert.ok(cookies.some((c) => c.name === "__Secure-clegra-site-origin" && c.partitionKey === "http://localhost"))
    // The frame's address holds no ticket: it is the site's start.
    assert.equal(page.frames().find((f) => f.name() === "site")?.url(), `${base}/board`)

    // The bridge: where the site is, then the client's theme at once and its language kept and drawn.
    const messages = () => page.evaluate(() => (window as unknown as { messages: { type: string; path?: string; title?: string }[] }).messages)
    await page.waitForFunction(() => (window as unknown as { messages: unknown[] }).messages.length > 0)
    assert.deepEqual((await messages())[0], { type: "clegra/location", path: "/board", title: "Board" })
    await page.evaluate(() => (window as unknown as { sendContext: (t: string, l: string) => void }).sendContext("dark", "it"))
    await site.locator("html.dark").waitFor({ timeout: 15_000 })
    await site.locator("[data-caller]", { hasText: "dark · it" }).waitFor({ timeout: 30_000 })
    // A navigation inside the site (Next's client router): the client hears the new path and title.
    await site.locator("[data-next]").click()
    await site.locator("[data-notes]").waitFor()
    await page.waitForFunction(() => (window as unknown as { messages: { path?: string; title?: string }[] }).messages.some((m) => m.path === "/notes?status=open" && m.title === "Notes"))
    assert.equal(await site.locator("[data-notes]").textContent(), "notes for Ada")

    // Opened again at a path (a reload of the client at /notes): straight there.
    const again = await context.newPage()
    await again.goto(`${host.url}/?path=${encodeURIComponent("/notes?status=open")}`)
    await again.frameLocator("#v").locator("[data-notes]", { hasText: "notes for Ada" }).waitFor({ timeout: 30_000 })

    // The site opened top-level, in the same browser: another partition, and not a frame: signed out, never framable.
    const top = await context.newPage()
    const topResponse = await top.goto(`${base}/board`)
    assert.equal(await top.locator("[data-caller]").textContent(), "signed out")
    assert.equal(topResponse?.headers()["content-security-policy"], "frame-ancestors 'none'")
    // The site framed by the same host without a ticket (a browser that never got one): refused by frame-ancestors.
    const fresh = await (await browser.newContext()).newPage()
    await fresh.goto(`${host.url}/direct`)
    await fresh.waitForTimeout(1000)
    assert.equal(await fresh.frameLocator("#d").locator("[data-caller]").count(), 0, "outside a Clegra session the site is framed by no one")

    // A cookie without Partitioned, set and read back inside the same cross-site frame: never sent back.
    await page.goto(`${host.url}/probe`)
    await page.frameLocator("#p").locator("[data-probe]").waitFor()
    await page.reload()
    assert.equal(await page.frameLocator("#p").locator("[data-probe]").textContent(), "no unpartitioned cookie")
  } finally {
    await context.close()
    await browser.close()
    await host.close()
    rmSync(profile, { recursive: true, force: true })
  }
}

describe("a real Next.js app (test/fixture)", { concurrency: false }, () => {
  test("next dev", { timeout: 180_000 }, async () => {
    const server = await serve("dev", devPort)
    try {
      await expectations(server.base)
      await siteInBrowser(server.base, server.core, devPort + 2)
    } catch (error) {
      console.error(server.log())
      throw error
    } finally {
      await server.close()
    }
  })

  test("next build + next start", { timeout: 300_000 }, async () => {
    rmSync(join(fixture, ".next"), { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
    const build = spawnSync(process.execPath, [nextBin, "build"], { cwd: fixture, encoding: "utf8", env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" } })
    assert.equal(build.status, 0, `${build.stdout}${build.stderr}`)
    const server = await serve("start", devPort + 1)
    try {
      await expectations(server.base)
    } catch (error) {
      console.error(server.log())
      throw error
    } finally {
      await server.close()
    }
  })
})
