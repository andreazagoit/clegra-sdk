// Clegra as an OAuth client of this CRM, the way it links a person's account (apps/node/lib/kernel/oauth.ts, the
// core's client documents and callback in packages/platform/lib/app-link): against the CRM's real better-auth 1.7.7
// (mcp + cimd), in-process on PGlite. Clegra's metadata documents and key set are served by a fake core transport,
// since better-auth fetches a client_id only from a public https address.
import assert from "node:assert/strict"
import { randomBytes } from "node:crypto"
import { describe, test } from "node:test"

const SITE = "http://localhost:3922"
process.env.CLEGRA_PUBLIC_URL = SITE
// The node's client calls http only on a development host (apps/node/lib/kernel/mcp-client.ts allowedUrl).
process.env.PLUGIN_DEV_HOSTS = "localhost:3922"
process.env.MAIL_CREDENTIALS_KEY ??= randomBytes(32).toString("base64")
process.env.CLIENT_ORIGINS = "https://app.clegra.test"
const { password } = await import("./setup")

import { toNextHandlers } from "clegra/next"

import { createAuth } from "../lib/auth"
import { createCrmApp } from "../clegra/app"
import { crmAuth } from "../clegra/auth"

import { appLinkCallback } from "../../../../packages/platform/lib/app-link/callback"
import { appLinkClientId, appLinkRedirectUri, clientDocument } from "../../../../packages/platform/lib/app-link/client"
import { clientJwks, newAppLinkClientKey, parseClientKey, signClientAssertion } from "../../../../packages/platform/lib/app-link/assertion"
import { appLinkStateKey, signAppLinkState } from "../../../../packages/platform/lib/app-link/state"
import {
  authorizationUrl,
  checkIssuer,
  chooseScopes,
  discoverResource,
  discoverServer,
  exchangeCode,
  OAuthFlowError,
  parseBearerChallenge,
  pkcePair,
  refreshTokens,
  revokeToken,
  type ClientCredentials,
  type Fetcher,
} from "../../../../apps/node/lib/kernel/oauth"

const CORE = "https://account.clegra.com"
const RESOURCE = `${SITE}/mcp`
const ISSUER = `${SITE}/api/auth`
const NODE_ID = "6f1c1f3e-8f7a-4d3e-9a51-2b0c5f6d7e81"

// The core: Clegra's two client documents and its key set (packages/platform/lib/app-link), served in-process.
const key = parseClientKey(newAppLinkClientKey())!
const coreFetches: string[] = []
const coreTransport = (async (input: RequestInfo | URL) => {
  const url = new URL(input instanceof Request ? input.url : String(input))
  coreFetches.push(url.pathname)
  const body = url.pathname === "/oauth/client.json" ? clientDocument(CORE, "private_key_jwt") : url.pathname === "/oauth/public-client.json" ? clientDocument(CORE, "none") : url.pathname === "/oauth/jwks.json" ? clientJwks({ current: key, next: null }) : null
  if (url.origin !== CORE || !body) return new Response("not found", { status: 404 })
  return Response.json(body, { headers: { "cache-control": "public, max-age=3600" } })
}) as Parameters<typeof createAuth>[1]

// The CRM, its better-auth fetching client documents from the fake core.
;(globalThis as { __crmAuth?: ReturnType<typeof createAuth> }).__crmAuth = createAuth(process.env, coreTransport)
const auth = (globalThis as { __crmAuth?: ReturnType<typeof createAuth> }).__crmAuth!
const route = toNextHandlers(createCrmApp({ auth: crmAuth() }), { publicUrl: SITE })

/** The network as the node sees it: the CRM's site (MCP, well-known metadata, better-auth). */
const crm: Fetcher = async (url, init) => {
  const u = new URL(url)
  const request = new Request(u.pathname === "/mcp" ? `${SITE}/api/clegra/mcp` : url, { method: init.method, headers: init.headers, ...(init.body !== undefined ? { body: init.body } : {}) })
  const response = u.pathname.startsWith("/api/auth/") ? await auth.handler(request) : init.method === "POST" ? await route.POST(request) : await route.GET(request)
  return { status: response.status, headers: response.headers, text: () => response.text() }
}

/** Clegra's client: private_key_jwt with the core's assertion, or public. */
const clients: Record<"private_key_jwt" | "none", ClientCredentials> = {
  private_key_jwt: { clientId: appLinkClientId(CORE, "private_key_jwt"), auth: "private_key_jwt", assertion: async (audience) => signClientAssertion({ core: CORE, audience, key }) },
  none: { clientId: appLinkClientId(CORE, "none"), auth: "none" },
}

/** The person in the browser: signs in, consents, and is sent to the redirect URI. Returns where they land. */
async function personAuthorizes(authorizeUrl: string, email: string): Promise<URL> {
  const jar: string[] = []
  const call = async (url: string | URL, init: { json?: unknown } = {}) => {
    const response = await auth.handler(new Request(url, { method: init.json ? "POST" : "GET", redirect: "manual", headers: { origin: SITE, accept: "application/json", cookie: jar.join("; "), ...(init.json ? { "content-type": "application/json" } : {}) }, ...(init.json ? { body: JSON.stringify(init.json) } : {}) }))
    for (const c of response.headers.getSetCookie()) jar.push(c.split(";")[0]!)
    return response
  }
  const toSignIn = await call(authorizeUrl)
  const signInPage = new URL(toSignIn.headers.get("location") ?? ((await toSignIn.json()) as { url: string }).url, SITE)
  assert.equal(signInPage.pathname, "/sign-in")
  const signedIn = (await (await call(`${ISSUER}/sign-in/email`, { json: { email, password, oauth_query: signInPage.searchParams.toString() } })).json()) as { url: string }
  const consentPage = new URL(signedIn.url, SITE)
  assert.equal(consentPage.pathname, "/oauth/consent")
  // What the consent page shows: the client's name from its metadata document.
  const shown = (await (await call(`${ISSUER}/oauth2/public-client?client_id=${encodeURIComponent(consentPage.searchParams.get("client_id")!)}`)).json()) as { client_name?: string }
  assert.equal(shown.client_name, "Clegra")
  const consented = (await (await call(`${ISSUER}/oauth2/consent`, { json: { accept: true, oauth_query: consentPage.searchParams.toString() } })).json()) as { url: string }
  return new URL(consented.url)
}

/** The whole link, as the node and the core do it; returns the tokens. */
async function link(client: ClientCredentials, email = "alice@orbit.example") {
  // 1. The app refuses a call without a token and names its metadata.
  const refused = await crm(RESOURCE, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) })
  assert.equal(refused.status, 401)
  const resource = await discoverResource(RESOURCE, parseBearerChallenge(refused.headers.get("www-authenticate")), crm)
  assert.deepEqual(resource.authorizationServers, [ISSUER])
  // 2. Its authorization server: issuer, PKCE, metadata documents, and how Clegra authenticates there.
  const server = await discoverServer(ISSUER, crm)
  assert.equal(server.clientAuth, "private_key_jwt")
  assert.equal(server.issParameter, true)
  // 3. The authorization request: PKCE, state, resource, scopes.
  const { verifier, challenge } = pkcePair()
  const state = signAppLinkState({ nodeId: NODE_ID, client: "https://app.clegra.test", key: randomBytes(32).toString("base64url"), expiresAt: Date.now() + 600_000 }, appLinkStateKey())
  const scope = chooseScopes(undefined, resource.scopes, server.scopes)
  assert.equal(scope, "clegra offline_access")
  const landed = await personAuthorizes(authorizationUrl({ endpoint: server.authorizationEndpoint, clientId: client.clientId, redirectUri: appLinkRedirectUri(CORE), state, challenge, resource: RESOURCE, scope }), email)
  assert.equal(`${landed.origin}${landed.pathname}`, appLinkRedirectUri(CORE))
  // 4. The core bounces the answer to the client, which hands it in to the node.
  const bounced = await appLinkCallback(new Request(landed), async (id) => id === NODE_ID)
  const answer = new URL(bounced.headers.get("location")!).searchParams
  assert.equal(answer.get("appLinkState"), state)
  // 5. The node: iss checked, then the code traded at the recorded issuer.
  checkIssuer(answer.get("appLinkIss"), server.issuer, server.issParameter)
  const tokens = await exchangeCode({ tokenEndpoint: server.tokenEndpoint, code: answer.get("appLinkCode")!, verifier, redirectUri: appLinkRedirectUri(CORE), resource: RESOURCE, scope, client }, crm)
  return { tokens, server }
}

async function mcp(token: string, method: string, params: Record<string, unknown> = {}) {
  const r = await crm(RESOURCE, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18", authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })
  const text = await r.text()
  if (r.status !== 200) return { status: r.status }
  const data = text.startsWith("{") ? JSON.parse(text) : JSON.parse(text.split("\n").filter((l) => l.startsWith("data:")).pop()!.slice(5))
  return { status: 200, result: data.result }
}

describe("Clegra links a person's CRM account (better-auth 1.7.7, metadata documents)", () => {
  test("private_key_jwt: the link, a call as the person, a refresh with rotation, revocation", async () => {
    const { tokens, server } = await link(clients.private_key_jwt)
    assert.ok(coreFetches.includes("/oauth/client.json") && coreFetches.includes("/oauth/jwks.json"), coreFetches.join(","))
    assert.ok(tokens.refreshToken, "offline_access gives a refresh token")
    const listed = await mcp(tokens.accessToken, "tools/call", { name: "deal_list", arguments: {} })
    assert.equal(listed.status, 200)
    assert.equal((listed.result.structuredContent.rows as unknown[]).length, 5, "Alice's organization's deals")

    // A refresh: a new access token, the refresh token rotated (the node keeps the new one; whether the old one still
    // works is the authorization server's policy, not the client's).
    const refreshed = await refreshTokens({ tokenEndpoint: server.tokenEndpoint, refreshToken: tokens.refreshToken!, resource: RESOURCE, scope: tokens.scope, client: clients.private_key_jwt }, crm)
    assert.notEqual(refreshed.accessToken, tokens.accessToken)
    assert.notEqual(refreshed.refreshToken, tokens.refreshToken)
    assert.equal((await mcp(refreshed.accessToken, "tools/list")).status, 200)

    // Without the client's assertion the refresh token alone is useless.
    const noAssertion = { ...clients.private_key_jwt, assertion: async () => signClientAssertion({ core: CORE, audience: server.tokenEndpoint, key: parseClientKey(newAppLinkClientKey())! }) }
    await assert.rejects(refreshTokens({ tokenEndpoint: server.tokenEndpoint, refreshToken: refreshed.refreshToken!, resource: RESOURCE, scope: null, client: noAssertion }, crm), (e: OAuthFlowError) => e.code === "token")

    // Unlink: revoked (RFC 7009); the refresh is refused for good after.
    await revokeToken({ endpoint: server.revocationEndpoint!, token: refreshed.refreshToken!, hint: "refresh_token", client: clients.private_key_jwt }, crm)
    await assert.rejects(refreshTokens({ tokenEndpoint: server.tokenEndpoint, refreshToken: refreshed.refreshToken!, resource: RESOURCE, scope: null, client: clients.private_key_jwt }, crm), (e: OAuthFlowError) => e.code === "invalid-grant")
  })

  test("the public client (none + PKCE) links too, for servers that take only public metadata-document clients", async () => {
    const { tokens } = await link(clients.none, "emma@kestrel.example")
    assert.ok(coreFetches.includes("/oauth/public-client.json"))
    const listed = await mcp(tokens.accessToken, "tools/call", { name: "deal_list", arguments: {} })
    assert.deepEqual((listed.result.structuredContent.rows as { name: string }[]).map((r) => r.name), ["Rosewood Bakery — new brand"])
  })

  test("a code is traded once, and only with its verifier", async () => {
    const server = await discoverServer(ISSUER, crm)
    const { verifier, challenge } = pkcePair()
    const state = signAppLinkState({ nodeId: NODE_ID, client: "https://app.clegra.test", key: randomBytes(32).toString("base64url"), expiresAt: Date.now() + 600_000 }, appLinkStateKey())
    const landed = await personAuthorizes(authorizationUrl({ endpoint: server.authorizationEndpoint, clientId: clients.private_key_jwt.clientId, redirectUri: appLinkRedirectUri(CORE), state, challenge, resource: RESOURCE, scope: "clegra" }), "ben@orbit.example")
    const code = landed.searchParams.get("code")!
    const trade = (v: string) => exchangeCode({ tokenEndpoint: server.tokenEndpoint, code, verifier: v, redirectUri: appLinkRedirectUri(CORE), resource: RESOURCE, scope: "clegra", client: clients.private_key_jwt }, crm)
    await assert.rejects(trade(pkcePair().verifier), (e: OAuthFlowError) => e.code === "invalid-grant" || e.code === "token")
    await assert.rejects(trade(verifier), (e: OAuthFlowError) => e.code === "invalid-grant" || e.code === "token", "a code tried once is gone")
  })
})
