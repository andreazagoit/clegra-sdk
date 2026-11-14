import assert from "node:assert/strict"
import { createHash, randomUUID } from "node:crypto"
import { rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, describe, test } from "node:test"

import { z } from "zod"

import { CLIENT_METADATA_MAX_BYTES, clientMetadataCacheSeconds, clientMetadataUrlProblem, fetchClientMetadata, isClientMetadataUrl, isPublicAddress, redirectUriAllowed, validateClientMetadata } from "./auth"
import { defineApp } from "./index"

/** Requests of these tests come from this machine (dev sign-in answers nobody else). */
const local = { remoteAddress: "127.0.0.1" }
const base = "http://127.0.0.1:3920"
const CLIENT = "https://client.example/oauth/metadata.json"
const CALLBACK = "https://client.example/callback"
/** A public address for the fake resolver. */
const PUBLIC = "93.184.215.14"

const keyFile = join(tmpdir(), `modelapp-cimd-key-${randomUUID()}.json`)
after(() => rmSync(keyFile, { force: true }))

type Answer = { status?: number; headers?: Record<string, string>; body?: unknown; raw?: string }

/** An app whose dev authority reaches client documents through a fake network: `documents` by URL, `hosts` by name. Nothing here touches the real one. */
function world(documents: Record<string, Answer | (() => Answer)> = {}, hosts: Record<string, string[]> = {}) {
  const fetched: string[] = []
  const resolved: string[] = []
  const fetchFake = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    fetched.push(url)
    assert.equal(init?.redirect, "error")
    assert.ok(init?.signal)
    const found = documents[url]
    if (!found) return new Response("not found", { status: 404 })
    const answer = typeof found === "function" ? found() : found
    return new Response(answer.raw ?? JSON.stringify(answer.body), { status: answer.status ?? 200, headers: { "content-type": "application/json", ...answer.headers } })
  }) as typeof fetch
  const lookup = async (host: string) => {
    resolved.push(host)
    return hosts[host] ?? [PUBLIC]
  }
  const app = defineApp({
    name: "cimd",
    title: "Cimd",
    version: "1.0.0",
    auth: { dev: { keyFile, code: "TEST1", clientMetadata: { fetch: fetchFake, lookup } } },
    entities: { a: { label: "A", schema: z.object({ id: z.string(), n: z.string().meta({ role: "title" }) }), get: () => null, list: () => ({ rows: [] }) } },
  })
  return { app, fetched, resolved, transport: { fetch: fetchFake, lookup } }
}

const verifier = "v".repeat(50)
const challenge = createHash("sha256").update(verifier).digest("base64url")
const query = (client_id: string, redirect_uri: string) => new URLSearchParams({ client_id, redirect_uri, state: "s1", code_challenge: challenge, code_challenge_method: "S256", response_type: "code" })
type TestApp = ReturnType<typeof world>["app"]
const authorizePage = (app: TestApp, client_id: string, redirect_uri = CALLBACK) => app.fetch(new Request(`${base}/oauth/authorize?${query(client_id, redirect_uri)}`), local)
const signIn = (app: TestApp, client_id: string, redirect_uri = CALLBACK) => app.fetch(new Request(`${base}/oauth/authorize`, { method: "POST", body: new URLSearchParams({ ...Object.fromEntries(query(client_id, redirect_uri)), person: "test-person", code: "TEST1" }) }), local)
const token = (app: TestApp, fields: Record<string, string>) => app.fetch(new Request(`${base}/oauth/token`, { method: "POST", body: new URLSearchParams(fields) }), local)
const doc = (extra: Record<string, unknown> = {}) => ({ client_id: CLIENT, client_name: "Example <b>Client</b>", redirect_uris: [CALLBACK], ...extra })

/** Refused on a page of ours: a 400 that goes nowhere. */
async function assertRefused(response: Response, why: RegExp) {
  assert.equal(response.status, 400)
  assert.equal(response.headers.get("location"), null)
  const text = await response.text()
  assert.match(text, why)
  assert.doesNotMatch(text, /<form/)
}

describe("client id metadata documents: the pure checks", () => {
  test("a client_id URL: https, a path, no fragment, no user, no dot segments; a query is allowed", () => {
    for (const ok of [CLIENT, "https://client.example/app", "https://client.example:8443/a/b.json", "https://client.example/meta?v=2", "https://93.184.215.14/client"]) assert.equal(clientMetadataUrlProblem(ok), null, ok)
    for (const bad of [
      "http://client.example/meta.json",
      "https://client.example",
      "https://client.example/",
      "https://client.example/meta.json#x",
      "https://client.example/meta.json#",
      "https://user@client.example/meta.json",
      "https://user:word@client.example/meta.json",
      "https://client.example/a/../meta.json",
      "https://client.example/./meta.json",
      "https://client.example/a/%2E%2e/meta.json",
      "https://client.example/a/..",
      "https://client.example/me ta.json",
      "https://client.example\\@127.0.0.1/meta.json",
      "https://localhost/meta.json",
      "https://app.localhost/meta.json",
      "https://printer.local/meta.json",
      "https://db.internal/meta.json",
      "https://intranet/meta.json",
      "https://127.0.0.1/meta.json",
      "https://2130706433/meta.json",
      "https://0x7f.1/meta.json",
      "https://10.1.2.3/meta.json",
      "https://[::1]/meta.json",
      "https://[::ffff:192.168.1.1]/meta.json",
      "https://[fd00::1]/meta.json",
      "dev-1234",
      "",
    ]) {
      assert.equal(typeof clientMetadataUrlProblem(bad), "string", bad)
      assert.equal(isClientMetadataUrl(bad), false, bad)
    }
  })

  test("public and non-public addresses", () => {
    for (const ip of [PUBLIC, "8.8.8.8", "172.32.0.1", "100.128.0.1", "2606:4700::1111", "[2606:4700::1111]", "::ffff:8.8.8.8", "64:ff9b::808:808"]) assert.equal(isPublicAddress(ip), true, ip)
    for (const ip of [
      "0.0.0.0", "10.0.0.1", "127.0.0.1", "127.9.9.9", "100.64.0.1", "100.127.255.255", "169.254.169.254", "172.16.0.1", "172.31.255.255", "192.168.0.1", "192.0.0.1", "192.0.2.1", "198.18.0.1", "198.51.100.1", "203.0.113.1", "224.0.0.1", "240.0.0.1", "255.255.255.255",
      "::", "::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:10.0.0.1", "::ffff:169.254.169.254", "::127.0.0.1", "64:ff9b::a00:1", "64:ff9b:1::1", "2002:7f00:1::1", "2002:c0a8:101::1", "2001::1", "2001:db8::1", "fc00::1", "fd12:3456::1", "fe80::1", "fe80::1%en0", "fec0::1", "ff02::1", "[::1]",
      "client.example", "127.1", "",
    ]) assert.equal(isPublicAddress(ip), false, ip)
  })

  test("a document must be this client's, public, with redirect_uris", () => {
    assert.deepEqual(validateClientMetadata(CLIENT, doc({ token_endpoint_auth_method: "none", extra: 1 })), { client_id: CLIENT, client_name: "Example <b>Client</b>", redirect_uris: [CALLBACK] })
    assert.deepEqual(validateClientMetadata(CLIENT, { client_id: CLIENT, redirect_uris: ["http://127.0.0.1/cb", "app.example:/cb"] }), { client_id: CLIENT, redirect_uris: ["http://127.0.0.1/cb", "app.example:/cb"] })
    const refused: [unknown, RegExp][] = [
      [null, /not a JSON object/],
      [[doc()], /not a JSON object/],
      [doc({ client_id: `${CLIENT}/` }), /client_id is not the URL/],
      [doc({ client_id: "https://CLIENT.example/oauth/metadata.json" }), /client_id is not the URL/],
      [doc({ client_id: undefined }), /client_id is not the URL/],
      [doc({ redirect_uris: [] }), /redirect_uris/],
      [doc({ redirect_uris: CALLBACK }), /redirect_uris/],
      [doc({ redirect_uris: [CALLBACK, 7] }), /redirect_uris/],
      [doc({ redirect_uris: ["/callback"] }), /absolute URL/],
      [doc({ redirect_uris: ["javascript:alert(1)"] }), /scheme/],
      [doc({ redirect_uris: [`${CALLBACK}#x`] }), /fragment/],
      [doc({ client_name: 5 }), /client_name/],
      [doc({ token_endpoint_auth_method: "private_key_jwt" }), /public clients only.*private_key_jwt/],
      [doc({ token_endpoint_auth_method: "client_secret_basic" }), /public clients only/],
      [doc({ client_secret: "x" }), /client_secret/],
      [doc({ client_secret_expires_at: 0 }), /client_secret/],
    ]
    for (const [document, why] of refused) assert.throws(() => validateClientMetadata(CLIENT, document), why)
  })

  test("a redirect_uri matches exactly; only a loopback address may change port", () => {
    assert.equal(redirectUriAllowed(CALLBACK, [CALLBACK]), true)
    for (const other of [`${CALLBACK}/`, `${CALLBACK}?x=1`, "https://client.example:444/callback", "https://client.example/Callback", "https://evil.example/callback", "http://client.example/callback", ""]) assert.equal(redirectUriAllowed(other, [CALLBACK]), false, other)
    const loop = ["http://127.0.0.1/callback", "http://localhost:7000/cb", "http://[::1]/cb6"]
    for (const ok of ["http://127.0.0.1:51234/callback", "http://127.0.0.1/callback", "http://localhost:51234/cb", "http://localhost/cb", "http://[::1]:9/cb6"]) assert.equal(redirectUriAllowed(ok, loop), true, ok)
    for (const bad of ["http://127.0.0.1:51234/other", "http://127.0.0.1:51234/callback?x=1", "http://127.0.0.1:51234/callback#f", "http://localhost:51234/callback", "http://127.0.0.2:51234/callback", "https://127.0.0.1:51234/callback", "http://user@127.0.0.1:51234/callback", "http://127.0.0.1.evil.example:51234/callback"]) assert.equal(redirectUriAllowed(bad, loop), false, bad)
    // A public address never gets the port exception.
    assert.equal(redirectUriAllowed("http://client.example:81/callback", ["http://client.example/callback"]), false)
  })

  test("how long a document is kept", () => {
    assert.equal(clientMetadataCacheSeconds(null), 300)
    assert.equal(clientMetadataCacheSeconds("public"), 300)
    assert.equal(clientMetadataCacheSeconds("public, max-age=3600"), 3600)
    assert.equal(clientMetadataCacheSeconds("max-age=5"), 60)
    assert.equal(clientMetadataCacheSeconds("max-age=0"), 60)
    assert.equal(clientMetadataCacheSeconds("Max-Age=999999999"), 86400)
    assert.equal(clientMetadataCacheSeconds("no-store"), 0)
    assert.equal(clientMetadataCacheSeconds("max-age=600, No-Store"), 0)
    assert.equal(clientMetadataCacheSeconds("no-cache"), 0)
  })
})

describe("client id metadata documents: fetching", () => {
  test("nothing is requested for a URL that is not https, an IP literal inside, or a host that resolves inside", async () => {
    const { fetched, resolved, transport } = world({}, { "inside.example": ["10.0.0.5"], "mixed.example": [PUBLIC, "::1"], "mapped.example": ["::ffff:192.168.1.10"], "meta.example": ["169.254.169.254"], "nowhere.example": [] })
    for (const [id, why] of [
      ["http://client.example/meta.json", /https/],
      ["https://127.0.0.1/meta.json", /not a public address/],
      ["https://[::ffff:10.0.0.1]/meta.json", /not a public address/],
      ["https://localhost/meta.json", /not a public host name/],
      ["https://inside.example/meta.json", /resolves to 10\.0\.0\.5/],
      ["https://mixed.example/meta.json", /resolves to ::1/],
      ["https://mapped.example/meta.json", /not a public address/],
      ["https://meta.example/meta.json", /169\.254\.169\.254/],
      ["https://nowhere.example/meta.json", /does not resolve/],
    ] as const) await assert.rejects(fetchClientMetadata(id, transport), why, id)
    await assert.rejects(fetchClientMetadata("https://gone.example/meta.json", { ...transport, lookup: async () => Promise.reject(new Error("ENOTFOUND")) }), /does not resolve/)
    assert.deepEqual(fetched, [])
    assert.deepEqual(resolved, ["inside.example", "mixed.example", "mapped.example", "meta.example", "nowhere.example"])
  })

  test("the answer must be 200, JSON, small, not a redirect, and this client's document", async () => {
    const at = (name: string) => `https://client.example/${name}`
    const { fetched, transport } = world({
      [at("ok")]: { body: { client_id: at("ok"), redirect_uris: [CALLBACK] }, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "max-age=120" } },
      [at("plus")]: { body: { client_id: at("plus"), redirect_uris: [CALLBACK] }, headers: { "content-type": "application/cimd+json", "cache-control": "no-store" } },
      [at("html")]: { body: { client_id: at("html"), redirect_uris: [CALLBACK] }, headers: { "content-type": "text/html" } },
      [at("text")]: { body: { client_id: at("text"), redirect_uris: [CALLBACK] }, headers: { "content-type": "text/json-ish" } },
      [at("moved")]: { status: 302, headers: { location: "https://127.0.0.1/internal" }, raw: "" },
      [at("error")]: { status: 500, body: {} },
      [at("big")]: { raw: JSON.stringify({ client_id: at("big"), redirect_uris: [CALLBACK], pad: "x".repeat(CLIENT_METADATA_MAX_BYTES) }) },
      [at("lies")]: { raw: JSON.stringify({ client_id: at("lies"), redirect_uris: [CALLBACK], pad: "x".repeat(CLIENT_METADATA_MAX_BYTES) }), headers: { "content-length": "10" } },
      [at("broken")]: { raw: "{not json" },
      [at("other")]: { body: { client_id: at("someone-else"), redirect_uris: [CALLBACK] } },
      [at("secret")]: { body: { client_id: at("secret"), redirect_uris: [CALLBACK], token_endpoint_auth_method: "client_secret_post" } },
    })
    assert.deepEqual(await fetchClientMetadata(at("ok"), transport), { metadata: { client_id: at("ok"), redirect_uris: [CALLBACK] }, cacheSeconds: 120 })
    assert.equal((await fetchClientMetadata(at("plus"), transport)).cacheSeconds, 0)
    await assert.rejects(fetchClientMetadata(at("html"), transport), /not served as JSON/)
    await assert.rejects(fetchClientMetadata(at("text"), transport), /not served as JSON/)
    await assert.rejects(fetchClientMetadata(at("moved"), transport), /answered 302/)
    await assert.rejects(fetchClientMetadata(at("error"), transport), /answered 500/)
    await assert.rejects(fetchClientMetadata(at("missing"), transport), /answered 404/)
    await assert.rejects(fetchClientMetadata(at("big"), transport), /larger than 64 KB/)
    await assert.rejects(fetchClientMetadata(at("lies"), transport), /larger than 64 KB/)
    await assert.rejects(fetchClientMetadata(at("broken"), transport), /not valid JSON/)
    await assert.rejects(fetchClientMetadata(at("other"), transport), /client_id is not the URL/)
    await assert.rejects(fetchClientMetadata(at("secret"), transport), /public clients only/)
    assert.equal(fetched.length, 12)
    // A fetch that fails (as the real one does on a redirect, with `redirect: "error"`) or runs out of time is a refusal too.
    await assert.rejects(fetchClientMetadata(at("ok"), { ...transport, fetch: async () => Promise.reject(new TypeError("fetch failed")) }), /could not be fetched/)
    await assert.rejects(fetchClientMetadata(at("ok"), { ...transport, fetch: async () => Promise.reject(new DOMException("timed out", "TimeoutError")) }), /no answer in time/)
    const followed = new Response(JSON.stringify({ client_id: at("ok"), redirect_uris: [CALLBACK] }), { headers: { "content-type": "application/json" } })
    Object.defineProperty(followed, "redirected", { value: true })
    await assert.rejects(fetchClientMetadata(at("ok"), { ...transport, fetch: async () => followed }), /redirect/)
  })
})

describe("client id metadata documents: the dev authorization server", () => {
  test("the metadata says so, and keeps dynamic registration", async () => {
    const { app } = world()
    const meta = (await (await app.fetch(new Request(`${base}/.well-known/oauth-authorization-server`), local)).json()) as Record<string, unknown>
    assert.equal(meta.client_id_metadata_document_supported, true)
    assert.equal(meta.registration_endpoint, `${base}/oauth/register`)
    assert.deepEqual(meta.token_endpoint_auth_methods_supported, ["none"])
  })

  test("authorize → token with a metadata-document client; the page says who is asking", async () => {
    const { app, fetched } = world({ [CLIENT]: { body: doc() } })
    const page = await authorizePage(app, CLIENT)
    assert.equal(page.status, 200)
    const text = await page.text()
    assert.match(text, /<strong>Example &lt;b&gt;Client&lt;\/b&gt;<\/strong> \(client\.example\) is asking to sign in/)
    assert.match(text, /metadata document: https:\/\/client\.example\/oauth\/metadata\.json/)
    assert.doesNotMatch(text, /<b>Client/)
    const ok = await signIn(app, CLIENT)
    assert.equal(ok.status, 302)
    const back = new URL(ok.headers.get("location")!)
    assert.equal(`${back.origin}${back.pathname}`, CALLBACK)
    assert.equal(back.searchParams.get("state"), "s1")
    const code = back.searchParams.get("code")!
    const tok = await token(app, { grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: CALLBACK, client_id: CLIENT })
    assert.equal(tok.status, 200)
    const t = (await tok.json()) as { access_token: string; refresh_token: string }
    const mcp = await app.fetch(new Request(`${base}/mcp`, { method: "POST", headers: { authorization: `Bearer ${t.access_token}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "x", version: "1" } } }) }), local)
    assert.equal(mcp.status, 200)
    // The document was fetched once for the whole flow (page, sign-in, token).
    assert.deepEqual(fetched, [CLIENT])
    // The refresh token stays with this client.
    assert.equal((await token(app, { grant_type: "refresh_token", refresh_token: t.refresh_token, client_id: CLIENT })).status, 200)
    assert.equal((await token(app, { grant_type: "refresh_token", refresh_token: t.refresh_token, client_id: "https://other.example/meta.json" })).status, 400)
    assert.equal((await token(app, { grant_type: "refresh_token", refresh_token: t.refresh_token })).status, 400)
  })

  test("a code is for the client it was given to", async () => {
    const OTHER = "https://other.example/meta.json"
    const { app } = world({ [CLIENT]: { body: doc() }, [OTHER]: { body: { client_id: OTHER, redirect_uris: [CALLBACK] } } })
    const code = new URL((await signIn(app, CLIENT)).headers.get("location")!).searchParams.get("code")!
    const grant = { grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: CALLBACK }
    for (const client_id of [OTHER, "dev-1234", `${CLIENT}?x`]) {
      const refused = await token(app, { ...grant, client_id })
      assert.equal(refused.status, 400)
      assert.match(((await refused.json()) as { error_description: string }).error_description, /another client_id/)
    }
    const missing = await token(app, grant)
    assert.equal(missing.status, 400)
    assert.match(((await missing.json()) as { error_description: string }).error_description, /client_id is required/)
    assert.equal((await token(app, { ...grant, client_id: CLIENT })).status, 200)
  })

  test("a redirect_uri that is not in the document is refused here, never redirected to", async () => {
    const { app } = world({ [CLIENT]: { body: doc() } })
    for (const evil of ["https://evil.example/callback", `${CALLBACK}/x`, "http://127.0.0.1:9999/callback"]) {
      await assertRefused(await authorizePage(app, CLIENT, evil), /redirect_uri is not one of the redirect_uris/)
      await assertRefused(await signIn(app, CLIENT, evil), /redirect_uri is not one of the redirect_uris/)
    }
  })

  test("a native client on a loopback address may use any port", async () => {
    const NATIVE = "https://native.example/client.json"
    const { app } = world({ [NATIVE]: { body: { client_id: NATIVE, client_name: "Native", redirect_uris: ["http://127.0.0.1/callback"] } } })
    const ok = await signIn(app, NATIVE, "http://127.0.0.1:53124/callback")
    assert.equal(ok.status, 302)
    const back = new URL(ok.headers.get("location")!)
    assert.equal(back.host, "127.0.0.1:53124")
    assert.equal((await token(app, { grant_type: "authorization_code", code: back.searchParams.get("code")!, code_verifier: verifier, redirect_uri: "http://127.0.0.1:53124/callback", client_id: NATIVE })).status, 200)
    await assertRefused(await signIn(app, NATIVE, "http://127.0.0.1:53124/elsewhere"), /redirect_uri is not one/)
    await assertRefused(await signIn(app, NATIVE, "http://localhost:53124/callback"), /redirect_uri is not one/)
  })

  test("a client that is not who it says, or cannot be reached safely, is refused without a redirect", async () => {
    const at = (name: string) => `https://client.example/${name}`
    const { app, fetched } = world(
      {
        [at("other")]: { body: doc() },
        [at("confidential")]: { body: { client_id: at("confidential"), redirect_uris: [CALLBACK], token_endpoint_auth_method: "private_key_jwt" } },
        [at("moved")]: { status: 301, headers: { location: CLIENT }, raw: "" },
        [at("html")]: { raw: "<html>", headers: { "content-type": "text/html" } },
        [at("big")]: { raw: `{"pad":"${"x".repeat(CLIENT_METADATA_MAX_BYTES)}"}` },
      },
      { "inside.example": ["192.168.1.20"] },
    )
    await assertRefused(await authorizePage(app, at("other")), /client_id is not the URL it was fetched from/)
    await assertRefused(await authorizePage(app, at("confidential")), /public clients only/)
    await assertRefused(await authorizePage(app, at("moved")), /answered 301/)
    await assertRefused(await authorizePage(app, at("html")), /not served as JSON/)
    await assertRefused(await authorizePage(app, at("big")), /larger than 64 KB/)
    await assertRefused(await signIn(app, at("missing")), /answered 404/)
    const before = fetched.length
    assert.equal(before, 6)
    for (const id of ["http://client.example/meta.json", "https://client.example", "https://127.0.0.1/meta.json", "https://[::1]/meta.json", "https://169.254.169.254/latest", "https://localhost/meta.json", "https://inside.example/meta.json", "https://client.example/a/../meta.json", "https://client.example/meta.json#f"]) {
      await assertRefused(await authorizePage(app, id), /This client cannot sign in/)
      await assertRefused(await signIn(app, id), /This client cannot sign in/)
    }
    assert.equal(fetched.length, before)
  })

  test("the document is kept: fetched once, again after no-store, and a failure is not retried at once", async () => {
    const STORED = "https://client.example/stored.json"
    const FRESH = "https://client.example/fresh.json"
    const DOWN = "https://client.example/down.json"
    let name = "First"
    const { app, fetched } = world({
      [STORED]: () => ({ body: { client_id: STORED, client_name: name, redirect_uris: [CALLBACK] }, headers: { "cache-control": "max-age=600" } }),
      [FRESH]: () => ({ body: { client_id: FRESH, client_name: name, redirect_uris: [CALLBACK] }, headers: { "cache-control": "no-store" } }),
      [DOWN]: { status: 503, body: {} },
    })
    const count = (url: string) => fetched.filter((u) => u === url).length
    assert.match(await (await authorizePage(app, STORED)).text(), /First/)
    assert.match(await (await authorizePage(app, FRESH)).text(), /First/)
    name = "Second"
    assert.match(await (await authorizePage(app, STORED)).text(), /First/)
    assert.match(await (await authorizePage(app, FRESH)).text(), /Second/)
    assert.equal(count(STORED), 1)
    assert.equal(count(FRESH), 2)
    await assertRefused(await authorizePage(app, DOWN), /answered 503/)
    await assertRefused(await authorizePage(app, DOWN), /answered 503/)
    assert.equal(count(DOWN), 1)
    // Requests at the same moment share one fetch.
    const SAME = "https://client.example/same.json"
    const many = world({ [SAME]: { body: { client_id: SAME, redirect_uris: [CALLBACK] }, headers: { "cache-control": "no-store" } } })
    await Promise.all([authorizePage(many.app, SAME), authorizePage(many.app, SAME), authorizePage(many.app, SAME)])
    assert.equal(many.fetched.length, 1)
  })

  test("the cache holds 100 clients: the oldest goes first", async () => {
    const id = (i: number) => `https://client.example/c/${i}.json`
    const documents: Record<string, Answer> = {}
    for (let i = 0; i <= 100; i++) documents[id(i)] = { body: { client_id: id(i), redirect_uris: [CALLBACK] } }
    const { app, fetched } = world(documents)
    for (let i = 0; i <= 100; i++) assert.equal((await authorizePage(app, id(i))).status, 200)
    assert.equal(fetched.length, 101)
    await authorizePage(app, id(100))
    await authorizePage(app, id(1))
    assert.equal(fetched.length, 101)
    await authorizePage(app, id(0))
    assert.equal(fetched.length, 102)
  })

  test("dynamic registration and plain client ids work as before", async () => {
    const { app, fetched, resolved } = world()
    const reg = await app.fetch(new Request(`${base}/oauth/register`, { method: "POST", body: JSON.stringify({ redirect_uris: [CALLBACK] }) }), local)
    assert.equal(reg.status, 201)
    const { client_id } = (await reg.json()) as { client_id: string }
    assert.match(client_id, /^dev-/)
    const page = await authorizePage(app, client_id)
    assert.equal(page.status, 200)
    assert.doesNotMatch(await page.text(), /is asking to sign in/)
    const first = new URL((await signIn(app, client_id)).headers.get("location")!).searchParams.get("code")!
    // Without client_id at the token endpoint, as clients did before.
    const tok = await token(app, { grant_type: "authorization_code", code: first, code_verifier: verifier, redirect_uri: CALLBACK })
    assert.equal(tok.status, 200)
    const { refresh_token } = (await tok.json()) as { refresh_token: string }
    assert.equal((await token(app, { grant_type: "refresh_token", refresh_token })).status, 200)
    // With it, and with a redirect address nobody registered (dev registration keeps none).
    const second = new URL((await signIn(app, client_id, "https://anywhere.example/cb")).headers.get("location")!).searchParams.get("code")!
    assert.equal((await token(app, { grant_type: "authorization_code", code: second, code_verifier: verifier, client_id })).status, 200)
    const third = new URL((await signIn(app, "some-client")).headers.get("location")!).searchParams.get("code")!
    assert.equal((await token(app, { grant_type: "authorization_code", code: third, code_verifier: verifier, client_id: "another-client" })).status, 400)
    assert.deepEqual(fetched, [])
    assert.deepEqual(resolved, [])
  })
})
