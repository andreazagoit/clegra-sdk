import assert from "node:assert/strict"
import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { createHash, randomBytes } from "node:crypto"
import { rmSync } from "node:fs"
import { dirname, join } from "node:path"
import { after, describe, test } from "node:test"
import { fileURLToPath } from "node:url"

import { newSignInKey } from "../src/signin"
import { linkSelf } from "./self-link"

// A REAL Next.js run of test/fixture (App Router, withClegra + toNextHandlers + recordProxy): `next dev`, then
// `next build` + `next start`. Through the real server: the rewrites (MCP, its Server Card, the AI Catalog, the OAuth
// metadata), tokens from the real OAuth flow (the password sign-in page, the consent, the code, the token with PKCE),
// `clegra check` reaching levels A, B1, B2 and C, a record URL answering JSON to a bearer and a page to a person, a
// session transfer redeemed by POST after which the page shows the person, what a route handler sees of a rewritten
// request and an SSE stream arriving chunk by chunk. Servers are stopped by PID; the fixture's .next is deleted.
// Run: npm run test:next (ports 3942 dev, 3943 start; CLEGRA_TEST_NEXT_PORT=<n> uses n and n+1).

const here = dirname(fileURLToPath(import.meta.url))
const fixture = join(here, "fixture")
const root = join(here, "..")
const cli = join(root, "src", "cli", "index.ts")
const nextBin = join(root, "node_modules", "next", "dist", "bin", "next")
const password = randomBytes(18).toString("base64url")
const signInKey = await newSignInKey()
const CLIENT_ID = "https://client.example.test/clegra-test.json"
const REDIRECT = "http://127.0.0.1:9/callback"
// test/fixture imports @clegra/sdk by name.
linkSelf()
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

after(async () => {
  for (const child of running) stop(child)
  await new Promise((r) => setTimeout(r, 500))
  rmSync(join(fixture, ".next"), { recursive: true, force: true, maxRetries: 20, retryDelay: 300 })
})

const env = { FIXTURE_CLIENT_ID: CLIENT_ID, FIXTURE_REDIRECT: REDIRECT, FIXTURE_ACCOUNT: JSON.stringify({ email: "ada@example.com", password }), FIXTURE_SIGNIN_KEY: signInKey, NEXT_TELEMETRY_DISABLED: "1" }

async function serve(mode: "dev" | "start", port: number): Promise<{ base: string; log: () => string; close: () => Promise<void> }> {
  const base = `http://127.0.0.1:${port}`
  let output = ""
  const child = spawn(process.execPath, [nextBin, mode, "-p", String(port), "-H", "127.0.0.1"], { cwd: fixture, detached: true, env: { ...process.env, ...env, CLEGRA_PUBLIC_URL: base }, stdio: ["ignore", "pipe", "pipe"] })
  running.add(child)
  child.stdout!.on("data", (d) => (output += d))
  child.stderr!.on("data", (d) => (output += d))
  const deadline = Date.now() + 120_000
  for (;;) {
    if (child.exitCode !== null) throw new Error(`next ${mode} exited: ${output}`)
    try {
      if ((await fetch(`${base}/mcp/server-card`)).ok) break
    } catch {}
    if (Date.now() > deadline) throw new Error(`next ${mode} did not answer: ${output}`)
    await new Promise((r) => setTimeout(r, 300))
  }
  // Until the process has exited: `next dev` writes into .next/dev while it shuts down.
  const exited = () => (child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise<void>((resolve) => child.once("exit", () => resolve())))
  return { base, log: () => output, close: () => (stop(child), exited()) }
}

const cookieOf = (r: Response) => r.headers.get("set-cookie")?.split(";")[0] ?? ""
const b64 = (bytes: Buffer) => bytes.toString("base64url")

/** The person signs in on the app's own page once; every token comes from that session through the consent. */
async function signIn(base: string): Promise<string> {
  const r = await fetch(`${base}/signin`, { method: "POST", redirect: "manual", headers: { origin: base, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ email: "ada@example.com", password, return: "/" }) })
  assert.equal(r.status, 303, await r.text())
  const cookie = cookieOf(r)
  assert.ok(cookie)
  return cookie
}

/** The real authorization code flow with PKCE, as an MCP client makes it: authorize → consent → code → token. */
async function oauthToken(base: string, cookie: string, scope: string): Promise<string> {
  const verifier = b64(randomBytes(32))
  const challenge = b64(createHash("sha256").update(verifier).digest())
  const authorize = new URL(`${base}/oauth/authorize`)
  for (const [k, v] of Object.entries({ client_id: CLIENT_ID, redirect_uri: REDIRECT, response_type: "code", code_challenge: challenge, code_challenge_method: "S256", state: "s1", scope, resource: `${base}/mcp` })) authorize.searchParams.set(k, v)
  const anonymous = await fetch(authorize, { redirect: "manual" })
  assert.equal(anonymous.status, 303, "without a session the authorize step sends the person to the sign-in")
  assert.match(anonymous.headers.get("location") ?? "", /\/signin\?return=/)
  const consent = await fetch(authorize, { redirect: "manual", headers: { cookie } })
  const html = await consent.text()
  assert.equal(consent.status, 200, html)
  assert.match(consent.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/)
  const request = /name="request" value="([^"]+)"/.exec(html)?.[1]
  assert.ok(request, html)
  const allowed = await fetch(`${base}/oauth/authorize`, { method: "POST", redirect: "manual", headers: { cookie, origin: base, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ request, decision: "allow" }) })
  assert.equal(allowed.status, 303, await allowed.text())
  const back = new URL(allowed.headers.get("location")!)
  const code = back.searchParams.get("code")
  assert.ok(code, back.toString())
  assert.equal(back.searchParams.get("state"), "s1")
  const token = await fetch(`${base}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, code_verifier: verifier, client_id: CLIENT_ID, resource: `${base}/mcp` }) })
  const body = (await token.json()) as { access_token?: string }
  assert.ok(body.access_token, JSON.stringify(body))
  return body.access_token
}

/** One MCP request on revision 2026-07-28. */
async function rpc(base: string, token: string, method: string, params: Record<string, unknown> = {}, name?: string) {
  const r = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2026-07-28", "mcp-method": method, ...(name ? { "mcp-name": name } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { ...params, _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientInfo": { name: "next-test", version: "1" }, "io.modelcontextprotocol/clientCapabilities": {} } } }),
  })
  const raw = await r.text()
  const json = r.headers.get("content-type")?.includes("text/event-stream") ? JSON.parse(raw.split("\n").filter((l) => l.startsWith("data:")).pop()!.slice(5)) : JSON.parse(raw)
  return json.result as Record<string, unknown>
}

function clegraCheck(base: string, token: string, readToken: string) {
  const call = JSON.stringify({ tool: "notes.publish", arguments: { id: `${base}/notes/n1` } })
  const r = spawnSync("npx", ["tsx", cli, "check", base, "--token", token, "--read-token", readToken, "--confirm-call", call, "--json"], { cwd: root, encoding: "utf8", env: { ...process.env, CLEGRA_TOKEN: "", CLEGRA_READ_TOKEN: "" } })
  let report: { levels?: string[]; checks?: { id: string; ok: unknown; message: string }[] } = {}
  try {
    report = JSON.parse(r.stdout)
  } catch {}
  return { status: r.status, out: `${r.stdout}${r.stderr}`, report }
}

async function expectations(base: string) {
  // Every rewritten public path reaches the app.
  for (const path of ["/mcp/server-card", "/.well-known/ai-catalog.json", "/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-authorization-server", "/oauth/jwks.json"]) {
    assert.equal((await fetch(`${base}${path}`)).status, 200, path)
  }
  const unauth = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })
  assert.equal(unauth.status, 401)
  assert.ok((unauth.headers.get("www-authenticate") ?? "").includes(`resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`))

  const cookie = await signIn(base)
  const token = await oauthToken(base, cookie, "web.read web.write web.irreversible bound_browser_session")
  const readToken = await oauthToken(base, cookie, "web.read")

  // The conformance check against the running app: A, B1 (the confirmed call, never run), B2 (the step-up) and C.
  const check = clegraCheck(base, token, readToken)
  const failed = (check.report.checks ?? []).filter((c) => c.ok === false)
  assert.equal(check.status, 0, `${check.out}\nfailed: ${JSON.stringify(failed, null, 2)}`)
  for (const level of ["A", "B1", "B2", "C"]) assert.ok(check.report.levels?.includes(level), `level ${level}: ${JSON.stringify(check.report.levels)}`)

  // A record's URL: JSON for a bearer (recordProxy → the route), the page or the sign-in for a person.
  const json = await fetch(`${base}/notes/n1`, { headers: { authorization: `Bearer ${token}` } })
  assert.equal(json.status, 200)
  assert.match(json.headers.get("vary") ?? "", /\bAuthorization\b/)
  assert.deepEqual(await json.json(), { id: "n1", title: "First note", body: "Hello" })
  assert.equal((await fetch(`${base}/notes/n1`, { headers: { authorization: "Bearer nope" } })).status, 401)
  const anonymousPage = await fetch(`${base}/notes/n1`)
  assert.equal(anonymousPage.status, 200)
  assert.match(await anonymousPage.text(), /data-signin/)
  assert.match(await (await fetch(`${base}/notes/n1`, { headers: { cookie } })).text(), /data-person="?[^>]*>Ada</)

  // Session transfer, strong mode: the client calls the hidden tool, then redeems the code by POST with the verifier.
  const verifier = b64(randomBytes(32))
  const challenge = b64(createHash("sha256").update(verifier).digest())
  const issued = await rpc(base, token, "tools/call", { name: "create_bound_browser_session", arguments: { target: `${base}/notes/n1`, challenge } }, "create_bound_browser_session")
  const url = (issued.structuredContent as { url: string }).url
  assert.ok(url.startsWith(`${base}/session-transfer/`), url)
  const bare = await fetch(url, { redirect: "manual" })
  assert.equal(bare.status, 200, "a bare GET is the interstitial")
  assert.equal(bare.headers.get("set-cookie"), null)
  const redeem = await fetch(url, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ verifier }) })
  assert.equal(redeem.status, 303, await redeem.text())
  assert.equal(redeem.headers.get("location"), `${base}/notes/n1`)
  const transferred = cookieOf(redeem)
  assert.match(transferred, /clegra-transferred=/)
  const page = await (await fetch(`${base}/notes/n1`, { headers: { cookie: transferred } })).text()
  assert.match(page, /\(transferred\)/)
  assert.match(page, /Signed in as Ada through Test client/)
  const again = await fetch(url, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ verifier }) })
  assert.equal(again.status, 410, "a code works once")

  // What Next hands a route handler for a rewritten request: the SOURCE path (not the destination).
  const raw = (await (await fetch(`${base}/probe-src/a/raw`)).json()) as { url: string; nextUrl: string }
  assert.equal(new URL(raw.url).pathname, "/probe-src/a/raw")
  assert.equal(new URL(raw.nextUrl).pathname, "/probe-src/a/raw")
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
  test("next dev", { timeout: 240_000 }, async () => {
    const server = await serve("dev", devPort)
    try {
      await expectations(server.base)
    } catch (error) {
      console.error(server.log().slice(-6000))
      throw error
    } finally {
      await server.close()
    }
  })

  test("next build + next start", { timeout: 300_000 }, async () => {
    rmSync(join(fixture, ".next"), { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
    const build = spawnSync(process.execPath, [nextBin, "build"], { cwd: fixture, encoding: "utf8", env: { ...process.env, ...env } })
    assert.equal(build.status, 0, `${build.stdout}${build.stderr}`)
    const server = await serve("start", devPort + 1)
    try {
      await expectations(server.base)
    } catch (error) {
      console.error(server.log().slice(-6000))
      throw error
    } finally {
      await server.close()
    }
  })
})
