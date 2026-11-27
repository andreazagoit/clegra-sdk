import assert from "node:assert/strict"
import { createHash, randomUUID } from "node:crypto"
import { describe, test } from "node:test"

import { decodeJwt, decodeProtectedHeader, exportJWK, generateKeyPair, SignJWT } from "jose"
import { z } from "zod"

import { defineApp } from "../index"
import { deviceKey, testClient } from "../testing"
import { createSignIn, frameCookie, MemorySignInStore, newSignInKey, passwordLogin, PERSONAL_KEY_PREFIX } from "./index"

// THE SIGN-IN MODULE: an app's own login gives any client (Clegra, Claude, ChatGPT) a delegation the app issued,
// through the app's own consent; tokens at+jwt for exactly the app's MCP address, scopes = the app's permissions,
// read live; refresh rotated, reuse ends the link; revocation; web_message for a framing client; DPoP; personal keys.

const ORIGIN = "http://localhost:3990"
const RESOURCE = `${ORIGIN}/mcp`
const CLIENT = "https://client.example/oauth/client.json"
const CALLBACK = "https://client.example/callback"
const FRAMER = "https://app.client.example"
const verifier = "v".repeat(64)
const challenge = createHash("sha256").update(verifier).digest("base64url")

function world(options: { clientDocument?: Record<string, unknown> } = {}) {
  const store = new MemorySignInStore()
  const document = options.clientDocument ?? { client_id: CLIENT, client_name: "Clegra", redirect_uris: [CALLBACK] }
  const transport = {
    fetch: (async (input: RequestInfo | URL) => (String(input) === CLIENT ? new Response(JSON.stringify(document), { headers: { "content-type": "application/json" } }) : new Response("no", { status: 404 }))) as typeof fetch,
    lookup: async () => ["93.184.215.14"],
  }
  const definition = {
    name: "notes",
    title: { en: "Notes", it: "Note" },
    version: "1.0.0",
    permissions: { "notes.read": { label: { en: "Read notes", it: "Leggere le note" }, default: true }, "notes.write": { label: { en: "Write notes", it: "Scrivere le note" } } },
    entities: { note: { label: "Note", permission: "notes.read", schema: z.object({ id: z.string(), text: z.string().meta({ role: "title" }) }), get: () => ({ id: "n1", text: "hello" }), list: () => ({ rows: [{ id: "n1", text: "hello" }] }) } },
    actions: { note_add: { title: "Add a note", permission: "notes.write", input: z.object({ text: z.string() }), run: ({ text }: { text: string }) => ({ message: `added ${text}` }) } },
  }
  const login = passwordLogin({ store, origin: ORIGIN, title: definition.title, iterations: 1000, frameAncestors: [FRAMER] })
  const shell = defineApp(definition as never)
  const signIn = createSignIn(shell, { issuer: ORIGIN, resource: RESOURCE, login, permissionsOf: (a) => login.permissionsOf(a), store, clientOrigins: [FRAMER], clientMetadata: transport })
  const app = defineApp({ ...definition, auth: { signIn } } as never)
  return { app, signIn, login, store }
}

const at = (path: string) => `${ORIGIN}${path}`
const send = (app: ReturnType<typeof world>["app"], request: Request) => app.fetch(request, { remoteAddress: "203.0.113.9" })
const authorizeUrl = (extra: Record<string, string> = {}) =>
  at(`/oauth/authorize?${new URLSearchParams({ response_type: "code", client_id: CLIENT, redirect_uri: CALLBACK, state: "s1", code_challenge: challenge, code_challenge_method: "S256", resource: RESOURCE, ...extra })}`)

async function signedIn(w: ReturnType<typeof world>, email = "ada@example.com", permissions: string[] | "all" = "all") {
  await w.login.accounts.create({ email, name: "Ada", password: "correct horse battery", installation: "acme", permissions })
  const r = await send(w.app, new Request(at("/signin"), { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN }, body: new URLSearchParams({ email, password: "correct horse battery", return: "/" }) }))
  assert.equal(r.status, 303)
  const cookie = r.headers.get("set-cookie")!
  assert.match(cookie, /HttpOnly/)
  return cookie.split(";")[0]!
}

async function consent(w: ReturnType<typeof world>, cookie: string, extra: Record<string, string> = {}, decision = "allow") {
  const page = await send(w.app, new Request(authorizeUrl(extra), { headers: { cookie, "accept-language": "it-IT" } }))
  assert.equal(page.status, 200)
  const html = await page.text()
  const id = /name="request" value="([^"]+)"/.exec(html)![1]!
  return { html, page, answer: await send(w.app, new Request(at("/oauth/authorize"), { method: "POST", headers: { cookie, origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ request: id, decision }) })) }
}

async function linked(w: ReturnType<typeof world>, extra: Record<string, string> = {}, headers: Record<string, string> = {}) {
  const cookie = await signedIn(w)
  const { answer } = await consent(w, cookie, extra)
  const code = new URL(answer.headers.get("location")!).searchParams.get("code")!
  const r = await send(w.app, new Request(at("/oauth/token"), { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...headers }, body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: CLIENT, redirect_uri: CALLBACK, resource: RESOURCE }) }))
  return { response: r, body: (await r.json()) as Record<string, string>, cookie }
}

const refresh = (w: ReturnType<typeof world>, token: string) =>
  send(w.app, new Request(at("/oauth/token"), { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: token, client_id: CLIENT }) }))

describe("sign-in module", () => {
  test("metadata: issuer, PKCE, metadata documents, web_message, DPoP, the app's permissions as scopes; the resource names it", async () => {
    const w = world()
    const m = (await (await send(w.app, new Request(at("/.well-known/oauth-authorization-server")))).json()) as Record<string, unknown>
    assert.equal(m.issuer, ORIGIN)
    assert.deepEqual(m.code_challenge_methods_supported, ["S256"])
    assert.equal(m.client_id_metadata_document_supported, true)
    assert.ok((m.response_modes_supported as string[]).includes("web_message"))
    assert.deepEqual(m.scopes_supported, ["notes.read", "notes.write", "offline_access"])
    assert.equal(m.registration_endpoint, undefined)
    const prm = (await (await send(w.app, new Request(at("/.well-known/oauth-protected-resource/mcp")))).json()) as Record<string, unknown>
    assert.deepEqual(prm.authorization_servers, [ORIGIN])
    assert.equal(prm.resource, RESOURCE)
    const jwks = (await (await send(w.app, new Request(at("/oauth/jwks.json")))).json()) as { keys: Record<string, unknown>[] }
    assert.equal(jwks.keys.length, 1)
    assert.equal(jwks.keys[0]!.d, undefined)
  })

  test("not signed in: to the app's own sign-in, coming back to the same request", async () => {
    const w = world()
    const r = await send(w.app, new Request(authorizeUrl()))
    assert.equal(r.status, 303)
    const to = new URL(r.headers.get("location")!)
    assert.equal(to.pathname, "/signin")
    assert.ok(to.searchParams.get("return")!.startsWith("/oauth/authorize?"))
    const page = await send(w.app, new Request(to, { headers: { "accept-language": "it" } }))
    assert.match(await page.text(), /Entra in Note/)
  })

  test("a wrong password, an unknown client, a redirect address not its own: nothing sent", async () => {
    const w = world()
    await w.login.accounts.create({ email: "ada@example.com", name: "Ada", password: "correct horse battery", installation: "acme", permissions: "all" })
    const wrong = await send(w.app, new Request(at("/signin"), { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN }, body: new URLSearchParams({ email: "ada@example.com", password: "nope nope nope" }) }))
    assert.equal(wrong.status, 401)
    assert.equal(wrong.headers.get("set-cookie"), null)
    const cookie = await signedIn(world(), "bob@example.com")
    const other = await send(w.app, new Request(authorizeUrl({ redirect_uri: "https://evil.example/cb" }), { headers: { cookie } }))
    assert.equal(other.status, 400)
    assert.equal(other.headers.get("location"), null)
    const opaque = await send(w.app, new Request(authorizeUrl({ client_id: "some-client" }), { headers: { cookie } }))
    assert.equal(opaque.status, 400)
  })

  test("consent in the person's language; code → at+jwt for exactly the resource, then MCP calls as the person", async () => {
    const w = world()
    const cookie = await signedIn(w)
    const { html, page, answer } = await consent(w, cookie)
    assert.match(html, /Permetti a Clegra di usare Note per te\?/)
    assert.match(page.headers.get("content-security-policy")!, new RegExp(`frame-ancestors ${FRAMER}`))
    assert.equal(answer.status, 303)
    const back = new URL(answer.headers.get("location")!)
    assert.equal(back.origin + back.pathname, CALLBACK)
    assert.equal(back.searchParams.get("state"), "s1")
    assert.equal(back.searchParams.get("iss"), ORIGIN)
    const code = back.searchParams.get("code")!
    const token = await send(w.app, new Request(at("/oauth/token"), { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: CLIENT, redirect_uri: CALLBACK, resource: RESOURCE }) }))
    const body = (await token.json()) as Record<string, string>
    assert.equal(body.token_type, "Bearer")
    assert.equal(decodeProtectedHeader(body.access_token!).typ, "at+jwt")
    const claims = decodeJwt(body.access_token!)
    assert.equal(claims.aud, RESOURCE)
    assert.equal(claims.client_id, CLIENT)
    assert.equal(claims.installation, "acme")
    // A code is used once.
    const again = await send(w.app, new Request(at("/oauth/token"), { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: CLIENT, redirect_uri: CALLBACK }) }))
    assert.equal(again.status, 400)
    const client = await testClient(w.app, { token: body.access_token!, remoteAddress: "203.0.113.9" })
    assert.equal(client.status, 200)
    const added = await client.call("note_add", { text: "x" })
    assert.equal(added.isError, undefined, JSON.stringify(added))
  })

  test("the scopes narrow what the person may do; the person's permissions are read live", async () => {
    const w = world()
    const { body } = await linked(w, { scope: "notes.read" })
    const client = await testClient(w.app, { token: body.access_token!, remoteAddress: "203.0.113.9" })
    const refused = await client.call("note_add", { text: "x" })
    assert.equal(refused.isError, true)
    const [account] = await w.login.accounts.list("acme")
    await w.login.accounts.update(account!.id, { disabled: true })
    const gone = await testClient(w.app, { token: body.access_token!, remoteAddress: "203.0.113.9" })
    assert.equal(gone.status, 401)
  })

  test("refresh rotates; a used refresh token presented again ends the link; revoking the link ends its access tokens", async () => {
    const w = world()
    const { body } = await linked(w)
    const r1 = await refresh(w, body.refresh_token!)
    assert.equal(r1.status, 200)
    const next = (await r1.json()) as Record<string, string>
    assert.notEqual(next.refresh_token, body.refresh_token)
    const reuse = await refresh(w, body.refresh_token!)
    assert.equal(reuse.status, 400)
    assert.equal((await refresh(w, next.refresh_token!)).status, 400)
    const client = await testClient(w.app, { token: next.access_token!, remoteAddress: "203.0.113.9" })
    assert.equal(client.status, 401)
  })

  test("RFC 7009 revocation by the client; the app's own screen lists and removes links", async () => {
    const w = world()
    const { body } = await linked(w)
    const [account] = await w.login.accounts.list("acme")
    const who = { id: account!.id, name: account!.name, installation: "acme" }
    assert.equal((await w.signIn.links.list(who)).length, 1)
    const r = await send(w.app, new Request(at("/oauth/revoke"), { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: body.refresh_token!, client_id: CLIENT }) }))
    assert.equal(r.status, 200)
    assert.equal((await w.signIn.links.list(who)).length, 0)
    assert.equal((await testClient(w.app, { token: body.access_token!, remoteAddress: "203.0.113.9" })).status, 401)
  })

  test("web_message: the answer is posted to the framing client's origin only; the consent is framable by it alone", async () => {
    const w = world()
    const cookie = await signedIn(w)
    const { answer } = await consent(w, cookie, { response_mode: "web_message" })
    assert.equal(answer.status, 200)
    const html = await answer.text()
    assert.match(html, /"type":"authorization_response"/)
    assert.match(html, new RegExp(`\\["${FRAMER}"\\]`))
    assert.match(html, /"iss":"http:\/\/localhost:3990"/)
    assert.match(answer.headers.get("content-security-policy")!, /script-src 'nonce-/)
  })

  test("a consent posted by another site, or by another person, is refused", async () => {
    const w = world()
    const cookie = await signedIn(w)
    const page = await send(w.app, new Request(authorizeUrl(), { headers: { cookie } }))
    const id = /name="request" value="([^"]+)"/.exec(await page.text())![1]!
    const cross = await send(w.app, new Request(at("/oauth/authorize"), { method: "POST", headers: { cookie, origin: "https://evil.example", "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ request: id, decision: "allow" }) }))
    assert.equal(cross.status, 403)
    const other = await signedIn(w, "eve@example.com")
    const stolen = await send(w.app, new Request(at("/oauth/authorize"), { method: "POST", headers: { cookie: other, origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ request: id, decision: "allow" }) }))
    assert.equal(stolen.status, 403)
  })

  test("DPoP: a proof at the token endpoint binds the tokens; then only DPoP with that key", async () => {
    const w = world()
    const { privateKey, publicKey } = await generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true })
    const jwk = await exportJWK(publicKey)
    const proof = await new SignJWT({ htm: "POST", htu: at("/oauth/token") }).setProtectedHeader({ alg: "EdDSA", typ: "dpop+jwt", jwk }).setIssuedAt().setJti(randomUUID()).sign(privateKey)
    const { body } = await linked(w, {}, { dpop: proof })
    assert.equal(body.token_type, "DPoP")
    assert.ok((decodeJwt(body.access_token!).cnf as { jkt?: string }).jkt)
    assert.equal((await testClient(w.app, { token: body.access_token!, remoteAddress: "203.0.113.9" })).status, 401)
    // The test client's key is another one: refused.
    const other = await deviceKey()
    assert.equal((await testClient(w.app, { token: body.access_token!, remoteAddress: "203.0.113.9", dpop: { key: other, htu: RESOURCE } })).status, 401)
    const own = { jkt: "", publicJwk: jwk, privateKey, proof: async (i: { htm: string; htu: string; token: string }) => new SignJWT({ htm: i.htm, htu: i.htu, ath: createHash("sha256").update(i.token).digest("base64url") }).setProtectedHeader({ alg: "EdDSA", typ: "dpop+jwt", jwk }).setIssuedAt().setJti(randomUUID()).sign(privateKey), confirm: async () => "" }
    assert.equal((await testClient(w.app, { token: body.access_token!, remoteAddress: "203.0.113.9", dpop: { key: own, htu: RESOURCE } })).status, 200)
  })

  test("personal keys: made by the person in the app, scoped, listed without the key, revoked at once", async () => {
    const w = world()
    await signedIn(w)
    const [account] = await w.login.accounts.list("acme")
    const who = { id: account!.id, name: account!.name, installation: "acme" }
    const { key, id } = await w.signIn.keys.create(who, { name: "Nightly export", scopes: ["notes.read"] })
    assert.ok(key.startsWith(PERSONAL_KEY_PREFIX))
    const client = await testClient(w.app, { token: key, remoteAddress: "203.0.113.9" })
    assert.equal(client.status, 200)
    assert.equal((await client.call("note_add", { text: "x" })).isError, true)
    const listed = await w.signIn.keys.list(who)
    assert.equal(listed.length, 1)
    assert.equal(JSON.stringify(listed).includes(key), false)
    assert.equal(await w.signIn.keys.revoke(who, id), true)
    assert.equal((await testClient(w.app, { token: key, remoteAddress: "203.0.113.9" })).status, 401)
  })

  test("a client with a key pair proves itself at the token endpoint (private_key_jwt)", async () => {
    const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true })
    const pub = { ...(await exportJWK(publicKey)), kid: "k1", alg: "ES256" }
    const w = world({ clientDocument: { client_id: CLIENT, redirect_uris: [CALLBACK], token_endpoint_auth_method: "private_key_jwt", token_endpoint_auth_signing_alg: "ES256", jwks: { keys: [pub] } } })
    const unauthenticated = await linked(w)
    assert.equal(unauthenticated.response.status, 401)
    const w2 = world({ clientDocument: { client_id: CLIENT, redirect_uris: [CALLBACK], token_endpoint_auth_method: "private_key_jwt", token_endpoint_auth_signing_alg: "ES256", jwks: { keys: [pub] } } })
    const assertion = await new SignJWT({}).setProtectedHeader({ alg: "ES256", kid: "k1" }).setIssuer(CLIENT).setSubject(CLIENT).setAudience(at("/oauth/token")).setIssuedAt().setExpirationTime("1m").setJti(randomUUID()).sign(privateKey)
    const cookie = await signedIn(w2)
    const { answer } = await consent(w2, cookie)
    const code = new URL(answer.headers.get("location")!).searchParams.get("code")!
    const ok = await send(w2.app, new Request(at("/oauth/token"), { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: CLIENT, redirect_uri: CALLBACK, client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer", client_assertion: assertion }) }))
    assert.equal(ok.status, 200)
  })

  test("keys: production needs one; newSignInKey makes a private Ed25519 JWK", async () => {
    const jwk = JSON.parse(await newSignInKey()) as Record<string, string>
    assert.equal(jwk.crv, "Ed25519")
    assert.ok(jwk.d && jwk.kid)
    const env = process.env as Record<string, string | undefined>
    const was = env.NODE_ENV
    env.NODE_ENV = "production"
    try {
      assert.throws(() => createSignIn(defineApp({ name: "x1", title: "X", version: "1.0.0", entities: {} } as never), { issuer: "https://x.example", resource: "https://x.example/mcp", login: { session: () => null, signInUrl: () => "/" }, permissionsOf: () => "all", store: new MemorySignInStore() }), /signIn.keys/)
    } finally {
      env.NODE_ENV = was
    }
  })

  test("frameCookie: partitioned over https, Lax over http", () => {
    assert.equal(frameCookie({ name: "s", value: "v", secure: true }), "__Host-s=v; Path=/; HttpOnly; Secure; SameSite=None; Partitioned")
    assert.equal(frameCookie({ name: "s", value: "v", secure: false, maxAgeSeconds: 60 }), "s=v; Path=/; HttpOnly; Max-Age=60; SameSite=Lax")
  })
})
