// The CRM's own users over MCP: real better-auth access tokens (the OAuth flow in-process, on PGlite), verified by
// the app's own `resolve` (modelapp/auth.ts), through the Next route handlers as the app serves them.
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createHash, randomBytes } from "node:crypto"
import { createServer } from "node:http"
import { describe, test } from "node:test"

// The public address of this test's site (read on use, so set before anything runs).
const SITE = "http://localhost:3921"
process.env.MODELAPP_PUBLIC_URL = SITE
const { password, users } = await import("./setup")

import { and, eq } from "drizzle-orm"
import { verifyOAuthQueryParams } from "@better-auth/oauth-provider"
import { decodeJwt, decodeProtectedHeader, generateKeyPair, SignJWT } from "jose"
import { toNextHandlers } from "modelapp/next"
import { checkApp, formatReport } from "modelapp/spec"

import { deals, member, user } from "../db/schema"
import { auth } from "../lib/auth"
import { db } from "../lib/db"
import { oauthQueryOf } from "../lib/oauth-pages"
import { answerConsent, signIn } from "../lib/sign-in"
import { createCrmApp } from "../modelapp/app"
import { crmAuth } from "../modelapp/auth"
import { oauthAccessToken } from "../scripts/oauth-flow"

const RESOURCE = `${SITE}/mcp`
const ISSUER = `${SITE}/api/auth`
const route = toNextHandlers(createCrmApp({ auth: crmAuth() }), { publicUrl: SITE })
const handler = (request: Request) => auth().handler(request)

const accounts = { alice: "alice@orbit.example", ben: "ben@orbit.example", emma: "emma@kestrel.example" }
const tokenFor = (who: keyof typeof accounts, extra: Partial<Parameters<typeof oauthAccessToken>[0]> = {}) =>
  oauthAccessToken({ authBaseURL: ISSUER, resource: RESOURCE, signIn: { email: accounts[who], password }, fetch: handler, ...extra })

async function rpc(token: string | null, method: string, params: Record<string, unknown> = {}) {
  const response = await route.POST(
    new Request(`${SITE}/api/modelapp/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }),
  )
  const text = await response.text()
  if (response.status !== 200) return { status: response.status, headers: response.headers, text }
  const data = response.headers.get("content-type")?.includes("text/event-stream") ? JSON.parse(text.split("\n").filter((l) => l.startsWith("data:")).pop()!.slice(5)) : JSON.parse(text)
  return { status: 200, headers: response.headers, result: data.result, error: data.error }
}
type Rows = { rows: Record<string, unknown>[] }
const call = async (token: string, name: string, args: Record<string, unknown> = {}) => (await rpc(token, "tools/call", { name, arguments: args })).result as { isError?: boolean; structuredContent: Rows & Record<string, unknown> }

describe("the CRM's own users, with better-auth access tokens", () => {
  test("metadata: the MCP server names better-auth as its authorization server, served at the root (RFC 8414, OIDC), no open registration", async () => {
    const prm = (await (await route.GET(new Request(`${SITE}/.well-known/oauth-protected-resource/mcp`))).json()) as { resource: string; authorization_servers: string[]; scopes_supported?: string[] }
    assert.equal(prm.resource, RESOURCE)
    assert.deepEqual(prm.authorization_servers, [ISSUER])
    for (const path of ["/.well-known/oauth-authorization-server/api/auth", "/.well-known/openid-configuration/api/auth"]) {
      const response = await route.GET(new Request(`${SITE}${path}`))
      assert.equal(response.status, 200, path)
      const meta = (await response.json()) as Record<string, unknown>
      assert.equal(meta.issuer, ISSUER)
      assert.deepEqual(meta.code_challenge_methods_supported, ["S256"])
      assert.equal(meta.client_id_metadata_document_supported, true)
      assert.ok(!("registration_endpoint" in meta), "dynamic client registration is off")
      assert.ok((meta.scopes_supported as string[]).includes("modelapp"))
    }
    assert.equal((await route.POST(new Request(`${SITE}/.well-known/oauth-authorization-server/api/auth`, { method: "POST" }))).status, 405)
  })

  test("no token: 401 with WWW-Authenticate pointing at the protected-resource metadata", async () => {
    const r = await rpc(null, "tools/list")
    assert.equal(r.status, 401)
    assert.match(r.headers.get("www-authenticate") ?? "", new RegExp(`resource_metadata="${SITE}/.well-known/oauth-protected-resource/mcp"`))
  })

  test("the full flow gives an audience-bound token for the person's organization; it reads that organization's data and passes the checks", async () => {
    const t = await tokenFor("alice")
    const claims = decodeJwt(t.accessToken)
    assert.equal(decodeProtectedHeader(t.accessToken).typ, "at+jwt")
    assert.deepEqual([claims.iss, claims.aud, claims.org, claims.sub], [ISSUER, RESOURCE, "org_orbit", users.alice])
    const deals = (await call(t.accessToken, "deal_list", { limit: 50 })).structuredContent as Rows & { refs: { owner: Record<string, string> } }
    assert.equal(deals.rows.length, 5)
    assert.equal(deals.rows.find((d) => d.id === "d1")!.value, 18000)
    assert.deepEqual(deals.refs.owner, { [users.alice]: "Alice Morgan", [users.ben]: "Ben Carter" })
    const report = await checkApp({ url: SITE, token: t.accessToken, fetch: (r) => route[r.method as "GET"](r) })
    assert.ok(report.ok && report.complete, formatReport(report))
  })

  test("a member's role gives no money; a write lands in the caller's organization", async () => {
    const t = await tokenFor("ben")
    const rows = (await call(t.accessToken, "deal_list")).structuredContent.rows
    assert.ok(rows.length === 5 && rows.every((r) => !("value" in r)), JSON.stringify(rows))
    assert.ok(!(await call(t.accessToken, "deal_set_stage", { id: "d2", stage: "proposal" })).isError)
    const [d2] = await db().select().from(deals).where(and(eq(deals.orgId, "org_orbit"), eq(deals.id, "d2")))
    assert.equal(d2!.stage, "proposal")
  })

  test("a user of one organization never reaches another's records; the organization comes from the token only", async () => {
    const t = await tokenFor("emma")
    assert.equal(decodeJwt(t.accessToken).org, "org_kestrel")
    // Parameters can't name a tenant: refused as unknown, never another organization's rows.
    const asked = await call(t.accessToken, "deal_list", { installation: "org_orbit", org: "org_orbit" })
    assert.ok(!JSON.stringify(asked).includes("Hartley"), JSON.stringify(asked))
    assert.deepEqual((await call(t.accessToken, "deal_list")).structuredContent.rows.map((r) => r.name), ["Rosewood Bakery — new brand"])
    assert.equal(((await call(t.accessToken, "deal_get", { id: "d1" })).structuredContent.record as { name: string }).name, "Rosewood Bakery — new brand")
    assert.equal((await call(t.accessToken, "company_get", { id: "co4" })).isError, true)
    // Asking for an organization she isn't in: better-auth refuses to make it active.
    await assert.rejects(tokenFor("emma", { organizationId: "org_orbit" }), /set active organization: 4\d\d/)
  })

  test("other audience, tampered, expired, opaque, DPoP-bound, several audiences, no scope, no organization, a foreign key, a wrong typ: all 401", async () => {
    const t = await tokenFor("alice")
    const [h, p, s] = t.accessToken.split(".")
    const body = JSON.parse(Buffer.from(p!, "base64url").toString())
    const now = Math.floor(Date.now() / 1000)
    const cases: [string, string, RegExp][] = [
      ["other audience", await resign(t.accessToken, { aud: "https://other.example.test/mcp" }), /another server/],
      ["tampered", `${h}.${Buffer.from(JSON.stringify({ ...body, org: "org_kestrel" })).toString("base64url")}.${s}`, /not valid/],
      ["expired", await resign(t.accessToken, { exp: now - 120, iat: now - 3600 }), /expired/],
      ["opaque", "aBcDeFgHiJkLmNoPqRsTuVwXyZ012345", /not a JWT/],
      ["dpop", await resign(t.accessToken, { cnf: { jkt: "x" } }), /DPoP/],
      ["two audiences", await resign(t.accessToken, { aud: [RESOURCE, "https://other.example.test/mcp"] }), /several servers/],
      ["no scope", await resign(t.accessToken, { scope: "openid profile" }), /modelapp scope/],
      ["no org", await resign(t.accessToken, { org: undefined }), /no organization/],
      ["foreign key", await foreign(t.accessToken), /not valid/],
      ["wrong typ", await resign(t.accessToken, {}, "JWT"), /not an access token/],
    ]
    for (const [name, token, reason] of cases) {
      const r = await rpc(token, "tools/list")
      assert.equal(r.status, 401, name)
      assert.match(r.headers.get("www-authenticate") ?? "", reason, name)
    }
    // Within the 30 s of clock skew, an expiry just passed still counts.
    assert.equal((await rpc(await resign(t.accessToken, { exp: now - 10 }), "tools/list")).status, 200)
  })

  test("the role is read on every call: promoted → sees money; membership removed → refused; user deleted → refused", async () => {
    const t = await tokenFor("ben")
    const where = and(eq(member.organizationId, "org_orbit"), eq(member.userId, users.ben))
    try {
      await db().update(member).set({ role: "member,admin" }).where(where)
      assert.ok((await call(t.accessToken, "deal_list")).structuredContent.rows.every((r) => "value" in r))
      await db().update(member).set({ role: "member" }).where(where)
      assert.ok((await call(t.accessToken, "deal_list")).structuredContent.rows.every((r) => !("value" in r)))
      await db().delete(member).where(where)
      const r = await rpc(t.accessToken, "tools/list")
      assert.equal(r.status, 401)
      assert.match(r.headers.get("www-authenticate") ?? "", /not a member/)
    } finally {
      await db().insert(member).values({ id: "org_orbit_ben", organizationId: "org_orbit", userId: users.ben, role: "member", createdAt: new Date() }).onConflictDoNothing()
    }
    // A user who is gone: memberships go with them.
    const [gone] = await db().insert(user).values({ id: "user-gone", name: "Gone User", email: "gone@orbit.example", emailVerified: true }).returning()
    await db().insert(member).values({ id: "m-gone", organizationId: "org_orbit", userId: gone!.id, role: "admin", createdAt: new Date() })
    const forged = await resign(t.accessToken, { sub: gone!.id })
    assert.equal((await rpc(forged, "tools/list")).status, 200)
    await db().delete(user).where(eq(user.id, gone!.id))
    assert.equal((await rpc(forged, "tools/list")).status, 401)
  })

  test("a refreshed token keeps the organization", async () => {
    const t = await tokenFor("emma", { scope: "modelapp offline_access" })
    assert.ok(t.refreshToken)
    const response = await handler(
      new Request(`${ISSUER}/oauth2/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: t.refreshToken!, client_id: t.clientId, resource: RESOURCE }).toString(),
      }),
    )
    const refreshed = (await response.json()) as { access_token: string }
    assert.equal(response.status, 200, JSON.stringify(refreshed))
    assert.equal(decodeJwt(refreshed.access_token).org, "org_kestrel")
  })

  test("the pages' calls: not signed in → /sign-in with the signed request; signing in continues to /oauth/consent; deny → access_denied", async () => {
    const jar: string[] = []
    const send = async (path: string, init: { json?: unknown; query?: Record<string, string> } = {}) => {
      const url = new URL(`${ISSUER}${path}`)
      for (const [k, v] of Object.entries(init.query ?? {})) url.searchParams.set(k, v)
      const response = await handler(new Request(url, { method: init.json ? "POST" : "GET", redirect: "manual", headers: { origin: SITE, accept: "application/json", cookie: jar.join("; "), ...(init.json ? { "content-type": "application/json" } : {}) }, ...(init.json ? { body: JSON.stringify(init.json) } : {}) }))
      for (const c of response.headers.getSetCookie()) jar.push(c.split(";")[0]!)
      return response
    }
    // A client of Ben's own (the token script's way), so the person has not consented to it yet.
    await send("/sign-in/email", { json: { email: accounts.ben, password } })
    const client = (await (await send("/oauth2/create-client", { json: { client_name: "Deny test", redirect_uris: ["http://127.0.0.1:8976/callback"], application_type: "native", token_endpoint_auth_method: "none", grant_types: ["authorization_code"], response_types: ["code"] } })).json()) as { client_id: string }
    await send("/sign-out", { json: {} })
    jar.length = 0
    const query = { response_type: "code", client_id: client.client_id, redirect_uri: "http://127.0.0.1:8976/callback", scope: "modelapp", state: "s1", code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM", code_challenge_method: "S256", resource: RESOURCE }
    const authorized = await send("/oauth2/authorize", { query })
    const toLogin = new URL(authorized.headers.get("location") ?? ((await authorized.json()) as { url: string }).url, SITE)
    assert.equal(toLogin.pathname, "/sign-in")
    const signedIn = (await (await send("/sign-in/email", { json: { email: accounts.ben, password, oauth_query: toLogin.searchParams.toString() } })).json()) as { url?: string }
    const toConsent = new URL(signedIn.url!, SITE)
    assert.equal(toConsent.pathname, "/oauth/consent", "one organization per person: no organization page")
    assert.equal(toConsent.searchParams.get("client_id"), client.client_id)
    const denied = (await (await send("/oauth2/consent", { json: { accept: false, oauth_query: toConsent.searchParams.toString() } })).json()) as { url: string }
    assert.equal(new URL(denied.url).searchParams.get("error"), "access_denied")
  })

  test("the demo button continues an authorization, also from a page left open past its ten minutes; the code gives a token (openid asked, as ChatGPT does) that works here", async () => {
    const jar = new Map<string, string>()
    const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ")
    const send = async (path: string, init: { json?: unknown; query?: Record<string, string>; form?: Record<string, string> } = {}) => {
      const url = new URL(`${ISSUER}${path}`)
      for (const [k, v] of Object.entries(init.query ?? {})) url.searchParams.set(k, v)
      const body = init.json ? JSON.stringify(init.json) : init.form ? new URLSearchParams(init.form).toString() : undefined
      const type = init.json ? "application/json" : init.form ? "application/x-www-form-urlencoded" : null
      const response = await handler(new Request(url, { method: body ? "POST" : "GET", redirect: "manual", headers: { origin: SITE, accept: "application/json", cookie: cookie(), ...(type ? { "content-type": type } : {}) }, ...(body ? { body } : {}) }))
      for (const c of response.headers.getSetCookie()) jar.set(c.slice(0, c.indexOf("=")), c.slice(c.indexOf("=") + 1).split(";")[0]!)
      return response
    }
    // Where a server action's redirect() goes (it throws Next's redirect error).
    const redirectOf = async (action: Promise<unknown>) => {
      const error = await action.then(() => assert.fail("no redirect"), (e: unknown) => e)
      const digest = (error as { digest?: string }).digest ?? ""
      assert.ok(digest.startsWith("NEXT_REDIRECT;"), String(error))
      return new URL(digest.split(";").slice(2, -2).join(";"), SITE)
    }
    const pageQuery = (url: URL) => {
      const record: Record<string, string | string[]> = {}
      for (const key of new Set(url.searchParams.keys())) record[key] = url.searchParams.getAll(key)
      for (const [k, v] of Object.entries(record)) if (v.length === 1) record[k] = v[0]!
      return oauthQueryOf(record)!
    }
    const holds = async (query: string) => verifyOAuthQueryParams(query, (await auth().$context).secret)
    // Signed requests made some minutes ago (better-auth gives them ten).
    const minutesAgo = async <T>(minutes: number, run: () => Promise<T>) => {
      const now = Date.now
      Date.now = () => now() - minutes * 60_000
      try {
        return await run()
      } finally {
        Date.now = now
      }
    }
    const asBrowser = () => new Headers({ origin: SITE, cookie: cookie() })

    // A public client of Emma's own, so she has not agreed to it yet.
    await send("/sign-in/email", { json: { email: accounts.emma, password } })
    const redirectUri = "http://127.0.0.1:8977/callback"
    const client = (await (await send("/oauth2/create-client", { json: { client_name: "Demo button test", redirect_uris: [redirectUri], application_type: "native", token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] } })).json()) as { client_id: string }
    await send("/sign-out", { json: {} })
    jar.clear()
    const verifier = randomBytes(32).toString("base64url")
    const query = { response_type: "code", client_id: client.client_id, redirect_uri: redirectUri, scope: "openid email offline_access modelapp", state: "s-demo", code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256", resource: RESOURCE }
    const toSignIn = async () => {
      const r = await send("/oauth2/authorize", { query })
      const url = new URL(r.headers.get("location") ?? ((await r.json()) as { url: string }).url, SITE)
      assert.equal(url.pathname, "/sign-in")
      return pageQuery(url)
    }

    // On time: the button signs in and better-auth goes on to the consent page.
    const fresh = await redirectOf(signIn(accounts.emma, password, await toSignIn(), asBrowser()))
    assert.equal(fresh.pathname, "/oauth/consent")
    // Past its ten minutes: refused by better-auth, yet the button signs in and starts the same authorization afresh.
    const stale = await minutesAgo(11, toSignIn)
    assert.equal(await holds(stale), false)
    const restarted = await redirectOf(signIn(accounts.emma, password, stale, asBrowser()))
    assert.equal(restarted.pathname, "/oauth/consent")
    const consentQuery = pageQuery(restarted)
    assert.ok(await holds(consentQuery), "a new signed request")
    assert.deepEqual([new URLSearchParams(consentQuery).get("state"), new URLSearchParams(consentQuery).get("code_challenge")], [query.state, query.code_challenge], "the client's own request")

    // Allow on a consent page left open too long: asked again, with a new signed request.
    await send("/sign-in/email", { json: { email: accounts.emma, password } })
    const staleConsent = await minutesAgo(11, async () => pageQuery(new URL(((await (await send("/oauth2/authorize", { query })).json()) as { url: string }).url, SITE)))
    assert.equal(await holds(staleConsent), false)
    const askedAgain = await redirectOf(answerConsent(staleConsent, true, asBrowser()))
    assert.equal(askedAgain.pathname, "/oauth/consent")
    // Allow → the client's redirect with a code; the code and the PKCE verifier give a token the MCP server accepts.
    const back = await redirectOf(answerConsent(pageQuery(askedAgain), true, asBrowser()))
    assert.equal(`${back.origin}${back.pathname}`, redirectUri)
    assert.equal(back.searchParams.get("state"), query.state)
    const token = await handler(
      new Request(`${ISSUER}/oauth2/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: new URLSearchParams({ grant_type: "authorization_code", code: back.searchParams.get("code")!, redirect_uri: redirectUri, client_id: client.client_id, code_verifier: verifier, resource: RESOURCE }).toString(),
      }),
    )
    const tokens = (await token.json()) as { access_token: string; refresh_token?: string }
    assert.equal(token.status, 200, JSON.stringify(tokens))
    assert.deepEqual(decodeJwt(tokens.access_token).aud, [RESOURCE, `${ISSUER}/oauth2/userinfo`], "openid asked: better-auth adds its userinfo endpoint")
    const listed = await rpc(tokens.access_token, "tools/list")
    assert.equal(listed.status, 200, JSON.stringify(listed))
    assert.ok(tokens.refresh_token)

    // Allowed already (ChatGPT connecting again): the button sends the person straight back with a code, the
    // client's own state, and the issuer (RFC 9207).
    await send("/sign-out", { json: {} })
    jar.clear()
    const again = await redirectOf(signIn(accounts.emma, password, await toSignIn(), asBrowser()))
    assert.equal(`${again.origin}${again.pathname}`, redirectUri)
    assert.deepEqual([...again.searchParams.keys()].sort(), ["code", "iss", "state"])
    assert.deepEqual([again.searchParams.get("state"), again.searchParams.get("iss")], [query.state, ISSUER])
    // A page opened two hours ago: the app has moved on (its code would be refused there): told so, not sent back.
    const ancient = await minutesAgo(120, toSignIn)
    const told = await redirectOf(signIn(accounts.emma, password, ancient, asBrowser()))
    assert.equal(told.pathname, "/sign-in")
    assert.match(told.searchParams.get("error") ?? "", /start connecting again from the app/)
    assert.equal(told.searchParams.get("code"), null)
  })

  test("npm run token over real HTTP (sign in → authorize → consent → token), then the conformance checks on it", { timeout: 90_000 }, async () => {
    // The site on a socket: /api/auth/* → better-auth, the rest → the MAP route (what Next does with withModelApp's rewrites).
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = []
      for await (const c of req) chunks.push(c as Buffer)
      const headers = new Headers()
      for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(", ") : v)
      const request = new Request(`${SITE}${req.url}`, { method: req.method, headers, ...(chunks.length ? { body: Buffer.concat(chunks) } : {}) })
      const response = req.url!.startsWith("/api/auth/") ? await handler(request) : await route[(req.method ?? "GET") as "GET"](request)
      const out: Record<string, string | string[]> = {}
      response.headers.forEach((v, k) => (out[k] = v))
      if (response.headers.getSetCookie().length) out["set-cookie"] = response.headers.getSetCookie()
      res.writeHead(response.status, out).end(Buffer.from(await response.arrayBuffer()))
    })
    await new Promise<void>((r) => server.listen(3921, "localhost", r))
    try {
      const run = (env: Record<string, string>) =>
        new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
          const child = spawn(process.execPath, ["--import", "tsx", "scripts/oauth-token.ts", SITE], { cwd: new URL("..", import.meta.url).pathname, env: { ...process.env, ...env } })
          let out = ""
          let err = ""
          child.stdout.on("data", (d) => (out += d))
          child.stderr.on("data", (d) => (err += d))
          child.on("close", (code) => resolve({ code, out, err }))
        })
      const ok = await run({ MODELAPP_OAUTH_EMAIL: accounts.alice, MODELAPP_OAUTH_PASSWORD: password })
      assert.equal(ok.code, 0, ok.err)
      const token = ok.out.trim()
      assert.deepEqual([decodeJwt(token).aud, decodeJwt(token).org], [RESOURCE, "org_orbit"])
      const report = await checkApp({ url: SITE, token })
      assert.ok(report.ok && report.complete, formatReport(report))
      const wrong = await run({ MODELAPP_OAUTH_EMAIL: accounts.alice, MODELAPP_OAUTH_PASSWORD: "not-the-password" })
      assert.equal(wrong.code, 1)
      assert.match(wrong.err, /sign in: 401/)
    } finally {
      await new Promise((r) => server.close(r))
    }
  })
})

// The same claims, re-signed with better-auth's own key: a token better-auth could have signed with other claims.
async function resign(token: string, changes: Record<string, unknown>, typ = "at+jwt"): Promise<string> {
  const { signJWT } = await import("better-auth/plugins")
  const claims: Record<string, unknown> = { ...decodeJwt(token), ...changes }
  for (const [k, v] of Object.entries(changes)) if (v === undefined) delete claims[k]
  const jwtPlugin = (auth().options.plugins as { id: string; options?: unknown }[]).find((p) => p.id === "jwt")!
  return signJWT({ context: await auth().$context } as never, { options: jwtPlugin.options as never, payload: claims, header: { typ } } as never)
}

async function foreign(token: string): Promise<string> {
  const { privateKey } = await generateKeyPair("EdDSA")
  return new SignJWT(decodeJwt(token)).setProtectedHeader({ alg: "EdDSA", typ: "at+jwt", kid: decodeProtectedHeader(token).kid! }).sign(privateKey)
}
