import assert from "node:assert/strict"
import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { randomBytes } from "node:crypto"
import { rmSync } from "node:fs"
import { dirname, join } from "node:path"
import { after, describe, test } from "node:test"
import { fileURLToPath } from "node:url"

// A REAL Next.js run of test/fixture (App Router, withModelApp + toNextHandlers): `next dev`, then `next build` +
// `next start`. Through the rewrites: `modelapp check` with a token, what a route handler sees of a rewritten
// request, an SSE stream arriving chunk by chunk. Servers are stopped by PID; the fixture's .next is deleted.
// Run: npm run test:next (ports 3942 dev, 3943 start; MODELAPP_TEST_NEXT_PORT=<n> uses n and n+1).

const here = dirname(fileURLToPath(import.meta.url))
const fixture = join(here, "fixture")
const root = join(here, "..", "..", "..")
const cli = join(here, "..", "spec", "src", "cli.ts")
const nextBin = join(root, "node_modules", "next", "dist", "bin", "next")
const token = randomBytes(24).toString("base64url")
const running = new Set<ChildProcess>()
const devPort = Number(process.env.MODELAPP_TEST_NEXT_PORT || 3942)

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
  rmSync(join(fixture, ".next"), { recursive: true, force: true })
})

async function serve(mode: "dev" | "start", port: number): Promise<{ base: string; log: () => string; close: () => void }> {
  const base = `http://127.0.0.1:${port}`
  let output = ""
  const child = spawn(process.execPath, [nextBin, mode, "-p", String(port), "-H", "127.0.0.1"], {
    cwd: fixture,
    detached: true,
    env: { ...process.env, FIXTURE_TOKEN: token, MODELAPP_PUBLIC_URL: base, NEXT_TELEMETRY_DISABLED: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  })
  running.add(child)
  child.stdout!.on("data", (d) => (output += d))
  child.stderr!.on("data", (d) => (output += d))
  const deadline = Date.now() + 90_000
  for (;;) {
    if (child.exitCode !== null) throw new Error(`next ${mode} exited: ${output}`)
    try {
      if ((await fetch(`${base}/api/modelapp/health`)).ok) break
    } catch {}
    if (Date.now() > deadline) throw new Error(`next ${mode} did not answer: ${output}`)
    await new Promise((r) => setTimeout(r, 300))
  }
  return { base, log: () => output, close: () => stop(child) }
}

function modelappCheck(base: string, withToken: boolean) {
  const r = spawnSync("npx", ["tsx", cli, "check", base], { cwd: root, encoding: "utf8", env: { ...process.env, ...(withToken ? { MODELAPP_TOKEN: token } : {}) } })
  return { status: r.status, out: `${r.stdout}${r.stderr}` }
}

async function expectations(base: string) {
  // modelapp check: public checks without a token (exit 3: incomplete, nothing failed), everything with one.
  const pub = modelappCheck(base, false)
  assert.equal(pub.status, 3, pub.out)
  assert.doesNotMatch(pub.out, /FAIL/)
  const full = modelappCheck(base, true)
  assert.equal(full.status, 0, full.out)
  assert.match(full.out, /Conformant\./)

  // Every rewritten public path reaches the app (bare and with a path).
  for (const path of ["/.well-known/modelapp.json", "/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
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
  // The adapter: the public origin from MODELAPP_PUBLIC_URL.
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

describe("a real Next.js app (test/fixture)", { concurrency: false }, () => {
  test("next dev", { timeout: 180_000 }, async () => {
    const server = await serve("dev", devPort)
    try {
      await expectations(server.base)
    } catch (error) {
      console.error(server.log())
      throw error
    } finally {
      server.close()
    }
  })

  test("next build + next start", { timeout: 300_000 }, async () => {
    rmSync(join(fixture, ".next"), { recursive: true, force: true })
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
