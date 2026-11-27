import assert from "node:assert/strict"
import { createHash, randomUUID } from "node:crypto"
import { describe, test } from "node:test"

import { decodeJwt, exportJWK, generateKeyPair, SignJWT } from "jose"

import { defineApp } from "../app"
import { createSignIn, devSignIn, frameCookie, MemorySignInStore, newSignInKey, passwordLogin } from "./index"

// THE SIGN-IN MODULE: the app's own login gives any MCP client a grant the app issued, through the app's own consent;
// scopes are the access profile's, each on its own consent line; tokens at+jwt for exactly the app's MCP address;
// refresh rotated, reuse revokes the grant; the grants page; DPoP; development tokens.

const ORIGIN = "http://localhost:3990"
const RESOURCE = `${ORIGIN}/mcp`
const CLIENT = "https://client.example/oauth/client.json"
const CALLBACK = "https://client.example/callback"
const verifier = "v".repeat(64)
const challenge = createHash("sha256").update(verifier).digest("base64url")

const appOf = (link = false) => defineApp({ name: "notes", title: { en: "Notes", it: "Note" }, description: "Notes", version: "1.0.0", ...(link ? { sessionTransfer: { link: true } } : {}) })

function world(options: { clientDocument?: Record<string, unknown>; link?: boolean; redirect?: string } = {}) {
  const store = new MemorySignInStore()
  const document = options.clientDocument ?? { client_id: CLIENT, client_name: "Assistant", redirect_uris: [options.redirect ?? CALLBACK] }
  const transport = {
    fetch: (async (input: RequestInfo | URL) => (String(input) === CLIENT ? new Response(JSON.stringify(document), { headers: { "content-type": "application/json" } }) : new Response("no", { status: 404 }))) as typeof fetch,
    lookup: async () => ["93.184.215.14"],
  }
  const app = appOf(options.link)
  const login = passwordLogin({ store, origin: ORIGIN, title: { en: "Notes", it: "Note" }, iterations: 1000 })
  const signIn = createSignIn(app, { issuer: ORIGIN, resource: RESOURCE, login, active: (p) => login.active(p), store, clientMetadata: transport })
  const revoked: string[] = []
  signIn.onRevoke((g) => {
    revoked.push(g)
  })
  const send = async (request: Request) => (await signIn.fetch(request)) ?? new Response("not found", { status: 404 })
  return { app, signIn, login, store, send, revoked }
}
type World = ReturnType<typeof world>

const at = (path: string) => `${ORIGIN}${path}`
const form = (body: Record<string, string>, headers: Record<string, string> = {}) => ({ method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...headers }, body: new URLSearchParams(body) })
const authorizeUrl = (extra: Record<string, string> = {}, redirect = CALLBACK) =>
  at(`/oauth/authorize?${new URLSearchParams({ response_type: "code", client_id: CLIENT, redirect_uri: redirect, state: "s1", code_challenge: challenge, code_challenge_method: "S256", resource: RESOURCE, ...extra })}`)

async function signedIn(w: World, email = "ada@example.com") {
  await w.login.accounts.create({ email, name: "Ada", password: "correct horse battery", tenant: "acme" })
  const r = await w.send(new Request(at("/signin"), form({ email, password: "correct horse battery", return: "/" }, { origin: ORIGIN })))
  assert.equal(r.status, 303)
  return r.headers.get("set-cookie")!.split(";")[0]!
}

async function consent(w: World, cookie: string, extra: Record<string, string> = {}, decision = "allow", redirect = CALLBACK) {
  const page = await w.send(new Request(authorizeUrl(extra, redirect), { headers: { cookie, "accept-language": "it-IT" } }))
  assert.equal(page.status, 200)
  const html = await page.text()
  const id = /name="request" value="([^"]+)"/.exec(html)![1]!
  return { html, page, answer: await w.send(new Request(at("/oauth/authorize"), form({ request: id, decision }, { cookie, origin: ORIGIN }))) }
}

async function linked(w: World, extra: Record<string, string> = {}, headers: Record<string, string> = {}) {
  const cookie = await signedIn(w)
  const { answer } = await consent(w, cookie, extra)
  const code = new URL(answer.headers.get("location")!).searchParams.get("code")!
  const r = await w.send(new Request(at("/oauth/token"), form({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: CLIENT, redirect_uri: CALLBACK, resource: RESOURCE }, headers)))
  return { response: r, body: (await r.json()) as Record<string, string>, cookie }
}

const refresh = (w: World, token: string) => w.send(new Request(at("/oauth/token"), form({ grant_type: "refresh_token", refresh_token: token, client_id: CLIENT })))
const mcpRequest = (token: string, scheme = "Bearer", extra: Record<string, string> = {}) => new Request(RESOURCE, { method: "POST", headers: { authorization: `${scheme} ${token}`, ...extra } })
const verifyAt = (w: { signIn: { verify: World["signIn"]["verify"] } }, token: string, resource = RESOURCE) => w.signIn.verify(token, mcpRequest(token), { resource, scheme: "Bearer" })

describe("sign-in module", () => {
  test("metadata: issuer, PKCE, metadata documents, DPoP, the access profile's scopes; no web_message", async () => {
    const w = world()
    const m = (await (await w.send(new Request(at("/.well-known/oauth-authorization-server")))).json()) as Record<string, unknown>
    assert.equal(m.issuer, ORIGIN)
    assert.deepEqual(m.code_challenge_methods_supported, ["S256"])
    assert.equal(m.client_id_metadata_document_supported, true)
    assert.deepEqual(m.response_modes_supported, ["query"])
    assert.deepEqual(m.scopes_supported, ["web.read", "web.write", "web.irreversible", "bound_browser_session", "offline_access"])
    assert.equal(m.registration_endpoint, undefined)
    const linkMode = world({ link: true })
    const m2 = (await (await linkMode.send(new Request(at("/.well-known/oauth-authorization-server")))).json()) as Record<string, unknown>
    assert.ok((m2.scopes_supported as string[]).includes("browser_session"))
  })

  test("not signed in: to the app's own sign-in, coming back to the same request", async () => {
    const w = world()
    const r = await w.send(new Request(authorizeUrl()))
    assert.equal(r.status, 303)
    const to = new URL(r.headers.get("location")!)
    assert.equal(to.pathname, "/signin")
    assert.match(to.searchParams.get("return")!, /^\/oauth\/authorize\?/)
  })

  test("consent: each scope on its own line in the person's language, the client's host and redirect, never framed", async () => {
    const w = world()
    const cookie = await signedIn(w)
    const { html, page } = await consent(w, cookie, { scope: "web.read web.write offline_access" }, "deny")
    assert.match(html, /<li>Vedere i tuoi dati<\/li><li>Modificare i tuoi dati<\/li><li>Continuare a lavorare mentre non ci sei<\/li>/)
    assert.match(html, /client\.example/)
    assert.match(html, /https:\/\/client\.example\/callback/)
    assert.doesNotMatch(html, /non si può verificare/)
    assert.match(page.headers.get("content-security-policy")!, /frame-ancestors 'none'/)
    const signInPage = await w.send(new Request(at("/signin")))
    assert.match(signInPage.headers.get("content-security-policy")!, /frame-ancestors 'none'/)
  })

  test("a loopback or custom-scheme redirect is warned about on the consent", async () => {
    const w = world({ redirect: "http://127.0.0.1:7777/cb" })
    const cookie = await signedIn(w)
    const { html } = await consent(w, cookie, {}, "deny", "http://127.0.0.1:7777/cb")
    assert.match(html, /non si può verificare/)
  })

  test("scopes: none asked gets web.read; an unknown one and browser_session without the link mode are refused", async () => {
    const w = world()
    const { body } = await linked(w)
    assert.equal(body.scope, "web.read")
    const cookie = await signedIn(w, "bob@example.com")
    for (const scope of ["browser_session", "admin"]) {
      const r = await w.send(new Request(authorizeUrl({ scope }), { headers: { cookie } }))
      assert.equal(r.status, 303)
      assert.equal(new URL(r.headers.get("location")!).searchParams.get("error"), "invalid_scope")
    }
    const l = world({ link: true })
    const ok = await linked(l, { scope: "web.read browser_session" })
    assert.equal(ok.body.scope, "web.read browser_session")
  })

  test("code → at+jwt for exactly the resource; verify gives the grant with the consented scopes", async () => {
    const w = world()
    const { body } = await linked(w, { scope: "web.read web.write" })
    assert.equal(body.token_type, "Bearer")
    const claims = decodeJwt(body.access_token!)
    assert.equal(claims.aud, RESOURCE)
    assert.equal(claims.iss, ORIGIN)
    const grant = await verifyAt(w, body.access_token!)
    assert.ok(grant)
    assert.equal(grant.clientId, CLIENT)
    assert.equal(grant.clientName, "Assistant")
    assert.equal(grant.person.name, "Ada")
    assert.equal(grant.person.tenant, "acme")
    assert.deepEqual(grant.scopes, ["web.read", "web.write"])
    await assert.rejects(verifyAt(w, body.access_token!, `${ORIGIN}/other`), /another server/)
    assert.equal(await verifyAt(w, "not-a-jwt"), null)
  })

  test("a disabled account: its tokens are refused at once", async () => {
    const w = world()
    const { body } = await linked(w)
    const [account] = await w.login.accounts.list("acme")
    await w.login.accounts.update(account!.id, { disabled: true })
    await assert.rejects(verifyAt(w, body.access_token!), /may not use the app/)
  })

  test("refresh rotates; a used refresh token presented again revokes the grant and tells onRevoke", async () => {
    const w = world()
    const { body } = await linked(w)
    const r1 = await refresh(w, body.refresh_token!)
    assert.equal(r1.status, 200)
    const next = (await r1.json()) as Record<string, string>
    assert.notEqual(next.refresh_token, body.refresh_token)
    const reuse = await refresh(w, body.refresh_token!)
    assert.equal(reuse.status, 400)
    assert.equal(((await reuse.json()) as { error: string }).error, "invalid_grant")
    assert.equal(w.revoked.length, 1)
    assert.equal((await refresh(w, next.refresh_token!)).status, 400)
    await assert.rejects(verifyAt(w, next.access_token!), /revoked/)
  })

  test("offline_access: refresh tokens live refreshTokenDays; without it 12 hours from the grant", async () => {
    const w = world()
    await linked(w)
    const shortEntry = (await w.store.list("refresh:")).map((e) => e.value as { until: number })[0]!
    assert.ok(shortEntry.until - Date.now() <= 12 * 3600_000 && shortEntry.until - Date.now() > 11 * 3600_000)
    const l = world()
    await linked(l, { scope: "web.read offline_access" })
    const longEntry = (await l.store.list("refresh:")).map((e) => e.value as { until: number })[0]!
    assert.ok(longEntry.until - Date.now() > 29 * 24 * 3600_000)
  })

  test("RFC 7009 revocation by the client ends the grant and tells onRevoke", async () => {
    const w = world()
    const { body } = await linked(w)
    const r = await w.send(new Request(at("/oauth/revoke"), form({ token: body.refresh_token!, client_id: CLIENT })))
    assert.equal(r.status, 200)
    assert.equal(w.revoked.length, 1)
    await assert.rejects(verifyAt(w, body.access_token!), /revoked/)
  })

  test("revokeGrant by id (the confirmation page's «revoke») ends the grant and tells onRevoke once (idempotent)", async () => {
    const w = world()
    const { body } = await linked(w)
    const grant = (await verifyAt(w, body.access_token!))!
    await w.signIn.revokeGrant(grant.id)
    await w.signIn.revokeGrant(grant.id)
    assert.deepEqual(w.revoked, [grant.id])
    assert.equal((await refresh(w, body.refresh_token!)).status, 400)
  })

  test("the grants page: lists the person's grants; revoking needs the page's nonce and the same origin", async () => {
    const w = world()
    const { body, cookie } = await linked(w, { scope: "web.read bound_browser_session" })
    const anon = await w.send(new Request(at("/oauth/grants")))
    assert.equal(anon.status, 303)
    const page = await w.send(new Request(at("/oauth/grants"), { headers: { cookie } }))
    assert.equal(page.status, 200)
    assert.match(page.headers.get("content-security-policy")!, /frame-ancestors 'none'/)
    const html = await page.text()
    assert.match(html, /Assistant/)
    assert.match(html, /Open this app&#39;s pages signed in as you/)
    assert.match(html, /\/access\/log/)
    const nonce = /name="nonce" value="([^"]+)"/.exec(html)![1]!
    const grant = /name="grant" value="([^"]+)"/.exec(html)![1]!
    const person = (await w.login.session(new Request(ORIGIN, { headers: { cookie } })))!
    assert.equal((await w.signIn.grants.list(person))[0]!.browserSessions, true)
    assert.equal((await w.send(new Request(at("/oauth/grants"), form({ nonce: "wrong", grant }, { cookie, origin: ORIGIN })))).status, 403)
    assert.equal((await w.send(new Request(at("/oauth/grants"), form({ nonce, grant }, { cookie, origin: "https://evil.example" })))).status, 403)
    const done = await w.send(new Request(at("/oauth/grants"), form({ nonce, grant }, { cookie, origin: ORIGIN })))
    assert.equal(done.status, 200)
    assert.match(await done.text(), /Access revoked/)
    assert.deepEqual(w.revoked, [grant])
    await assert.rejects(verifyAt(w, body.access_token!), /revoked/)
  })

  test("a consent posted by another site, or by another person, is refused", async () => {
    const w = world()
    const cookie = await signedIn(w)
    const page = await w.send(new Request(authorizeUrl(), { headers: { cookie } }))
    const id = /name="request" value="([^"]+)"/.exec(await page.text())![1]!
    assert.equal((await w.send(new Request(at("/oauth/authorize"), form({ request: id, decision: "allow" }, { cookie, origin: "https://evil.example" })))).status, 403)
    const other = await signedIn(w, "eve@example.com")
    const page2 = await w.send(new Request(authorizeUrl(), { headers: { cookie } }))
    const id2 = /name="request" value="([^"]+)"/.exec(await page2.text())![1]!
    assert.equal((await w.send(new Request(at("/oauth/authorize"), form({ request: id2, decision: "allow" }, { cookie: other, origin: ORIGIN })))).status, 403)
  })

  test("DPoP: a proof at the token endpoint binds the tokens; then only DPoP with that key", async () => {
    const w = world()
    const { privateKey, publicKey } = await generateKeyPair("EdDSA", { crv: "Ed25519" })
    const jwk = await exportJWK(publicKey)
    const proof = await new SignJWT({ htm: "POST", htu: at("/oauth/token") }).setProtectedHeader({ alg: "EdDSA", typ: "dpop+jwt", jwk }).setIssuedAt().setJti(randomUUID()).sign(privateKey)
    const { body } = await linked(w, {}, { dpop: proof })
    assert.equal(body.token_type, "DPoP")
    const token = body.access_token!
    await assert.rejects(verifyAt(w, token), /bound to a key/)
    const call = await new SignJWT({ htm: "POST", htu: RESOURCE, ath: createHash("sha256").update(token).digest("base64url") }).setProtectedHeader({ alg: "EdDSA", typ: "dpop+jwt", jwk }).setIssuedAt().setJti(randomUUID()).sign(privateKey)
    assert.ok(await w.signIn.verify(token, mcpRequest(token, "DPoP", { dpop: call }), { resource: RESOURCE, scheme: "DPoP" }))
  })

  test("a client with a key pair proves itself at the token endpoint (private_key_jwt)", async () => {
    const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true })
    const pub = { ...(await exportJWK(publicKey)), kid: "k1", alg: "ES256" }
    const doc = { client_id: CLIENT, redirect_uris: [CALLBACK], token_endpoint_auth_method: "private_key_jwt", token_endpoint_auth_signing_alg: "ES256", jwks: { keys: [pub] } }
    assert.equal((await linked(world({ clientDocument: doc }))).response.status, 401)
    const w = world({ clientDocument: doc })
    const assertion = await new SignJWT({}).setProtectedHeader({ alg: "ES256", kid: "k1" }).setIssuer(CLIENT).setSubject(CLIENT).setAudience(at("/oauth/token")).setIssuedAt().setExpirationTime("1m").setJti(randomUUID()).sign(privateKey)
    const cookie = await signedIn(w)
    const { answer } = await consent(w, cookie)
    const code = new URL(answer.headers.get("location")!).searchParams.get("code")!
    const ok = await w.send(new Request(at("/oauth/token"), form({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: CLIENT, redirect_uri: CALLBACK, client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer", client_assertion: assertion })))
    assert.equal(ok.status, 200)
  })

  test("keys: production needs one; newSignInKey makes a private Ed25519 JWK", async () => {
    const jwk = JSON.parse(await newSignInKey()) as Record<string, string>
    assert.equal(jwk.kty, "OKP")
    assert.equal(jwk.crv, "Ed25519")
    assert.ok(jwk.d && jwk.kid)
    const env = process.env as Record<string, string | undefined>
    const before = env.NODE_ENV
    env.NODE_ENV = "production"
    try {
      assert.throws(() => createSignIn(appOf(), { issuer: "https://notes.example.com", resource: "https://notes.example.com/mcp", login: { session: () => null, signInUrl: () => "/" }, store: new MemorySignInStore() }), /signIn\.keys/)
      assert.throws(() => devSignIn(appOf()), /refused when NODE_ENV is production/)
    } finally {
      env.NODE_ENV = before
    }
  })

  test("devSignIn: the dev login (test people, the console code) and the module's consent; development tokens on loopback only", async () => {
    const transport = {
      fetch: (async (input: RequestInfo | URL) => (String(input) === CLIENT ? Response.json({ client_id: CLIENT, client_name: "Inspector", redirect_uris: [CALLBACK] }) : new Response("no", { status: 404 }))) as typeof fetch,
      lookup: async () => ["93.184.215.14"],
    }
    const dev = devSignIn(appOf(), { issuer: ORIGIN, code: "DEV42", people: [{ id: "ada", name: "Ada" }], clientMetadata: transport })
    const go = async (r: Request) => (await dev.fetch(r)) ?? new Response(null, { status: 404 })
    const first = await go(new Request(authorizeUrl()))
    assert.equal(first.status, 303)
    const login = new URL(first.headers.get("location")!, ORIGIN)
    assert.equal(login.pathname, "/oauth/dev-login")
    assert.equal((await go(new Request(at("/oauth/dev-login"), form({ person: "ada", code: "WRONG", return: "/" })))).status, 401)
    const signed = await go(new Request(at("/oauth/dev-login"), form({ person: "ada", code: "DEV42", return: login.searchParams.get("return")! })))
    assert.equal(signed.status, 303)
    const cookie = signed.headers.get("set-cookie")!.split(";")[0]!
    const consentPage = await go(new Request(at(signed.headers.get("location")!), { headers: { cookie } }))
    const id = /name="request" value="([^"]+)"/.exec(await consentPage.text())![1]!
    const allowed = await go(new Request(at("/oauth/authorize"), form({ request: id, decision: "allow" }, { cookie, origin: ORIGIN })))
    const code = new URL(allowed.headers.get("location")!).searchParams.get("code")!
    const token = (await (await go(new Request(at("/oauth/token"), form({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: CLIENT, redirect_uri: CALLBACK })))).json()) as { access_token: string }
    assert.equal((await dev.verify(token.access_token, mcpRequest(token.access_token), { resource: RESOURCE, scheme: "Bearer" }))?.person.id, "ada")
    // A development token: the scopes a test needs, on a loopback address only; revocable.
    const t = await dev.dev.token({ person: "ada", scopes: ["web.read", "web.write"] })
    const g = (await dev.verify(t, mcpRequest(t), { resource: RESOURCE, scheme: "Bearer" }))!
    assert.deepEqual(g.scopes, ["web.read", "web.write"])
    assert.equal(g.person.name, "Ada")
    await assert.rejects(dev.verify(t, new Request("https://notes.example.com/mcp", { method: "POST" }), { resource: RESOURCE, scheme: "Bearer" }), /loopback/)
    await dev.revokeGrant(g.id)
    await assert.rejects(dev.verify(t, mcpRequest(t), { resource: RESOURCE, scheme: "Bearer" }), /revoked/)
  })

  test("frameCookie: partitioned over https, Lax over http", () => {
    assert.equal(frameCookie({ name: "s", value: "v", secure: true }), "__Host-s=v; Path=/; HttpOnly; Secure; SameSite=None; Partitioned")
    assert.equal(frameCookie({ name: "s", value: "v", secure: false, maxAgeSeconds: 60 }), "s=v; Path=/; HttpOnly; Max-Age=60; SameSite=Lax")
  })
})
