import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import { createServer } from "node:http"
import { before, describe, test } from "node:test"
import { z } from "zod"

import { cimd } from "@better-auth/cimd"
import { mcp } from "@better-auth/mcp"
import { betterAuth } from "better-auth"
import { APIError } from "better-auth/api"
import { getMigrations } from "better-auth/db/migration"
import { admin, jwt, organization } from "better-auth/plugins"
import { decodeJwt, decodeProtectedHeader, SignJWT, generateKeyPair } from "jose"

import { checkApp, formatReport } from "@modelapp/spec"
import { defineApp } from "@modelapp/server"

import { betterAuthBridge } from "./better-auth"
import { toNextHandlers } from "./index"
import { oauthAccessToken } from "./testing/oauth-flow"
import { pglitePool } from "./testing/pglite-pool"

// The better-auth bridge against a REAL better-auth 1.7.7 instance (organization + jwt + mcp + cimd, the canonical
// config of the README) on PGlite, in-process (auth.handler), served through toNextHandlers as a Next route would.

const SITE = "http://localhost:3944"
const RESOURCE = `${SITE}/mcp`
const ISSUER = `${SITE}/api/auth`
// A metadata-document client (CIMD), its document served by the fake transport below.
const CLIENT_ID = "https://client.example.test/oauth/client.json"
const REDIRECT = "http://127.0.0.1:8976/callback"
const clientDocument = { client_id: CLIENT_ID, client_name: "Example MCP client", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }

const pool = pglitePool()
function makeAuth(resource = RESOURCE) {
  return betterAuth({
    baseURL: SITE,
    secret: randomBytes(32).toString("base64url"),
    database: pool,
    emailAndPassword: { enabled: true },
    disabledPaths: ["/token"],
    plugins: [
      organization(),
      admin(),
      jwt({ disableSettingJwtHeader: true }),
      mcp({
        resource,
        loginPage: "/sign-in",
        consentPage: "/oauth/consent",
        scopes: ["openid", "profile", "email", "offline_access", "modelapp"],
        postLogin: {
          page: "/oauth/organization",
          shouldRedirect: ({ session }) => !session.activeOrganizationId,
          consentReferenceId: ({ session }) => {
            if (!session.activeOrganizationId) throw new APIError("BAD_REQUEST", { error: "invalid_request", error_description: "choose an organization first" })
            return session.activeOrganizationId as string
          },
        },
        customAccessTokenClaims: ({ referenceId }) => (referenceId ? { org: referenceId } : {}),
      }),
      cimd({
        metadataProfile: "mcp-2026-07-28",
        // The real transport (@better-auth/cimd/node) pins DNS; the test serves the one document itself.
        fetchClientMetadataResource: async (input) => {
          const url = String(input instanceof Request ? input.url : input)
          return url === CLIENT_ID ? Response.json(clientDocument, { headers: { "cache-control": "max-age=300" } }) : new Response("not found", { status: 404 })
        },
      }),
    ],
  })
}
const auth = makeAuth()
const handler = (request: Request) => auth.handler(request)

// The app: deals per organization; members see deals, owners also the amounts.
const deals = [
  { id: "d1", title: "Alpha renewal", amount: 1200, org: "" },
  { id: "d2", title: "Beta pilot", amount: 300, org: "" },
]
const app = defineApp({
  name: "deals",
  title: "Deals",
  version: "1.0.0",
  auth: {
    ...betterAuthBridge(auth, { caller: ({ roles }) => ({ permissions: roles.includes("owner") ? "all" : ["deals.view"] }) }),
    resource: RESOURCE,
  },
  permissions: { "deals.view": { label: "See deals", default: true }, "deals.amount": { label: "See amounts" } },
  entities: {
    deal: {
      label: "Deal",
      permission: "deals.view",
      schema: z.object({ id: z.string(), title: z.string().meta({ role: "title", search: true }), amount: z.number().meta({ permission: "deals.amount" }) }),
      get: (id, ctx) => deals.find((d) => d.id === id && d.org === ctx.installation) ?? null,
      list: (_q, ctx) => ({ rows: deals.filter((d) => d.org === ctx.installation).map(({ org: _org, ...d }) => d) }),
    },
  },
})
const route = toNextHandlers(app, { publicUrl: SITE })

type Ctx = { adapter: { create: (q: { model: string; data: Record<string, unknown> }) => Promise<{ id: string }>; update: (q: { model: string; where: { field: string; value: unknown }[]; update: Record<string, unknown> }) => Promise<unknown>; delete: (q: { model: string; where: { field: string; value: unknown }[] }) => Promise<void> } }
let ctx: Ctx
const people = { ada: { email: "ada@example.test", password: randomBytes(12).toString("base64url"), id: "" }, bea: { email: "bea@example.test", password: randomBytes(12).toString("base64url"), id: "" } }
const orgs = { a: "", b: "" }

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
const listDeals = async (token: string) => ((await rpc(token, "tools/call", { name: "deal_list", arguments: {} })).result as { structuredContent: { rows: Record<string, unknown>[] } }).structuredContent.rows
const tokenFor = (who: { email: string; password: string }, organizationId?: string, extra: Partial<Parameters<typeof oauthAccessToken>[0]> = {}) =>
  oauthAccessToken({ authBaseURL: ISSUER, resource: RESOURCE, signIn: { email: who.email, password: who.password }, client: { clientId: CLIENT_ID, redirectUri: REDIRECT }, fetch: handler, ...(organizationId ? { organizationId } : {}), ...extra })

before(async () => {
  const { runMigrations } = await getMigrations(auth.options)
  await runMigrations()
  ctx = (await auth.$context) as unknown as Ctx
  for (const p of Object.values(people)) p.id = (await auth.api.signUpEmail({ body: { email: p.email, password: p.password, name: p.email.split("@")[0]! } })).user.id
  orgs.a = (await ctx.adapter.create({ model: "organization", data: { name: "Org A", slug: "org-a", createdAt: new Date() } })).id
  orgs.b = (await ctx.adapter.create({ model: "organization", data: { name: "Org B", slug: "org-b", createdAt: new Date() } })).id
  await ctx.adapter.create({ model: "member", data: { organizationId: orgs.a, userId: people.ada.id, role: "owner", createdAt: new Date() } })
  await ctx.adapter.create({ model: "member", data: { organizationId: orgs.b, userId: people.bea.id, role: "member", createdAt: new Date() } })
  deals[0]!.org = orgs.a
  deals[1]!.org = orgs.b
})

describe("betterAuthBridge with a real better-auth (PGlite)", () => {
  test("the metadata: protected resource names the better-auth issuer; its AS metadata is served at the root (RFC 8414, OIDC)", async () => {
    const prm = (await (await route.GET(new Request(`${SITE}/.well-known/oauth-protected-resource/mcp`))).json()) as { resource: string; authorization_servers: string[] }
    assert.deepEqual(prm, { ...prm, resource: RESOURCE, authorization_servers: [ISSUER] })
    for (const path of ["/.well-known/oauth-authorization-server/api/auth", "/.well-known/openid-configuration/api/auth"]) {
      const response = await route.GET(new Request(`${SITE}${path}`))
      assert.equal(response.status, 200, path)
      const meta = (await response.json()) as Record<string, unknown>
      assert.equal(meta.issuer, ISSUER)
      assert.deepEqual(meta.code_challenge_methods_supported, ["S256"])
      assert.equal(meta.client_id_metadata_document_supported, true)
      assert.equal(meta.authorization_endpoint, `${ISSUER}/oauth2/authorize`)
      assert.ok(!("registration_endpoint" in meta), "no dynamic client registration in the canonical config")
    }
    assert.equal((await route.GET(new Request(`${SITE}/.well-known/oauth-authorization-server`))).status, 404, "the issuer has a path: not at the bare address")
    // The OIDC address under the issuer is better-auth's own (auth.handler), not the bridge's.
    assert.equal(((await (await handler(new Request(`${ISSUER}/.well-known/openid-configuration`))).json()) as { issuer: string }).issuer, ISSUER)
    assert.equal((await route.POST(new Request(`${SITE}/.well-known/oauth-authorization-server/api/auth`, { method: "POST" }))).status, 405)
  })

  test("no token: 401 with WWW-Authenticate pointing at the protected-resource metadata", async () => {
    const r = await rpc(null, "tools/list")
    assert.equal(r.status, 401)
    assert.match(r.headers.get("www-authenticate") ?? "", new RegExp(`resource_metadata="${SITE}/.well-known/oauth-protected-resource/mcp"`))
  })

  test("the full flow gives an audience-bound JWT; it lists tools and reads its own organization's data", async () => {
    const t = await tokenFor(people.ada)
    const header = decodeProtectedHeader(t.accessToken)
    const claims = decodeJwt(t.accessToken)
    assert.equal(header.typ, "at+jwt")
    assert.equal(claims.iss, ISSUER)
    assert.equal(claims.aud, RESOURCE)
    assert.equal(claims.org, orgs.a)
    assert.equal(t.organizationId, orgs.a)
    const tools = ((await rpc(t.accessToken, "tools/list")).result as { tools: { name: string }[] }).tools.map((x) => x.name)
    assert.ok(tools.includes("deal_list"), tools.join(","))
    assert.deepEqual(await listDeals(t.accessToken), [{ id: "d1", title: "Alpha renewal", amount: 1200 }])
    // The whole conformance suite with this token, through the route.
    const report = await checkApp({ url: SITE, token: t.accessToken, fetch: (r) => route[r.method as "GET"](r) })
    assert.ok(report.ok && report.complete, formatReport(report))
  })

  test("a user of org A can't read org B; org B's member sees B's deals, without the amounts", async () => {
    const a = await tokenFor(people.ada)
    const got = (await rpc(a.accessToken, "tools/call", { name: "deal_get", arguments: { id: "d2" } })).result as { isError?: boolean; structuredContent?: unknown }
    assert.equal(got.isError, true, JSON.stringify(got))
    const b = await tokenFor(people.bea)
    assert.deepEqual(await listDeals(b.accessToken), [{ id: "d2", title: "Beta pilot" }])
  })

  test("the organization comes from the token, never from parameters or headers", async () => {
    const b = await tokenFor(people.bea)
    const r = await rpc(b.accessToken, "tools/call", { name: "deal_list", arguments: { installation: orgs.a, org: orgs.a } })
    const rows = (r.result as { structuredContent?: { rows: { id: string }[] } } | undefined)?.structuredContent?.rows ?? []
    assert.ok(!rows.some((x) => x.id === "d1"), JSON.stringify(r))
    // Asking for an organization the person doesn't belong to: better-auth refuses to make it active.
    await assert.rejects(tokenFor(people.bea, orgs.a), /set active organization: 403|set active organization: 4\d\d/)
  })

  test("a token for another audience is refused", async () => {
    const other = await tokenFor(people.ada, undefined, { resource: "http://localhost:3944/other-mcp" }).catch((e: Error) => e)
    // better-auth itself refuses a resource it doesn't serve; a token signed for another server by the same keys is refused by the bridge.
    assert.ok(other instanceof Error, "better-auth issued a token for an unknown resource")
    const t = await tokenFor(people.ada)
    const forged = await resign(t.accessToken, { aud: "https://other.example.test/mcp" })
    const r = await rpc(forged, "tools/list")
    assert.equal(r.status, 401)
    assert.match(r.text ?? "", /another server/)
  })

  test("tampered, expired, opaque, DPoP-bound, multi-audience and scope-less tokens are refused", async () => {
    const t = await tokenFor(people.ada)
    const [h, p, s] = t.accessToken.split(".")
    const body = JSON.parse(Buffer.from(p!, "base64url").toString())
    const tampered = `${h}.${Buffer.from(JSON.stringify({ ...body, org: orgs.b })).toString("base64url")}.${s}`
    const cases: [string, string, RegExp][] = [
      ["tampered", tampered, /not valid/],
      ["expired", await resign(t.accessToken, { exp: Math.floor(Date.now() / 1000) - 120, iat: Math.floor(Date.now() / 1000) - 3600 }), /expired/],
      ["opaque", "aBcDeFgHiJkLmNoPqRsTuVwXyZ012345", /not a JWT/],
      ["dpop", await resign(t.accessToken, { cnf: { jkt: "x" } }), /DPoP/],
      ["two audiences", await resign(t.accessToken, { aud: [RESOURCE, "https://other.example.test/mcp"] }), /several servers/],
      ["no scope", await resign(t.accessToken, { scope: "openid profile" }), /modelapp scope/],
      ["no org", await resign(t.accessToken, { org: undefined }), /no organization/],
      ["foreign key", await foreign(t.accessToken), /not valid/],
      ["wrong typ", await resign(t.accessToken, {}, "JWT"), /typ|not valid/],
    ]
    for (const [name, token, reason] of cases) {
      const r = await rpc(token, "tools/list")
      assert.equal(r.status, 401, name)
      assert.match(r.headers.get("www-authenticate") ?? "", reason, name)
    }
    // Within the 30 s clock skew an expiry just passed still counts.
    const justExpired = await resign(t.accessToken, { exp: Math.floor(Date.now() / 1000) - 10 })
    assert.equal((await rpc(justExpired, "tools/list")).status, 200)
  })

  test("membership revoked after issuance → refused; role changed → permissions change on the next call", async () => {
    const carl = { email: "carl@example.test", password: randomBytes(12).toString("base64url") }
    const carlId = (await auth.api.signUpEmail({ body: { ...carl, name: "carl" } })).user.id
    const member = await ctx.adapter.create({ model: "member", data: { organizationId: orgs.a, userId: carlId, role: "member", createdAt: new Date() } })
    const t = await tokenFor(carl)
    assert.deepEqual(await listDeals(t.accessToken), [{ id: "d1", title: "Alpha renewal" }])
    await ctx.adapter.update({ model: "member", where: [{ field: "id", value: member.id }], update: { role: "member,owner" } })
    assert.deepEqual(await listDeals(t.accessToken), [{ id: "d1", title: "Alpha renewal", amount: 1200 }])
    await ctx.adapter.delete({ model: "member", where: [{ field: "id", value: member.id }] })
    const r = await rpc(t.accessToken, "tools/list")
    assert.equal(r.status, 401)
    assert.match(r.headers.get("www-authenticate") ?? "", /not a member/)
  })

  test("a banned or deleted user has no access with a token issued before", async () => {
    const dan = { email: "dan@example.test", password: randomBytes(12).toString("base64url") }
    const danId = (await auth.api.signUpEmail({ body: { ...dan, name: "dan" } })).user.id
    await ctx.adapter.create({ model: "member", data: { organizationId: orgs.a, userId: danId, role: "member", createdAt: new Date() } })
    const t = await tokenFor(dan)
    assert.equal((await rpc(t.accessToken, "tools/list")).status, 200)
    await ctx.adapter.update({ model: "user", where: [{ field: "id", value: danId }], update: { banned: true } })
    assert.match((await rpc(t.accessToken, "tools/list")).headers.get("www-authenticate") ?? "", /banned/)
    await ctx.adapter.update({ model: "user", where: [{ field: "id", value: danId }], update: { banned: false } })
    assert.equal((await rpc(t.accessToken, "tools/list")).status, 200)
    await ctx.adapter.delete({ model: "member", where: [{ field: "userId", value: danId }] })
    await ctx.adapter.delete({ model: "session", where: [{ field: "userId", value: danId }] })
    await ctx.adapter.delete({ model: "account", where: [{ field: "userId", value: danId }] })
    await ctx.adapter.delete({ model: "user", where: [{ field: "id", value: danId }] })
    assert.match((await rpc(t.accessToken, "tools/list")).headers.get("www-authenticate") ?? "", /no longer exists/)
  })

  test("the pages, step by step: sign-in → organization page → /oauth2/continue → consent page → /oauth2/consent → code", async () => {
    // A person who has never consented to this client (a stored consent skips the consent page).
    const erin = { email: "erin@example.test", password: randomBytes(12).toString("base64url") }
    const erinId = (await auth.api.signUpEmail({ body: { ...erin, name: "erin" } })).user.id
    await ctx.adapter.create({ model: "member", data: { organizationId: orgs.b, userId: erinId, role: "member", createdAt: new Date() } })
    const jar: string[] = []
    const send = async (path: string, init: { json?: unknown; query?: Record<string, string> } = {}) => {
      const url = new URL(`${ISSUER}${path}`)
      for (const [k, v] of Object.entries(init.query ?? {})) url.searchParams.set(k, v)
      const response = await handler(
        new Request(url, { method: init.json ? "POST" : "GET", redirect: "manual", headers: { origin: SITE, accept: "application/json", cookie: jar.join("; "), ...(init.json ? { "content-type": "application/json" } : {}) }, ...(init.json ? { body: JSON.stringify(init.json) } : {}) }),
      )
      for (const c of response.headers.getSetCookie()) jar.push(c.split(";")[0]!)
      return response
    }
    const query = { response_type: "code", client_id: CLIENT_ID, redirect_uri: REDIRECT, scope: "modelapp", state: "s1", code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM", code_challenge_method: "S256", resource: RESOURCE }
    // Not signed in: authorize sends the person to the login page with the signed request.
    // (A browser navigates and gets a 302; a fetch that asks for JSON gets { url } — the same address.)
    const authorized = await send("/oauth2/authorize", { query })
    const toLogin = new URL(authorized.headers.get("location") ?? ((await authorized.json()) as { url: string }).url, SITE)
    assert.equal(toLogin.pathname, "/sign-in")
    assert.ok(toLogin.searchParams.get("sig"))
    // The login page signs in with oauth_query (the oauthProviderClient() client plugin adds it from window.location.search): better-auth answers where to go next.
    const signedIn = (await (await send("/sign-in/email", { json: { email: erin.email, password: erin.password, oauth_query: toLogin.searchParams.toString() } })).json()) as { url?: string; redirect?: boolean }
    // `{ redirect: true, url }`: the better-auth client navigates there by itself (its redirect fetch plugin).
    assert.equal(signedIn.redirect, true)
    const toOrg = new URL(signedIn.url!, SITE)
    assert.equal(toOrg.pathname, "/oauth/organization", "a fresh session has no active organization: postLogin.page")
    // The organization page: set the active organization, then continue with postLogin: true.
    assert.equal((await send("/organization/set-active", { json: { organizationId: orgs.b } })).status, 200)
    const continued = (await (await send("/oauth2/continue", { json: { postLogin: true, oauth_query: toOrg.searchParams.toString() } })).json()) as { url?: string; redirect?: boolean }
    assert.deepEqual(Object.keys(continued).sort(), ["redirect", "url"], JSON.stringify(continued))
    const toConsent = new URL(continued.url!, SITE)
    assert.equal(toConsent.pathname, "/oauth/consent")
    // The consent page: who asks (GET /oauth2/public-client), then accept (or accept: false to deny).
    const client = (await (await send("/oauth2/public-client", { query: { client_id: toConsent.searchParams.get("client_id")! } })).json()) as { client_name?: string }
    assert.equal(client.client_name, "Example MCP client")
    assert.equal(toConsent.searchParams.get("scope"), "modelapp")
    assert.equal(toConsent.searchParams.get("resource"), RESOURCE)
    const accepted = (await (await send("/oauth2/consent", { json: { accept: true, oauth_query: toConsent.searchParams.toString() } })).json()) as { url?: string; redirect?: boolean }
    assert.deepEqual(Object.keys(accepted).sort(), ["redirect", "url"], JSON.stringify(accepted))
    const back = new URL(accepted.url!)
    assert.equal(`${back.origin}${back.pathname}`, REDIRECT)
    assert.ok(back.searchParams.get("code"))
    assert.equal(back.searchParams.get("state"), "s1")
    assert.equal(back.searchParams.get("iss"), ISSUER)
  })

  test("the HTTP helper's own client (/oauth2/create-client for the signed-in person) gets a token for the resource too", async () => {
    const t = await oauthAccessToken({ authBaseURL: ISSUER, resource: RESOURCE, signIn: { email: people.bea.email, password: people.bea.password }, fetch: handler })
    assert.notEqual(t.clientId, CLIENT_ID)
    assert.deepEqual(await listDeals(t.accessToken), [{ id: "d2", title: "Beta pilot" }])
  })

  test("scripts/oauth-token.ts over real HTTP (sign in → organization → authorize → consent → token), then modelapp check", { timeout: 60_000 }, async () => {
    // The site on a socket: /api/auth/* → better-auth, everything else → the MAP route (what Next does with the rewrites).
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
    await new Promise<void>((r) => server.listen(3944, "localhost", r))
    try {
      const run = (env: Record<string, string>) =>
        new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
          const child = spawn("npx", ["tsx", "scripts/oauth-token.ts", SITE], { cwd: new URL("..", import.meta.url).pathname, env: { ...process.env, ...env } })
          let out = ""
          let err = ""
          child.stdout.on("data", (d) => (out += d))
          child.stderr.on("data", (d) => (err += d))
          child.on("close", (code) => resolve({ code, out, err }))
        })
      const ok = await run({ MODELAPP_OAUTH_EMAIL: people.ada.email, MODELAPP_OAUTH_PASSWORD: people.ada.password })
      assert.equal(ok.code, 0, ok.err)
      const token = ok.out.trim()
      assert.equal(decodeJwt(token).aud, RESOURCE)
      assert.equal(decodeJwt(token).org, orgs.a)
      const report = await checkApp({ url: SITE, token })
      assert.ok(report.ok && report.complete, formatReport(report))
      const wrong = await run({ MODELAPP_OAUTH_EMAIL: people.ada.email, MODELAPP_OAUTH_PASSWORD: "not-the-password" })
      assert.equal(wrong.code, 1)
      assert.match(wrong.err, /sign in: 401/)
      const none = await run({})
      assert.match(none.err, /MODELAPP_OAUTH_EMAIL/)
    } finally {
      await new Promise((r) => server.close(r))
    }
  })

  test("a refreshed token keeps the organization", async () => {
    const t = await tokenFor(people.bea, undefined, { scope: "modelapp offline_access" })
    assert.ok(t.refreshToken, "offline_access gives a refresh token")
    const response = await handler(
      new Request(`${ISSUER}/oauth2/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: t.refreshToken!, client_id: t.clientId, resource: RESOURCE }).toString(),
      }),
    )
    const refreshed = (await response.json()) as { access_token: string }
    assert.equal(response.status, 200, JSON.stringify(refreshed))
    assert.equal(decodeJwt(refreshed.access_token).org, orgs.b)
    assert.deepEqual(await listDeals(refreshed.access_token), [{ id: "d2", title: "Beta pilot" }])
  })

  test("a resource the mcp plugin doesn't serve is a configuration error, not a silent accept", async () => {
    const wrong = defineApp({ name: "wrong", title: "Wrong", version: "1.0.0", auth: { ...betterAuthBridge(auth, { caller: () => ({ permissions: "all" }) }), resource: "http://localhost:3944/elsewhere/mcp" }, entities: {} })
    const t = await tokenFor(people.ada)
    const r = await wrong.fetch(new Request("http://localhost:3944/mcp", { method: "POST", headers: { authorization: `Bearer ${t.accessToken}`, "content-type": "application/json" }, body: "{}" }))
    assert.equal(r.status, 401)
  })

  test("the caller callback: its null refuses; a missing plugin is an error at start", async () => {
    const refusing = defineApp({ name: "refusing", title: "Refusing", version: "1.0.0", auth: { ...betterAuthBridge(auth, { caller: () => null }), resource: RESOURCE }, entities: {} })
    const t = await tokenFor(people.ada)
    const r = await refusing.fetch(new Request(`${SITE}/mcp`, { method: "POST", headers: { authorization: `Bearer ${t.accessToken}`, "content-type": "application/json" }, body: "{}" }))
    assert.equal(r.status, 401)
    assert.match(r.headers.get("www-authenticate") ?? "", /refused/)
    const bare = betterAuth({ baseURL: SITE, secret: randomBytes(32).toString("base64url"), database: pool, plugins: [jwt()] })
    assert.throws(() => betterAuthBridge(bare as never, { caller: () => null }), /mcp\(\{ … \}\).*organization\(\)/)
  })
})

// The same claims re-signed with the instance's own key (the test reaches into the jwks table): what a token that
// better-auth itself signed with other claims looks like — the bridge must refuse it on the claims alone.
async function resign(token: string, changes: Record<string, unknown>, typ = "at+jwt"): Promise<string> {
  const { signJWT } = await import("better-auth/plugins")
  const claims = { ...decodeJwt(token), ...changes }
  for (const [k, v] of Object.entries(changes)) if (v === undefined) delete (claims as Record<string, unknown>)[k]
  const authCtx = await auth.$context
  const jwtPlugin = (auth.options.plugins as { id: string; options?: unknown }[]).find((p) => p.id === "jwt")!
  return signJWT({ context: authCtx } as never, { options: jwtPlugin.options as never, payload: claims, header: { typ } } as never)
}

async function foreign(token: string): Promise<string> {
  const { privateKey } = await generateKeyPair("EdDSA")
  return new SignJWT(decodeJwt(token)).setProtectedHeader({ alg: "EdDSA", typ: "at+jwt", kid: decodeProtectedHeader(token).kid! }).sign(privateKey)
}
