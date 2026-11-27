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

import { newSignInKey } from "../src/signin"


// A REAL Next.js run of test/fixture (App Router, withClegra + toNextHandlers): `next dev`, then `next build` +
// `next start`. Through the rewrites: `clegra check` with a token, what a route handler sees of a rewritten
// request, an SSE stream arriving chunk by chunk. Servers are stopped by PID; the fixture's .next is deleted.
// In next dev, the app's own site in a real Chromium (spec §5.1): a workspace client harness on http://localhost
// (another site than the app on 127.0.0.1) frames the site; the person signs in with the app's own sign-in inside the
// frame, its session cookie partitioned under the harness's site.
// (.next is removed with retries: next dev may still be writing in it while it stops.)
// Run: npm run test:next (ports 3942 dev, 3943 start, 3944 the harness; CLEGRA_TEST_NEXT_PORT=<n> uses n, n+1, n+2).

const here = dirname(fileURLToPath(import.meta.url))
const fixture = join(here, "fixture")
const root = join(here, "..")
const cli = join(here, "..", "spec", "src", "cli.ts")
const nextBin = join(root, "node_modules", "next", "dist", "bin", "next")
const token = randomBytes(24).toString("base64url")
const password = randomBytes(18).toString("base64url")
const signInKey = await newSignInKey()
const running = new Set<ChildProcess>()
const devPort = Number(process.env.CLEGRA_TEST_NEXT_PORT || 3942)
// The harness is the Clegra client: its origin is the app's one client origin.
const harnessOrigin = `http://localhost:${devPort + 2}`

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

async function serve(mode: "dev" | "start", port: number): Promise<{ base: string; log: () => string; close: () => Promise<void> }> {
  const base = `http://127.0.0.1:${port}`
  let output = ""
  const child = spawn(process.execPath, [nextBin, mode, "-p", String(port), "-H", "127.0.0.1"], {
    cwd: fixture,
    detached: true,
    env: { ...process.env, FIXTURE_TOKEN: token, FIXTURE_CLIENT: harnessOrigin, FIXTURE_ACCOUNT: JSON.stringify({ email: "ada@example.com", password }), FIXTURE_SIGNIN_KEY: signInKey, CLEGRA_PUBLIC_URL: base, NEXT_TELEMETRY_DISABLED: "1" },
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
  return { base, log: () => output, close: () => (stop(child), exited()) }
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
  // The sign-in module's metadata at the root (its issuer is the app's origin); another issuer path is the app's own 404.
  for (const path of ["/.well-known/oauth-authorization-server", "/.well-known/openid-configuration", "/oauth/jwks.json"]) assert.equal((await fetch(`${base}${path}`)).status, 200, path)
  const other = await fetch(`${base}/.well-known/oauth-authorization-server/api/auth`)
  assert.equal(other.status, 404)
  assert.match(await other.text(), /MCP at \/mcp/)

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

/** The workspace client harness on its own site: `/` frames the site's start; `window.sendContext(theme, locale)` posts `clegra/context`; it keeps what the frame tells it in `window.heard`. */
async function harness(base: string, port: number) {
  const page = `<!doctype html><meta charset="utf-8"><iframe id="v" name="site" src="${base}/board" style="width:900px;height:400px"></iframe><script>
window.heard = [];
addEventListener("message", (e) => { if (e.origin === ${JSON.stringify(base)}) window.heard.push(e.data); });
window.sendContext = (theme, locale) => document.getElementById("v").contentWindow.postMessage({ type: "clegra/context", theme, locale }, ${JSON.stringify(base)});
</script>`
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" })
    res.end(page)
  })
  await new Promise<void>((resolve) => server.listen(port, "localhost", resolve))
  return { close: () => new Promise<void>((resolve) => server.close(() => resolve())) }
}

async function siteInBrowser(base: string, port: number) {
  const host = await harness(base, port)
  const browser = await chromium.launch()
  const context = await browser.newContext()
  try {
    const page = await context.newPage()
    await page.goto(`http://localhost:${port}/`)
    const site = page.frameLocator("#v")
    // The app's own sign-in, inside the frame: nobody signs the person in for the app.
    await site.locator("[data-signin]").click()
    await site.locator("input[name=email]").fill("ada@example.com")
    await site.locator("input[name=password]").fill(password)
    await site.locator("button[type=submit]").click()
    await site.locator("[data-caller]").waitFor({ timeout: 30_000 })
    assert.equal(await site.locator("[data-caller]").textContent(), "Ada · org-a")
    const cookies = await context.cookies(base)
    const session = cookies.find((c) => c.name === "__Host-app_session")
    assert.ok(session, `the session cookie: ${JSON.stringify(cookies.map((c) => c.name))}`)
    assert.equal(session.partitionKey, "http://localhost", "kept under the client's top-level site only")
    assert.equal(session.httpOnly, true)
    // The bridge: where the site is, then the client's theme.
    await page.waitForFunction(() => (window as unknown as { heard: { type: string }[] }).heard.some((m) => m.type === "clegra/location"), undefined, { timeout: 15_000 })
    await page.evaluate(() => (window as unknown as { sendContext: (t: string, l: string) => void }).sendContext("dark", "it"))
    await site.locator("html.dark").waitFor({ timeout: 15_000 })
    // A navigation inside the site: still the same session.
    await site.locator("[data-next]").click()
    await site.locator("[data-notes]").waitFor()
    assert.equal(await site.locator("[data-notes]").textContent(), "notes for Ada")
    // Framable by the client's origin only.
    const policy = (await fetch(`${base}/board`)).headers.get("content-security-policy")
    assert.equal(policy, `frame-ancestors 'self' http://localhost:${port}`)
  } finally {
    await context.close()
    await browser.close()
    await host.close()
  }
}

describe("a real Next.js app (test/fixture)", { concurrency: false }, () => {
  test("next dev", { timeout: 180_000 }, async () => {
    const server = await serve("dev", devPort)
    try {
      await expectations(server.base)
      await siteInBrowser(server.base, devPort + 2)
    } catch (error) {
      console.error(server.log())
      throw error
    } finally {
      await server.close()
    }
  })

  test("next build + next start", { timeout: 300_000 }, async () => {
    rmSync(join(fixture, ".next"), { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
    const build = spawnSync(process.execPath, [nextBin, "build"], { cwd: fixture, encoding: "utf8", env: { ...process.env, FIXTURE_SIGNIN_KEY: signInKey, NEXT_TELEMETRY_DISABLED: "1" } })
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
