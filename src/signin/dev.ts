/**
 * THE SIGN-IN MODULE IN DEVELOPMENT (`devSignIn`, spec §7 «Development»): the sign-in module over a login of test
 * people, with what development and tests need beside it:
 *
 * - **the dev login**: a page listing the test people that asks for a one-time code printed on the app's console (five
 *   wrong codes close it until the app restarts). Real MCP clients (Claude, ChatGPT, an inspector) link through the
 *   module's own OAuth flow, consent included, exactly as in production;
 * - **development tokens** (`dev.token`): an access token naming any person, permissions, installation and language,
 *   and optionally standing in for a **development workspace host** (`host: "workspace"`): such a host confirms writes
 *   with a signed proof (`dev.confirmation`, `clegra-confirm+jwt`) and calls the installation-level tools (schedules,
 *   later runs, the lifecycle) with no person. No production host has such tokens.
 *
 * Refused when NODE_ENV is `production`; its development tokens count only from callers on a loopback address (the
 * server checks it), its keys live in memory (everyone is signed out at restart). Web APIs only.
 */
import { decodeJwt, decodeProtectedHeader, exportJWK, generateKeyPair, jwtVerify, SignJWT, type CryptoKey, type JWTPayload } from "jose"

import { CONFIRMATION_TYPE, TOKEN_CLAIM } from "../../spec/src/protocol"
import { argsHash, AuthError, INSTALLATION, type ClientMetadataTransport, type Person } from "../auth"
import { randomToken, sameText, sha256 } from "../crypto"
import { isProduction } from "../env"
import { frameCookie, frameCookieName, readCookie } from "./cookies"
import { buildSignIn, type Login, type SignIn, type SignInAccount, type SignInApp } from "./module"
import { escapeHtml, hidden, page, pageLocale, textsOf } from "./pages"
import { MemorySignInStore } from "./store"

/** The issuer of development tokens and proofs, and the suffix of their tenants (`<installation>@clegra-dev`). */
export const DEV_ISSUER = "clegra-dev"
/** How long a development workspace host's token lives: it is for one request. */
export const HOST_TOKEN_SECONDS = 60
/** Wrong codes before the dev login closes until the app restarts. */
export const DEV_CODE_ATTEMPTS = 5

/** A test person: who they are, their installation (default the dev installation) and what they may do (default all). */
export type DevPerson = Person & { installation?: string; permissions?: readonly string[] | "all" }

export type DevSignInOptions = {
  /** The app's public origin while developing (default `http://localhost:3000`). */
  issuer?: string
  /** The app's MCP address (default `<issuer>/mcp`). */
  resource?: string
  /** The test people on the dev login (default one, «Test person», who may do everything). */
  people?: DevPerson[]
  /** Their installation, and the one development tokens are for unless they say (default `dev`). */
  installation?: string
  /** The one-time code the dev login asks for (default: random, printed when the app starts). */
  code?: string
  /** The origins of the clients that frame the app (as `createSignIn`'s). */
  clientOrigins?: string[]
  /** For tests: how client metadata documents are fetched. */
  clientMetadata?: ClientMetadataTransport
}

/** What a development token says, verified (`DevTools.verify`). */
export type DevCaller = { installation: string; person: Person | null; permissions: string[]; locale?: string; host: "workspace" | "plain"; subject: string; claims: JWTPayload }

/** The development side of a `devSignIn` (`signIn.dev`). */
export type DevTools = {
  /** The dev login's code. */
  readonly code: string
  readonly people: readonly DevPerson[]
  readonly installation: string
  /**
   * A development access token. `host: "workspace"` stands in for a development workspace host (it confirms writes
   * with proofs); `person: null` with it: the installation-level caller (schedules, later runs, lifecycle tools),
   * `sub` = `installation:<installation>`, no permissions unless given.
   */
  token(input?: { person?: string | Person | null; permissions?: readonly string[] | "all"; host?: "workspace" | "plain"; installation?: string; locale?: string }): Promise<string>
  /**
   * A development workspace host's confirmation proof for one call (what it signs after the person's «Confirm»): the
   * arguments as sent, the call id, and for an action with `later` the run's deadline (`until`, epoch seconds).
   */
  confirmation(input: { tool: string; args: Record<string, unknown>; call: string; person?: string; installation?: string; until?: number }): Promise<string>
  /** Whether a token is a development token (never handed to the module's own verification or `auth.resolve`). */
  issues(token: string): boolean
  /** A development token, verified for `resource`. Throws AuthError with the reason. */
  verify(token: string, resource: string): Promise<DevCaller>
  /**
   * Checks a confirmation proof for this caller, installation, tool, arguments (as received), call id and, for a later
   * run, its deadline. `at`: as of that moment (a stored proof, checked again when its run is due). Gives the proof's
   * `iat` when it holds, else why not.
   */
  checkConfirmation(
    proof: string,
    expected: { subject: string; installation: string; tool: string; args: unknown; call: string | null; until?: number },
    at?: Date,
  ): Promise<{ ok: true; iat: number } | { ok: false; why: string }>
}

const DEFAULT_PEOPLE: DevPerson[] = [{ id: "test-person", name: "Test person", permissions: "all" }]
const COOKIE = "dev_session"
const LOGIN_PATH = "/oauth/dev-login"

/**
 * The sign-in module for development: `createSignIn` over a login of test people, in memory, with development
 * tokens and confirmation proofs (`signIn.dev`). Refused when NODE_ENV is `production`.
 */
export function devSignIn(app: SignInApp, options: DevSignInOptions = {}): SignIn & { readonly dev: DevTools } {
  if (isProduction()) throw new Error("devSignIn is for development: it is refused when NODE_ENV is production (createSignIn is the sign-in for production)")
  const issuer = (options.issuer ?? "http://localhost:3000").replace(/\/$/, "")
  const resource = options.resource ?? `${issuer}/mcp`
  const installation = options.installation ?? "dev"
  if (!INSTALLATION.test(installation)) throw new Error("devSignIn installation must match [A-Za-z0-9._:-]{1,128}")
  const people = options.people?.length ? options.people : DEFAULT_PEOPLE
  const code = options.code ?? randomToken(6).replace(/[-_]/g, "x").slice(0, 8).toUpperCase()
  const store = new MemorySignInStore()
  const secure = new URL(issuer).protocol === "https:" || /^(localhost|127\.0\.0\.1|\[::1\])$/.test(new URL(issuer).hostname)
  const all = () => app.manifest().permissions.map((p) => p.id)
  const account = (p: DevPerson): SignInAccount => ({ id: p.id, name: p.name, installation: p.installation ?? installation })
  let wrong = 0

  const login: Login = {
    async session(request) {
      const token = readCookie(request, frameCookieName(COOKIE, secure))
      const id = token ? ((await store.get(`dev-session:${await sha256(token)}`)) as string | null) : null
      const person = id ? people.find((p) => p.id === id) : undefined
      return person ? account(person) : null
    },
    signInUrl: (returnTo) => `${LOGIN_PATH}?return=${encodeURIComponent(returnTo)}`,
    async fetch(request) {
      const url = new URL(request.url)
      if (url.pathname !== LOGIN_PATH) return null
      const locale = pageLocale(request, null, app.locale)
      const safe = (v: string | null) => (v && v.startsWith("/") && !v.startsWith("//") && !v.includes("\\") ? v : "/")
      const form = (returnTo: string, error = "", status = 200) =>
        page({
          title: `${textsOf(locale).signIn} (development)`,
          locale,
          status,
          frameAncestors: options.clientOrigins ?? [],
          body: `<h1>Development sign-in</h1><p class="m">Test people only. The code is printed on the app's console.</p>${error ? `<p class="e">${escapeHtml(error)}</p>` : ""}
<form method="post" action="${LOGIN_PATH}">${hidden({ return: returnTo })}<label for="person">Person</label><select id="person" name="person">${people.map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`).join("")}</select>
<label for="code">Code</label><input id="code" name="code" autocomplete="off" required autofocus><div class="b"><button class="p" type="submit">${escapeHtml(textsOf(locale).signIn)}</button></div></form>`,
        })
      if (request.method === "GET") return form(safe(url.searchParams.get("return")))
      if (request.method !== "POST") return new Response(null, { status: 405, headers: { allow: "GET, POST" } })
      const sent = new URLSearchParams(await request.text())
      const returnTo = safe(sent.get("return"))
      if (wrong >= DEV_CODE_ATTEMPTS) return form(returnTo, "Too many wrong codes: restart the app to sign in again.", 429)
      if (!sameText((sent.get("code") ?? "").trim().toUpperCase(), code.toUpperCase())) {
        if (++wrong >= DEV_CODE_ATTEMPTS) console.warn(`[clegra] dev sign-in closed after ${DEV_CODE_ATTEMPTS} wrong codes: restart the app to open it again`)
        return form(returnTo, "Wrong code.", 401)
      }
      const person = people.find((p) => p.id === sent.get("person"))
      if (!person) return form(returnTo, "Unknown person.", 400)
      const token = randomToken()
      await store.set(`dev-session:${await sha256(token)}`, person.id, 24 * 3600_000)
      return new Response(null, { status: 303, headers: { location: returnTo, "set-cookie": frameCookie({ name: COOKIE, value: token, secure, maxAgeSeconds: 24 * 3600 }), "cache-control": "no-store" } })
    },
  }

  const signIn = buildSignIn(app, {
    issuer,
    resource,
    login,
    store,
    clientOrigins: options.clientOrigins,
    ...(options.clientMetadata ? { clientMetadata: options.clientMetadata } : {}),
    permissionsOf: (a) => {
      const p = people.find((x) => x.id === a.id && (x.installation ?? installation) === a.installation)
      return p ? (p.permissions ?? "all") : null
    },
  }, true)

  // The development key: tokens and proofs, in memory.
  const key = generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true }).then(async ({ privateKey, publicKey }) => ({ privateKey, publicKey, kid: (await exportJWK(publicKey)).x!.slice(0, 16) }))
  const once = (k: string, ttl: number) => store.once(k, ttl)
  const signed = async (claims: Record<string, unknown>, typ: string, sub: string, seconds: number) => {
    const k = await key
    const now = Math.floor(Date.now() / 1000)
    return new SignJWT(claims).setProtectedHeader({ alg: "EdDSA", typ, kid: k.kid }).setIssuer(DEV_ISSUER).setAudience(resource).setSubject(sub).setIssuedAt(now).setExpirationTime(now + seconds).setJti(crypto.randomUUID()).sign(k.privateKey as CryptoKey)
  }

  const dev: DevTools = {
    code,
    people,
    installation,
    async token(input = {}) {
      const known = typeof input.person === "string" ? people.find((p) => p.id === input.person) : undefined
      const person = input.person === null ? null : typeof input.person === "object" ? input.person : (known ?? people[0]!)
      const granted = input.permissions ?? (person ? ((known ?? (typeof input.person === "object" ? undefined : people[0]))?.permissions ?? "all") : [])
      const permissions = granted === "all" ? all() : [...granted]
      const inst = input.installation ?? known?.installation ?? installation
      const host = input.host ?? "plain"
      const claim = { installation: inst, ...(person ? { person: { id: person.id, name: person.name } } : {}), permissions, ...(input.locale ? { locale: input.locale } : {}), host }
      return signed({ [TOKEN_CLAIM]: claim }, "at+jwt", person ? person.id : `installation:${inst}`, host === "workspace" ? HOST_TOKEN_SECONDS : 3600)
    },
    async confirmation(input) {
      const claims = { installation: input.installation ?? installation, tool: input.tool, args: await argsHash(input.args), call: input.call, ...(input.until !== undefined ? { until: input.until } : {}) }
      return signed(claims, CONFIRMATION_TYPE, input.person ?? people[0]!.id, 120)
    },
    issues(token) {
      try {
        return decodeJwt(token).iss === DEV_ISSUER && decodeProtectedHeader(token).typ === "at+jwt"
      } catch {
        return false
      }
    },
    async verify(token, aud) {
      let payload: JWTPayload
      try {
        ;({ payload } = await jwtVerify(token, (await key).publicKey, { issuer: DEV_ISSUER, typ: "at+jwt", audience: aud, clockTolerance: 30, requiredClaims: ["exp", "sub", "aud"] }))
      } catch (error) {
        const message = error instanceof Error ? error.message : "invalid token"
        throw new AuthError(/"aud"/.test(message) ? `the token is for another server (this one is ${aud})` : message)
      }
      const m = payload[TOKEN_CLAIM] as { installation?: unknown; person?: { id?: unknown; name?: unknown }; permissions?: unknown; locale?: unknown; host?: unknown } | undefined
      if (!m || typeof m.installation !== "string" || !INSTALLATION.test(m.installation)) throw new AuthError(`the token has no valid ${TOKEN_CLAIM}.installation`)
      const host = m.host === "workspace" ? "workspace" : "plain"
      if (host === "workspace") {
        // A workspace host signs a token per request: short, with an id, used once.
        if (typeof payload.jti !== "string" || typeof payload.iat !== "number") throw new AuthError("a workspace host's token needs jti and iat")
        if (payload.exp! - payload.iat > HOST_TOKEN_SECONDS) throw new AuthError(`a workspace host's token lives ${HOST_TOKEN_SECONDS} seconds at most`)
        const left = Math.max(1, payload.exp! + 30 - Math.floor(Date.now() / 1000))
        if (!(await once(`dev-jti:${payload.jti}`, left * 1000))) throw new AuthError("this token was already used (a workspace host's token is for one request)")
      }
      return {
        installation: m.installation,
        person: m.person && typeof m.person.id === "string" ? { id: m.person.id, name: String(m.person.name ?? "") } : null,
        permissions: Array.isArray(m.permissions) ? m.permissions.filter((p): p is string => typeof p === "string") : [],
        ...(typeof m.locale === "string" ? { locale: m.locale } : {}),
        host,
        subject: String(payload.sub ?? ""),
        claims: payload,
      }
    },
    async checkConfirmation(proof, expected, at) {
      const no = (why: string) => ({ ok: false as const, why })
      try {
        const { payload } = await jwtVerify(proof, (await key).publicKey, { typ: CONFIRMATION_TYPE, issuer: DEV_ISSUER, audience: resource, clockTolerance: 30, ...(at ? { currentDate: at } : {}) })
        if (typeof payload.iat !== "number" || typeof payload.exp !== "number" || payload.exp - payload.iat > 300) return no("a proof lives 5 minutes at most")
        if (payload.sub !== expected.subject) return no("the proof is for someone else")
        if (payload.installation !== expected.installation) return no("the proof is for another installation")
        if (payload.tool !== expected.tool) return no("the proof is for another tool")
        if (payload.args !== (await argsHash(expected.args))) return no("the proof is for other arguments")
        if (!expected.call || payload.call !== expected.call) return no("the proof is for another call")
        if (expected.until !== undefined && payload.until !== expected.until) return no("the proof is for another deadline")
        return { ok: true, iat: payload.iat }
      } catch (error) {
        return no(error instanceof Error ? error.message : "invalid proof")
      }
    },
  }
  return Object.assign(signIn, { dev })
}
