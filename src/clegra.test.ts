import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { z } from "zod"

import { Ajv2020 } from "ajv/dist/2020.js"

import schemaJson from "../spec/schema/clegra.schema.json" with { type: "json" }
import { clegraFromEnv, defineApp, MemoryStore, type AuthOptions, type ClegraEvent, type ClegraOptions, type Context } from "./index"
import { deviceKey, testClient, testCore, type DeviceKey } from "./testing"

// Clegra tokens (spec §7): the core is the one trusted issuer; the tenant is <company>@<issuer>; DPoP binds every
// token to its key; the app's own roles say who may do what; agents need the person's device-signed confirmation.

const RES = "https://notes.test/mcp"
const ISS = "https://core.test"
const CLIENT = "https://app.clegra.test"
const core = await testCore({ resource: RES, issuer: ISS })

type Note = { id: string; title: string; status: "open" | "done" }
const data = new Map<string, Map<string, Note>>()
const notesOf = (tenant: string) => {
  let m = data.get(tenant)
  if (!m) data.set(tenant, (m = new Map([["n1", { id: "n1", title: "Call Ada", status: "open" }]])))
  return m
}
const heard: { state?: string; tenant?: string; event?: ClegraEvent }[] = []
const resolved: string[] = []

function makeApp(clegra: Partial<ClegraOptions> = {}, auth: Partial<AuthOptions> = {}, store = new MemoryStore()) {
  return defineApp({
    name: "notes",
    title: "Notes",
    version: "1.0.0",
    store,
    auth: {
      resource: RES,
      clegra: core.options({ clientOrigins: [CLIENT], challenge: "challenge-0123456789", events: { "member.removed": (event) => void heard.push({ event }) }, ...clegra }),
      ...auth,
    },
    permissions: { "notes.view": { label: "See notes", default: true }, "notes.edit": { label: "Change notes" } },
    settings: { tone: { label: "Tone", type: "text", default: "plain" } },
    entities: {
      note: {
        label: "Note",
        permission: "notes.view",
        schema: z.object({ id: z.string(), title: z.string().meta({ role: "title" }), status: z.enum(["open", "done"]) }),
        get: (id, ctx) => notesOf(ctx.installation).get(id) ?? null,
        list: (_q, ctx) => ({ rows: [...notesOf(ctx.installation).values()] }),
      },
    },
    actions: {
      close: {
        on: "note",
        title: "Close",
        input: z.object({}),
        permission: "notes.edit",
        run: (_input, ctx, note) => {
          notesOf(ctx.installation).set(note.id, { ...note, status: "done" })
          return { message: "Closed." }
        },
      },
      whoami: {
        title: "Who am I",
        input: z.object({}),
        readOnly: true,
        run: (_input, ctx: Context) => ({ data: { tenant: ctx.installation, person: ctx.person, actor: ctx.actor, admin: ctx.admin, permissions: [...ctx.permissions].sort(), settings: ctx.settings, locale: ctx.locale } }),
      },
      ping: {
        title: "Ping",
        input: z.object({}),
        readOnly: true,
        run: async (_input, ctx: Context) => {
          await ctx.rateLimit("ping", { max: 2, seconds: 60 })
          return { message: "pong" }
        },
      },
    },
    lifecycle: { installation: (state, ctx) => void heard.push({ state, tenant: ctx.installation }) },
  })
}

type App = ReturnType<typeof makeApp>
const errorOf = (r: { structuredContent?: Record<string, unknown> }) => (r.structuredContent as { error?: { code: string; message: string } } | undefined)?.error
const dataOf = (r: { structuredContent?: Record<string, unknown> }) => (r.structuredContent as { data: Record<string, unknown> }).data

/** One MCP request with whatever headers a test wants (a Clegra token by hand). */
async function call(app: App, headers: Record<string, string>, url = "http://127.0.0.1/mcp", method = "tools/list", params: Record<string, unknown> = {}) {
  return app.fetch(new Request(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18", ...headers }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }), { remoteAddress: "203.0.113.7" })
}
/** The headers of a DPoP call: the token and a proof (bendable). */
async function dpop(token: string, device: DeviceKey, proof: Partial<Parameters<DeviceKey["proof"]>[0]> = {}) {
  return { authorization: `DPoP ${token}`, dpop: await device.proof({ htm: "POST", htu: RES, token, ...proof }) }
}
async function withEnv<T>(env: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const before = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]))
  Object.assign(process.env, env)
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k]
  try {
    return await fn()
  } finally {
    for (const [k, v] of Object.entries(before)) if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
}

describe("Clegra tokens: the core's app tokens", () => {
  test("a person from a Clegra client: the tenant is <company>@<issuer>, the person their pairwise sub", async () => {
    const app = makeApp()
    const c = await core.client(app, { company: "co-1", sub: "pw-ada", name: "Ada", role: "member" })
    assert.equal(c.status, 200)
    const me = dataOf(await c.call("whoami"))
    assert.deepEqual(me, { tenant: `co-1@${ISS}`, person: { id: "pw-ada", name: "Ada" }, actor: null, admin: false, permissions: ["notes.view"], settings: { tone: "plain" }, locale: "en" })
    // The person's language is the token's `locale`: ctx.locale (and ctx.t); without it, the app's own.
    const it = await core.client(app, { company: "co-1", sub: "pw-ada", name: "Ada", role: "member", locale: "it" })
    assert.equal(dataOf(await it.call("whoami")).locale, "it")
    assert.equal(me.locale, "en")
    // Nothing a client sends names the tenant or the settings: `_meta.clegra.settings` is ignored (an app's settings live in the app).
    assert.deepEqual(dataOf(await c.call("whoami", {}, { clegra: { settings: { tone: "loud" } } })).settings, { tone: "plain" })
  })

  test("the manifest declares the events endpoint and «who has what»; the metadata keeps the app's own authorization server", async () => {
    const app = makeApp({}, { authorizationServers: ["https://notes.test/api/auth"] })
    const m = app.manifest()
    assert.deepEqual([m.events, m.rolesTool, m.auth.resource, m.auth.authorizationServers], [{ url: "/clegra/events" }, "clegra_roles", RES, ["https://notes.test/api/auth"]])
    const meta = (await (await app.fetch(new Request("https://notes.test/.well-known/oauth-protected-resource/mcp"))).json()) as { authorization_servers: string[] }
    assert.deepEqual(meta.authorization_servers, ["https://notes.test/api/auth"])
    assert.deepEqual(makeApp().manifest().auth.authorizationServers, [], "never the core: its tokens come from Clegra, not by OAuth")
    const validate = new Ajv2020({ allErrors: true, strict: false }).compile(schemaJson)
    assert.ok(validate(m), JSON.stringify(validate.errors))
  })

  test("the registration document (C2) is served from the configuration", async () => {
    const r = await makeApp().fetch(new Request("https://notes.test/.well-known/clegra-app.json"))
    assert.equal(r.status, 200)
    assert.deepEqual(await r.json(), { registration_id: "11111111-2222-4333-8444-555555555555", challenge: "challenge-0123456789", resource: RES, issuer: ISS })
    assert.equal((await makeApp({ challenge: undefined }).fetch(new Request("https://notes.test/.well-known/clegra-app.json"))).status, 404)
  })

  test("every malformed or foreign token is refused with a 401", async () => {
    const app = makeApp({ allowedCompanies: ["co-1", "co-2"] })
    const device = await deviceKey()
    const good = { company: "co-1", sub: "pw-ada", device }
    assert.equal((await call(app, await dpop(await core.appToken(good), device))).status, 200)
    const unpublished = await core.keyPair("a-test-unpublished")
    const personKey = await core.keyPair("p-test-1", "person")
    const cases: [string, string][] = [
      ["another issuer", await core.appToken({ ...good, iss: "https://evil.test" })],
      ["the wrong typ", await core.appToken({ ...good, typ: "at+jwt" })],
      ["a confirmation's typ", await core.appToken({ ...good, typ: "clegra-confirmation+jwt" })],
      ["another app's audience", await core.appToken({ ...good, aud: "https://other.test/mcp" })],
      ["an array audience, even with this app in it", await core.appToken({ ...good, aud: [RES, "https://other.test/mcp"] })],
      ["the app's origin, not its resource", await core.appToken({ ...good, aud: "https://notes.test" })],
      ["expired", await core.appToken({ ...good, iat: Math.floor(Date.now() / 1000) - 700, lifetime: 600 })],
      ["more than ten minutes", await core.appToken({ ...good, lifetime: 3600 })],
      ["a kid the core does not publish", await core.appToken({ ...good, kid: "a-unknown" })],
      ["a forged signature", await core.appToken({ ...good, signer: unpublished })],
      ["a core key of another use", await core.appToken({ ...good, signer: personKey })],
      ["a company not allowed", await core.appToken({ ...good, company: "co-9" })],
      ["a company id with an issuer in it", await core.appToken({ ...good, company: "co-1@https://evil.test" })],
      ["a made-up company role", await core.appToken({ ...good, role: "owner" as never })],
    ]
    for (const [why, token] of cases) {
      const r = await call(app, await dpop(token, device))
      assert.equal(r.status, 401, why)
      assert.match(r.headers.get("www-authenticate") ?? "", /^DPoP /, why)
    }
    // A key of another use, even published, never verifies an app token.
    const mixed = makeApp({ jwks: { keys: [core.key.publicJwk, personKey.publicJwk] } })
    assert.equal((await call(mixed, await dpop(await core.appToken({ ...good, signer: personKey }), device))).status, 401)
    // A core token without DPoP, as a bearer: refused, and never handed to the app's own resolver.
    const withResolve = makeApp({}, { resolve: (token) => (resolved.push(token), null) })
    const bearer = await call(withResolve, { authorization: `Bearer ${await core.appToken(good)}` })
    assert.equal(bearer.status, 401)
    assert.match(await bearer.text(), /DPoP/)
    assert.equal((await call(withResolve, await dpop(await core.appToken(good), device))).status, 200)
    assert.deepEqual(resolved, [], "resolve was never asked about a core token")
    // A token without company, or not bound to a key.
    const bare = await core.appToken({ ...good, company: "" })
    assert.equal((await call(app, await dpop(bare, device))).status, 401)
  })

  test("an app that takes only the core's tokens challenges with DPoP (RFC 9449 §7.1); with its own resolver, with Bearer", async () => {
    const app = makeApp()
    const meta = 'resource_metadata="https://notes.test/.well-known/oauth-protected-resource/mcp"'
    const none = await call(app, {})
    assert.equal(none.status, 401)
    const anonymous = none.headers.get("www-authenticate") ?? ""
    assert.match(anonymous, /^DPoP algs="EdDSA ES256", /)
    assert.ok(anonymous.includes(meta), anonymous)
    assert.doesNotMatch(anonymous, /error="/, "no error code without credentials (RFC 6750 §3.1)")
    const device = await deviceKey()
    const bearer = await call(app, { authorization: `Bearer ${await core.appToken({ company: "co-1", sub: "pw", device })}` })
    assert.match(bearer.headers.get("www-authenticate") ?? "", /^DPoP algs="EdDSA ES256", .*error="invalid_token"/)
    const withResolve = await call(makeApp({}, { resolve: () => null }), {})
    assert.match(withResolve.headers.get("www-authenticate") ?? "", /^Bearer resource_metadata=/)
  })

  test("in production the SDK fails closed without the registration id or the allowed companies", async () => {
    await withEnv({ NODE_ENV: "production" }, async () => {
      const device = await deviceKey()
      const token = await core.appToken({ company: "co-1", sub: "pw", device })
      const noRegistration = await call(makeApp({ registrationId: undefined }), await dpop(token, device))
      assert.equal(noRegistration.status, 500)
      assert.match(await noRegistration.text(), /registrationId/)
      const noCompanies = await call(makeApp({ allowedCompanies: undefined }), await dpop(token, device))
      assert.equal(noCompanies.status, 500)
      assert.match(await noCompanies.text(), /allowedCompanies/)
      assert.equal((await call(makeApp({ allowedCompanies: ["co-1"] }), await dpop(await core.appToken({ company: "co-1", sub: "pw", device }), device))).status, 200)
      assert.equal((await call(makeApp({ allowedCompanies: ["co-1"] }), await dpop(await core.appToken({ company: "co-2", sub: "pw", device }), device))).status, 401, "a private app: another company is refused")
    })
  })

  test("in production an app not yet registered serves what registering reads, and refuses everything else", async () => {
    await withEnv({ NODE_ENV: "production" }, async () => {
      // Before the core hands out the registration: no id, no challenge, no allowed companies.
      const fresh = makeApp({ registrationId: undefined, challenge: undefined, allowedCompanies: undefined })
      const manifest = await fresh.fetch(new Request("https://notes.test/.well-known/clegra.json"))
      assert.equal(manifest.status, 200)
      assert.equal(((await manifest.json()) as { name: string }).name, "notes")
      const document = await fresh.fetch(new Request("https://notes.test/.well-known/clegra-app.json"))
      assert.equal(document.status, 404)
      assert.equal(((await document.json()) as { error: string }).error, "not_configured")
      const device = await deviceKey()
      const token = await core.appToken({ company: "co-1", sub: "pw", device })
      const mcp = await call(fresh, await dpop(token, device))
      assert.equal(mcp.status, 500)
      assert.equal(((await mcp.json()) as { error: string }).error, "misconfigured")
      for (const path of ["/health", "/clegra/events", "/.well-known/oauth-protected-resource/mcp", "/"]) {
        const r = await fresh.fetch(new Request(`https://notes.test${path}`, { headers: { accept: "application/json" } }))
        assert.equal(r.status, 500, path)
      }
      // Registration id and challenge set, allowed companies not yet: the core can read the document back, tokens still fail closed.
      const halfway = makeApp({ allowedCompanies: undefined })
      const back = await halfway.fetch(new Request("https://notes.test/.well-known/clegra-app.json"))
      assert.equal(back.status, 200)
      assert.equal(((await back.json()) as { challenge: string }).challenge, "challenge-0123456789")
      assert.equal((await call(halfway, await dpop(await core.appToken({ company: "co-1", sub: "pw", device }), device))).status, 500)
    })
    assert.throws(() => defineApp({ name: "notes", title: "N", version: "1", auth: { clegra: core.options() }, entities: {} }), /auth\.resource/)
  })

  test("the options come from CLEGRA_* variables", () => {
    assert.equal(clegraFromEnv({}), null)
    assert.deepEqual(clegraFromEnv({ CLEGRA_ISSUER: ISS, CLEGRA_REGISTRATION_ID: "r-1", CLEGRA_REGISTRATION_CHALLENGE: "c-1", CLEGRA_ALLOWED_COMPANIES: "co-1, co-2", CLEGRA_CLIENT_ORIGINS: `${CLIENT},http://localhost:3111` }), {
      issuer: ISS,
      registrationId: "r-1",
      challenge: "c-1",
      allowedCompanies: ["co-1", "co-2"],
      clientOrigins: [CLIENT, "http://localhost:3111"],
    })
    assert.equal(clegraFromEnv({ CLEGRA_ISSUER: ISS, CLEGRA_ALLOWED_COMPANIES: "any" })?.allowedCompanies, "any")
    assert.throws(() => makeApp({ clientOrigins: ["https://app.clegra.test/"] }), /not an origin/)
  })

  test("the core's keys: fetched from its key set, only `use: app`, again on an unknown kid at most once a minute", async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: Date.now() })
    const rotated = await core.keyPair("a-test-2")
    let published = [core.key.publicJwk]
    const fetched: string[] = []
    const fetcher = (async (url: string | URL | Request) => {
      fetched.push(String(url))
      return Response.json({ keys: published })
    }) as typeof fetch
    const app = makeApp({ jwks: undefined, fetch: fetcher })
    const device = await deviceKey()
    assert.equal((await call(app, await dpop(await core.appToken({ company: "co-1", sub: "pw", device }), device))).status, 200)
    assert.deepEqual(fetched, [`${ISS}/.well-known/clegra-keys.json`])
    published = [core.key.publicJwk, rotated.publicJwk]
    // A new kid right away: not fetched again within the minute.
    assert.equal((await call(app, await dpop(await core.appToken({ company: "co-1", sub: "pw", device, signer: rotated }), device))).status, 401)
    assert.equal(fetched.length, 1)
    t.mock.timers.tick(61_000)
    assert.equal((await call(app, await dpop(await core.appToken({ company: "co-1", sub: "pw", device, signer: rotated }), device))).status, 200)
    assert.equal(fetched.length, 2)
  })
})

describe("DPoP (H4)", () => {
  const app = makeApp()
  const token = (device: DeviceKey) => core.appToken({ company: "co-1", sub: "pw-ada", device })

  test("refused: no proof, another key, another method, another address, another token, a replayed proof", async () => {
    const device = await deviceKey()
    const other = await deviceKey()
    const t = await token(device)
    assert.equal((await call(app, { authorization: `DPoP ${t}` })).status, 401, "no proof")
    assert.equal((await call(app, { authorization: `DPoP ${t}`, dpop: await other.proof({ htm: "POST", htu: RES, token: t }) })).status, 401, "a proof by another key")
    assert.equal((await call(app, await dpop(t, device, { htm: "GET" }))).status, 401, "another method")
    assert.equal((await call(app, await dpop(t, device, { token: await token(device) }))).status, 401, "a proof for another token (ath)")
    // The address is the configured resource, never what the request says it reached: a proof for the Host it came with is refused.
    const viaHost = await call(app, { host: "evil.test", "x-forwarded-host": "evil.test", "x-forwarded-proto": "https", ...(await dpop(t, device, { htu: "https://evil.test/mcp" })) }, "https://evil.test/mcp")
    assert.equal(viaHost.status, 401)
    assert.match(await viaHost.text(), /not this app's address/)
    assert.equal((await call(app, await dpop(t, device, { htu: "http://127.0.0.1/mcp" }))).status, 401, "the request's own URL")
    // A proof for the resource is good whatever address the request reached (a tunnel, a proxy), with a query too.
    assert.equal((await call(app, await dpop(t, device, { htu: `${RES}?x=1` }), "http://10.0.0.5:3000/mcp")).status, 200)
    const once = await dpop(t, device)
    assert.equal((await call(app, once)).status, 200)
    assert.equal((await call(app, once)).status, 401, "a replayed proof")
  })

  test("a clock off: 401 use_dpop_nonce with a DPoP-Nonce; the retry with it goes through", async () => {
    const device = await deviceKey()
    const t = await token(device)
    const skewed = await call(app, await dpop(t, device, { iat: Math.floor(Date.now() / 1000) - 600 }))
    assert.equal(skewed.status, 401)
    assert.match(skewed.headers.get("www-authenticate") ?? "", /error="use_dpop_nonce"/)
    const nonce = skewed.headers.get("dpop-nonce")
    assert.ok(nonce)
    assert.equal((await call(app, await dpop(t, device, { iat: Math.floor(Date.now() / 1000) - 600, nonce }))).status, 200, "with our nonce the clock does not matter")
    const unknown = await call(app, await dpop(t, device, { nonce: "made-up" }))
    assert.equal(unknown.status, 401)
    assert.ok(unknown.headers.get("dpop-nonce"), "an unknown nonce gets a fresh one")
    // The test client retries like a Clegra client does.
    const c = await testClient(app, { token: () => token(device), dpop: { key: { ...device, proof: (i) => device.proof({ ...i, ...(i.nonce ? {} : { iat: Math.floor(Date.now() / 1000) - 600 }) }) }, htu: RES } })
    assert.equal(c.status, 200)
  })
})

describe("CORS (H4)", () => {
  const app = makeApp()

  test("a preflight from a client origin: its origin, DPoP allowed, DPoP-Nonce exposed, never credentials", async () => {
    const r = await app.fetch(new Request(RES, { method: "OPTIONS", headers: { origin: CLIENT, "access-control-request-method": "POST", "access-control-request-headers": "authorization, dpop, content-type" } }))
    assert.equal(r.status, 204)
    assert.equal(r.headers.get("access-control-allow-origin"), CLIENT)
    for (const h of ["authorization", "dpop", "content-type"]) assert.ok(r.headers.get("access-control-allow-headers")!.split(", ").includes(h), h)
    for (const h of ["dpop-nonce", "www-authenticate"]) assert.ok(r.headers.get("access-control-expose-headers")!.split(", ").includes(h), h)
    assert.equal(r.headers.get("access-control-allow-credentials"), null)
    assert.match(r.headers.get("vary") ?? "", /origin/)
  })

  test("another origin gets no allow header, on the preflight and on the call", async () => {
    const pre = await app.fetch(new Request(RES, { method: "OPTIONS", headers: { origin: "https://evil.test", "access-control-request-method": "POST" } }))
    assert.equal(pre.headers.get("access-control-allow-origin"), null)
    const device = await deviceKey()
    const r = await call(app, { origin: "https://evil.test", ...(await dpop(await core.appToken({ company: "co-1", sub: "pw", device }), device)) })
    assert.equal(r.headers.get("access-control-allow-origin"), null)
  })

  test("the answers a client must read carry the headers: a call, and a 401 with its nonce", async () => {
    const device = await deviceKey()
    const t = await core.appToken({ company: "co-1", sub: "pw", device })
    const ok = await call(app, { origin: CLIENT, ...(await dpop(t, device)) })
    assert.equal(ok.headers.get("access-control-allow-origin"), CLIENT)
    const refused = await call(app, { origin: CLIENT, ...(await dpop(t, device, { iat: Math.floor(Date.now() / 1000) - 900 })) })
    assert.equal(refused.status, 401)
    assert.equal(refused.headers.get("access-control-allow-origin"), CLIENT)
    assert.ok(refused.headers.get("access-control-expose-headers")!.includes("dpop-nonce"))
  })
})

describe("agents: delegated, automation and device-agent tokens", () => {
  test("a delegated call: the actor is the server, the proof is the server's key, the token is for one call", async () => {
    const app = makeApp()
    const node = await deviceKey()
    const person = await deviceKey()
    const delegated = { company: "co-1", sub: "pw-ada", device: node, act: "server:node-1", personJkt: person.jkt }
    const c = await testClient(app, { token: () => core.appToken(delegated), dpop: { key: node, htu: RES } })
    assert.deepEqual(dataOf(await c.call("whoami")).actor, { kind: "server", id: "node-1" })
    // One call per token: the same one again is refused.
    const fixed = await core.appToken(delegated)
    assert.equal((await call(app, await dpop(fixed, node))).status, 200)
    assert.equal((await call(app, await dpop(fixed, node))).status, 401)
    assert.equal((await call(app, await dpop(await core.appToken(delegated), person))).status, 401, "a proof by the person's key, not the server's")
    assert.equal((await call(app, await dpop(await core.appToken({ ...delegated, lifetime: 600 }), node))).status, 401, "a server's token lives a minute")
    assert.equal((await call(app, await dpop(await core.appToken({ ...delegated, act: "robot:x" }), node))).status, 401, "an actor this app does not know")
    assert.equal((await call(app, await dpop(await core.appToken({ ...delegated, personJkt: undefined }), node))).status, 401, "a delegated token names the person's device")
  })

  test("an automation run: only the tools the person consented to", async () => {
    const app = makeApp()
    const node = await deviceKey()
    const c = await testClient(app, { token: () => core.appToken({ company: "co-1", sub: "pw-ada", device: node, act: "server:node-1", grant: "grant-1", tools: ["whoami"], role: "admin" }), dpop: { key: node, htu: RES } })
    assert.ok(!(await c.call("whoami")).isError)
    assert.equal(errorOf(await c.call("note_close", { id: "n1" }))?.code, "permission_denied")
  })

  test("a device agent: the actor is the device's agent", async () => {
    const app = makeApp()
    const mac = await deviceKey()
    const c = await testClient(app, { token: () => core.appToken({ company: "co-1", sub: "pw-ada", device: mac, act: `device-agent:${mac.jkt}` }), dpop: { key: mac, htu: RES } })
    assert.deepEqual(dataOf(await c.call("whoami")).actor, { kind: "device-agent", id: mac.jkt })
  })
})

describe("confirmations (H2)", () => {
  const company = "co-confirm"
  const args = { id: "n1" }

  /** A delegated client of a company administrator, and what it takes to confirm. */
  async function setup() {
    const app = makeApp()
    const node = await deviceKey()
    const person = await deviceKey()
    const c = await testClient(app, { token: () => core.appToken({ company, sub: "pw-ada", role: "admin", device: node, act: "server:node-1", personJkt: person.jkt }), dpop: { key: node, htu: RES } })
    const confirmed = async (over: Partial<Parameters<typeof core.confirmation>[0]> = {}, signer: DeviceKey = person) => {
      const token = await core.confirmation({ company, sub: "pw-ada", tool: "note_close", args, device: person, ...over })
      return { token, proof: await signer.confirm(token) }
    }
    return { c, confirmed }
  }
  const codeOf = async (c: Awaited<ReturnType<typeof testClient>>, confirmation?: unknown) => errorOf(await c.call("note_close", args, confirmation === undefined ? {} : { clegra: { confirmation } }))?.code ?? "ok"

  test("required for a sensitive tool an agent calls; the person's device-signed confirmation lets it run once", async () => {
    const { c, confirmed } = await setup()
    data.delete(`${company}@${ISS}`)
    const asked = await c.call("note_close", args)
    assert.equal(errorOf(asked)?.code, "confirmation_required")
    assert.deepEqual((asked.structuredContent as { error: { confirm: { tool: string; input: unknown } } }).error.confirm.input, args)
    const good = await confirmed()
    assert.equal(await codeOf(c, good), "ok")
    assert.equal(notesOf(`${company}@${ISS}`).get("n1")!.status, "done")
    assert.equal(await codeOf(c, good), "confirmation_required", "a confirmation is used once")
    assert.equal(await codeOf(c, { token: good.token, proof: await (await deviceKey()).confirm(good.token) }), "confirmation_required")
  })

  test("refused: other arguments, another tool, another app, someone else, another company, a forged one, another key's proof, a proof for another token", async () => {
    const { c, confirmed } = await setup()
    const stranger = await deviceKey()
    const forger = await core.keyPair("a-forged")
    const other = await confirmed()
    const cases: [string, unknown][] = [
      ["other arguments", await confirmed({ args: { id: "n2" } })],
      ["another tool", await confirmed({ tool: "note_reopen" })],
      ["another app", await confirmed({ aud: "https://other.test/mcp" })],
      ["someone else", await confirmed({ sub: "pw-bob" })],
      ["another company", await confirmed({ company: "co-other" })],
      ["signed by a key the core does not publish", await confirmed({ signer: forger })],
      ["a proof by another key", await confirmed({}, stranger)],
      ["for another device than the person's", await confirmed({ device: stranger }, stranger)],
      ["a proof over another token", { token: (await confirmed()).token, proof: other.proof }],
      ["too long-lived", await confirmed({ lifetime: 3600 })],
      ["no proof at all", { token: other.token }],
    ]
    for (const [why, confirmation] of cases) assert.equal(await codeOf(c, confirmation), "confirmation_required", why)
  })

  test("a device agent's confirmation is the same device's", async () => {
    const app = makeApp()
    const mac = await deviceKey()
    const c = await testClient(app, { token: () => core.appToken({ company, sub: "pw-ada", role: "admin", device: mac, act: `device-agent:${mac.jkt}` }), dpop: { key: mac, htu: RES } })
    const token = await core.confirmation({ company, sub: "pw-ada", tool: "note_close", args, device: mac })
    assert.equal(await codeOf(c, { token, proof: await mac.confirm(token) }), "ok")
  })

  test("the person from a Clegra client: the UI that sends the call asked them, and says so", async () => {
    const app = makeApp()
    const c = await core.client(app, { company, sub: "pw-ada", role: "admin" })
    const asked = await c.call("note_close", args)
    assert.equal(errorOf(asked)?.code, "confirmation_required")
    assert.match(errorOf(asked)!.message, /_meta\.clegra\.confirmed/)
    assert.ok(!(await c.call("note_close", args, { clegra: { confirmed: true } })).isError)
  })
})

describe("roles: company_role, the app's own grants, «who has what» (M1)", () => {
  test("a company administrator is an app administrator; a member has the defaults until granted more", async () => {
    const store = new MemoryStore()
    const app = makeApp({}, {}, store)
    const admin = await core.client(app, { company: "co-roles", sub: "pw-admin", name: "Ada Admin", role: "admin" })
    const member = await core.client(app, { company: "co-roles", sub: "pw-bob", name: "Bob Member", role: "member" })
    assert.deepEqual(dataOf(await admin.call("whoami")).permissions, ["notes.edit", "notes.view"])
    assert.equal(dataOf(await admin.call("whoami")).admin, true)
    assert.deepEqual(dataOf(await member.call("whoami")).permissions, ["notes.view"])
    assert.ok(!(await member.listTools()).some((t) => t.name === "note_close"), "a write the member may not do is not listed")
    assert.ok((await member.call("note_close", { id: "n1" }, { clegra: { confirmed: true } })).isError)
    // The administrator assigns, through the app's own page (app.roles); the next call counts it.
    await app.roles.assign(`co-roles@${ISS}`, "pw-bob", { permissions: ["notes.view", "notes.edit"] })
    assert.deepEqual(dataOf(await member.call("whoami")).permissions, ["notes.edit", "notes.view"])
    await assert.rejects(app.roles.assign(`co-roles@${ISS}`, "pw-bob", { permissions: ["notes.everything"] }), /Not permissions of this app/)
    // «Who has what»: the administrator's read-only tool; never a member's.
    assert.ok((await admin.listTools()).some((t) => t.name === "clegra_roles" && t.annotations?.readOnlyHint === true))
    assert.ok(!(await member.listTools()).some((t) => t.name === "clegra_roles"))
    const who = (await admin.call("clegra_roles")).structuredContent as { people: { sub: string; name: string; companyRole: string; admin: boolean; permissions: string[]; source: string }[] }
    assert.deepEqual(
      who.people.map((p) => [p.sub, p.name, p.companyRole, p.admin, p.permissions.join(","), p.source]),
      [
        ["pw-admin", "Ada Admin", "admin", true, "notes.edit,notes.view", "company-admin"],
        ["pw-bob", "Bob Member", "member", false, "notes.edit,notes.view", "assigned"],
      ],
    )
  })

  test("an app may say a company administrator is a member inside it", async () => {
    const app = makeApp({ companyAdmin: "member" })
    const admin = await core.client(app, { company: "co-roles-2", sub: "pw-admin", role: "admin" })
    const me = dataOf(await admin.call("whoami"))
    assert.deepEqual([me.admin, me.permissions], [false, ["notes.view"]])
    // Granted the app's administration by the app itself: every permission.
    await app.roles.assign(`co-roles-2@${ISS}`, "pw-admin", { admin: true })
    assert.deepEqual(dataOf(await admin.call("whoami")).permissions, ["notes.edit", "notes.view"])
  })

  test("a rate limit per person", async () => {
    const app = makeApp()
    const c = await core.client(app, { company: "co-rate", sub: "pw-ada" })
    assert.ok(!(await c.call("ping")).isError)
    assert.ok(!(await c.call("ping")).isError)
    const third = await c.call("ping")
    assert.equal(errorOf(third)?.code, "rate_limited")
    const other = await core.client(app, { company: "co-rate", sub: "pw-bob" })
    assert.ok(!(await other.call("ping")).isError, "another person has their own")
  })
})

describe("events (H3, M4)", () => {
  test("member.removed: the person's roles are dropped, what was issued to them is refused, the app's handler hears it once", async () => {
    const store = new MemoryStore()
    const app = makeApp({}, {}, store)
    const device = await deviceKey()
    const tenant = `co-events@${ISS}`
    const before = await core.appToken({ company: "co-events", sub: "pw-bob", device })
    await core.client(app, { company: "co-events", sub: "pw-bob" }).then((c) => c.call("whoami"))
    await app.roles.assign(tenant, "pw-bob", { permissions: ["notes.edit"] })
    heard.length = 0
    const event = await core.event("member.removed", { company: "co-events", sub: "pw-bob" })
    assert.equal((await core.deliver(app, event)).status, 204)
    assert.equal((await core.deliver(app, event)).status, 204, "a retry of a handled event")
    assert.equal(heard.filter((h) => h.event?.kind === "member.removed").length, 1)
    assert.deepEqual(heard[0]!.event, { id: heard[0]!.event!.id, kind: "member.removed", at: heard[0]!.event!.at, company: "co-events", tenant, sub: "pw-bob" })
    assert.equal(await store.roles.get(tenant, "pw-bob"), null)
    assert.equal((await call(app, await dpop(before, device))).status, 401, "a token issued before the removal")
    const after = await core.appToken({ company: "co-events", sub: "pw-bob", device, iat: Math.floor(Date.now() / 1000) + 2 })
    assert.equal((await call(app, await dpop(after, device))).status, 200, "a new token, issued after (the person was added again)")
    assert.equal((await call(app, await dpop(await core.appToken({ company: "co-events", sub: "pw-ada", device }), device))).status, 200, "someone else is not touched")
  })

  test("a person seen before an app.uninstalled is seen again after it (the permissions page lists them)", async () => {
    const store = new MemoryStore()
    const app = makeApp({}, {}, store)
    const device = await deviceKey()
    const tenant = `co-again@${ISS}`
    const first = await core.appToken({ company: "co-again", sub: "pw-eva", device })
    assert.equal((await call(app, await dpop(first, device))).status, 200)
    assert.ok((await store.roles.list(tenant)).some((g) => g.sub === "pw-eva"))
    const at = new Date(Date.now() - 2000).toISOString()
    assert.equal((await core.deliver(app, await core.event("app.uninstalled", { company: "co-again", installation: "inst-a", at }))).status, 204)
    assert.deepEqual(await store.roles.list(tenant), [])
    const again = await core.appToken({ company: "co-again", sub: "pw-eva", device })
    assert.equal((await call(app, await dpop(again, device))).status, 200)
    assert.ok((await store.roles.list(tenant)).some((g) => g.sub === "pw-eva"), "not seen again after the reinstall")
  })

  test("an event refuses what was issued before it happened, not before it arrived (a late delivery)", async () => {
    const store = new MemoryStore()
    const app = makeApp({}, {}, store)
    const device = await deviceKey()
    const now = Math.floor(Date.now() / 1000)
    const before = await core.appToken({ company: "co-late", sub: "pw-bob", device, iat: now - 5 })
    const after = await core.appToken({ company: "co-late", sub: "pw-bob", device, iat: now - 1 })
    // Uninstalled 3 s ago and installed again since: the uninstall arrives only now (the core's outbox retried it).
    const at = new Date((now - 3) * 1000).toISOString()
    assert.equal((await core.deliver(app, await core.event("app.uninstalled", { company: "co-late", installation: "inst-late", at }))).status, 204)
    assert.equal((await call(app, await dpop(before, device))).status, 401)
    assert.equal((await call(app, await dpop(after, device))).status, 200)
    // An older event arriving even later never moves the line back.
    assert.equal((await core.deliver(app, await core.event("company.suspended", { company: "co-late", at: new Date((now - 60) * 1000).toISOString() }))).status, 204)
    assert.equal((await call(app, await dpop(after, device))).status, 200)
    // member.removed the same way: the person's tokens issued after it count.
    const removedAt = new Date((now - 3) * 1000).toISOString()
    const ada1 = await core.appToken({ company: "co-late2", sub: "pw-ada", device, iat: now - 5 })
    const ada2 = await core.appToken({ company: "co-late2", sub: "pw-ada", device, iat: now - 1 })
    assert.equal((await core.deliver(app, await core.event("member.removed", { company: "co-late2", sub: "pw-ada", at: removedAt }))).status, 204)
    assert.equal((await call(app, await dpop(ada1, device))).status, 401)
    assert.equal((await call(app, await dpop(ada2, device))).status, 200)
  })

  test("app.installed, app.unassigned, app.uninstalled and company.suspended: the lifecycle hook, roles and tokens", async () => {
    const store = new MemoryStore()
    const app = makeApp({}, {}, store)
    const device = await deviceKey()
    heard.length = 0
    assert.equal((await core.deliver(app, await core.event("app.installed", { company: "co-life", installation: "inst-1" }))).status, 204)
    assert.deepEqual(heard, [{ state: "enabled", tenant: `co-life@${ISS}` }])
    await app.roles.assign(`co-life@${ISS}`, "pw-bob", { permissions: ["notes.edit"] })
    const token = await core.appToken({ company: "co-life", sub: "pw-bob", device })
    assert.equal((await core.deliver(app, await core.event("app.uninstalled", { company: "co-life", installation: "inst-1" }))).status, 204)
    assert.deepEqual(heard.at(-1), { state: "uninstalled", tenant: `co-life@${ISS}` })
    assert.deepEqual(await store.roles.list(`co-life@${ISS}`), [])
    assert.equal((await call(app, await dpop(token, device))).status, 401)
    assert.equal((await core.deliver(app, await core.event("app.unassigned", { company: "co-life-2" }))).status, 204)
    assert.deepEqual(heard.at(-1), { state: "disabled", tenant: `co-life-2@${ISS}` })
    const suspendedToken = await core.appToken({ company: "co-susp", sub: "pw-ada", device })
    assert.equal((await core.deliver(app, await core.event("company.suspended", { company: "co-susp" }))).status, 204)
    assert.equal((await call(app, await dpop(suspendedToken, device))).status, 401)
  })

  test("refused: not the core's, another app's, an expired or long-lived one, the wrong typ, not POST", async () => {
    const app = makeApp()
    const forged = await core.event("member.removed", { company: "co-1", sub: "pw" }).then((jwt) => jwt.split(".").slice(0, 2).join(".") + ".AAAA")
    const cases: [string, string][] = [
      ["a broken signature", forged],
      ["another app", await core.event("member.removed", { company: "co-1", sub: "pw", aud: "https://other.test/mcp" })],
      ["long-lived", await core.event("member.removed", { company: "co-1", sub: "pw", lifetime: 3600 })],
      ["the wrong typ", await core.event("member.removed", { company: "co-1", sub: "pw", typ: "clegra-app+jwt" })],
      ["member.removed without its person", await core.event("member.removed", { company: "co-1" })],
    ]
    for (const [why, jwt] of cases) assert.equal((await core.deliver(app, jwt)).status, 401, why)
    assert.equal((await app.fetch(new Request("https://notes.test/clegra/events"))).status, 405)
  })

  test("a handler that fails: 500, so the core retries, and the retry is handled", async () => {
    let fail = true
    const app = makeApp({ events: { "app.installed": () => {
      if (fail) throw new Error("not now")
    } } })
    const event = await core.event("app.installed", { company: "co-retry" })
    const original = console.error
    console.error = () => {}
    try {
      assert.equal((await core.deliver(app, event)).status, 500)
    } finally {
      console.error = original
    }
    fail = false
    assert.equal((await core.deliver(app, event)).status, 204)
  })
})
