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

// A REAL Next.js run of test/fixture (App Router, withClegra + toNextHandlers): `next dev`, then `next build` +
// `next start`. Through the rewrites: `clegra check` with a token, what a route handler sees of a rewritten
// request, an SSE stream arriving chunk by chunk. Servers are stopped by PID; the fixture's .next is deleted.
// In next dev, the embedded page in a real Chromium (spec §5.1): a host harness on http://localhost (another site
// than the app on 127.0.0.1) frames the SDK's url-page view, which asks for a ticket over the bridge and posts it.
// (.next is removed with retries: next dev may still be writing in it while it stops.)
// Run: npm run test:next (ports 3942 dev, 3943 start, 3944 the harness; CLEGRA_TEST_NEXT_PORT=<n> uses n, n+1, n+2).

const here = dirname(fileURLToPath(import.meta.url))
const fixture = join(here, "fixture")
const root = join(here, "..")
const cli = join(here, "..", "spec", "src", "cli.ts")
const nextBin = join(root, "node_modules", "next", "dist", "bin", "next")
const token = randomBytes(24).toString("base64url")
const embedSecret = randomBytes(32).toString("base64url")
const running = new Set<ChildProcess>()
const devPort = Number(process.env.CLEGRA_TEST_NEXT_PORT || 3942)

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

async function serve(mode: "dev" | "start", port: number): Promise<{ base: string; log: () => string; close: () => void }> {
  const base = `http://127.0.0.1:${port}`
  let output = ""
  const child = spawn(process.execPath, [nextBin, mode, "-p", String(port), "-H", "127.0.0.1"], {
    cwd: fixture,
    detached: true,
    env: { ...process.env, FIXTURE_TOKEN: token, FIXTURE_EMBED_SECRET: embedSecret, CLEGRA_PUBLIC_URL: base, NEXT_TELEMETRY_DISABLED: "1" },
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
  return { base, log: () => output, close: () => stop(child) }
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

/** An MCP call to the app with the fixture's token (what a host does for its viewer). */
async function mcp(base: string, method: string, params: Record<string, unknown>) {
  const r = await fetch(`${base}/mcp`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })
  const raw = await r.text()
  return JSON.parse(raw.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).pop() ?? raw) as { result?: Record<string, unknown>; error?: unknown }
}

/**
 * The host harness: `/` plays an MCP Apps host (it frames `/view`, the app's url-page view, sandboxed with an origin
 * of its own, answers ui/initialize and relays tools/call to the app with the viewer's token); `/direct` frames the
 * page with no ticket; `/probe` frames the unpartitioned-cookie probe.
 */
async function harness(base: string, port: number) {
  const view = ((await mcp(base, "resources/read", { uri: "ui://fixture-notes/pages/board" })).result?.contents as { text: string }[])[0]!.text
  const host = `<!doctype html><meta charset="utf-8"><iframe id="v" src="/view" sandbox="allow-scripts allow-same-origin allow-forms" style="width:900px;height:400px"></iframe><script>
addEventListener("message", async (e) => {
  const m = e.data; const frame = document.getElementById("v").contentWindow; if (e.source !== frame || !m || m.jsonrpc !== "2.0" || m.id === undefined) return;
  if (m.method === "ui/initialize") return frame.postMessage({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2026-01-26", hostInfo: { name: "harness", version: "1" }, hostCapabilities: {}, hostContext: { locale: "en" } } }, "*");
  if (m.method === "tools/call") { const r = await fetch("/call", { method: "POST", body: JSON.stringify(m.params) }); return frame.postMessage({ jsonrpc: "2.0", id: m.id, result: await r.json() }, "*"); }
});
</script>`
  const server = createServer(async (req, res) => {
    const html = (body: string) => res.writeHead(200, { "content-type": "text/html" }).end(body)
    if (req.url === "/") return html(host)
    if (req.url === "/view") return html(view)
    if (req.url === "/direct") return html(`<iframe id="d" src="${base}/embed/board"></iframe>`)
    if (req.url === "/probe") return html(`<iframe id="p" src="${base}/embed/probe"></iframe>`)
    if (req.url === "/call" && req.method === "POST") {
      let body = ""
      for await (const chunk of req) body += chunk
      const r = await mcp(base, "tools/call", JSON.parse(body))
      return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(r.result ?? { isError: true, content: [{ type: "text", text: JSON.stringify(r.error) }] }))
    }
    res.writeHead(404).end()
  })
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve))
  return { url: `http://localhost:${port}`, close: () => new Promise<void>((resolve) => server.close(() => resolve())) }
}

async function embedInBrowser(base: string, port: number) {
  const host = await harness(base, port)
  // Third-party cookies blocked (Chromium's own setting, in a fresh profile), as Safari and Firefox do and Chrome
  // users can: only a partitioned cookie can work. (The headless shell ignores the setting: the full Chromium.)
  const profile = mkdtempSync(join(tmpdir(), "clegra-embed-profile-"))
  mkdirSync(join(profile, "Default"))
  writeFileSync(join(profile, "Default", "Preferences"), JSON.stringify({ profile: { cookie_controls_mode: 1, block_third_party_cookies: true } }))
  const context = await chromium.launchPersistentContext(profile, { headless: true, channel: "chromium" })
  const browser = await chromium.launch()
  try {
    const page = await context.newPage()
    await page.goto(host.url)
    const embedded = page.frameLocator("#v").frameLocator("iframe[name=clegra-page]").locator("[data-caller]")
    await embedded.waitFor({ timeout: 30_000 })
    assert.equal(await embedded.textContent(), "Test person · org-a · notes.view", "the frame of another site is signed in by the ticket")
    // The browser's cookie store (every partition: Playwright reports each cookie's partition key).
    const cookies = await context.cookies()
    const session = cookies.find((c) => c.name === "__Secure-clegra-embed-board")
    assert.ok(session, JSON.stringify(cookies))
    assert.equal(session.path, "/embed/board")
    assert.equal(session.secure, true)
    assert.equal(session.httpOnly, true)
    assert.equal(session.sameSite, "None")
    assert.equal(session.domain, "127.0.0.1", "a host-only cookie (no Domain)")
    assert.equal(session.partitionKey, "http://localhost", "the cookie is kept under the host's top-level site only")
    // The address bar of the frame holds no ticket: it is the page.
    const frameUrl = page.frames().find((f) => f.name() === "clegra-page")?.url()
    assert.equal(frameUrl, `${base}/embed/board`)

    // The session opened top-level, in the same browser: another partition, and not a frame: signed out.
    const top = await context.newPage()
    await top.goto(`${base}/embed/board`)
    assert.equal(await top.locator("[data-caller]").textContent(), "signed out")
    // The page framed by the same host without a ticket (a browser that never got one): signed out.
    const fresh = await (await browser.newContext()).newPage()
    await fresh.goto(`${host.url}/direct`)
    assert.equal(await fresh.frameLocator("#d").locator("[data-caller]").textContent(), "signed out")

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
      await embedInBrowser(server.base, devPort + 2)
    } catch (error) {
      console.error(server.log())
      throw error
    } finally {
      server.close()
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
      server.close()
    }
  })
})
