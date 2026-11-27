/**
 * THE SIGN-IN MODULE IN DEVELOPMENT (`devSignIn`): the sign-in module over a login of test people, with what
 * development and tests need beside it:
 *
 * - **the dev login**: a page listing the test people that asks for a one-time code printed on the app's console (five
 *   wrong codes close it until the app restarts). Real MCP clients link through the module's own OAuth flow, consent
 *   included, exactly as in production;
 * - **development tokens** (`dev.token`): an access token for a test person with the scopes a test needs, accepted by
 *   `verify` for requests to a loopback address only.
 *
 * Refused when NODE_ENV is `production`; its keys live in memory (everyone is signed out at restart). Web APIs only.
 */
import { decodeJwt, decodeProtectedHeader, exportJWK, generateKeyPair, jwtVerify, SignJWT, type CryptoKey, type JWTPayload } from "jose"

import { ALL_SCOPES } from "../access"
import type { App } from "../app"
import { AuthError, isLoopback, type ClientMetadataTransport } from "../auth"
import { randomToken, sameText, sha256 } from "../crypto"
import type { Person } from "../define"
import { isProduction } from "../env"
import { frameCookie, frameCookieName, readCookie, secureContext } from "./cookies"
import { buildSignIn, type Login, type SignIn } from "./module"
import { escapeHtml, hidden, page, pageLocale, textsOf } from "./pages"
import { MemorySignInStore } from "./store"

/** The issuer of development tokens. */
export const DEV_ISSUER = "clegra-dev"
/** Wrong codes before the dev login closes until the app restarts. */
export const DEV_CODE_ATTEMPTS = 5
/** The client a development token names unless the test says. */
export const DEV_CLIENT = "https://dev.clegra.invalid/client.json"

export type DevSignInOptions = {
  /** The app's public origin while developing (default `http://localhost:3000`). */
  issuer?: string
  /** The app's MCP address (default `<issuer>/mcp`). */
  resource?: string
  /** The test people on the dev login (default one, «Test person»). */
  people?: Person[]
  /** The one-time code the dev login asks for (default: random, printed when the app starts). */
  code?: string
  /** For tests: how client metadata documents are fetched. */
  clientMetadata?: ClientMetadataTransport
}

/** The development side of a `devSignIn` (`signIn.dev`). */
export type DevTools = {
  /** The dev login's code. */
  readonly code: string
  readonly people: readonly Person[]
  /**
   * A development access token: a test person (by id, or any person), the scopes (default all the app offers) and the
   * client it stands for. Its grant id is `dev:<person>:<client>`, revocable like any other.
   */
  token(input?: { person?: string | Person; scopes?: string[]; clientId?: string; clientName?: string }): Promise<string>
}

const DEFAULT_PEOPLE: Person[] = [{ id: "test-person", name: "Test person" }]
const COOKIE = "dev_session"
const LOGIN_PATH = "/oauth/dev-login"

/** The sign-in module for development: `createSignIn` over a login of test people, in memory, with development tokens. */
export function devSignIn(app: App, options: DevSignInOptions = {}): SignIn & { readonly dev: DevTools } {
  if (isProduction()) throw new Error("devSignIn is for development: it is refused when NODE_ENV is production (createSignIn is the sign-in for production)")
  const issuer = (options.issuer ?? "http://localhost:3000").replace(/\/$/, "")
  const resource = options.resource ?? `${issuer}/mcp`
  const people = options.people?.length ? options.people : DEFAULT_PEOPLE
  const code = options.code ?? randomToken(6).replace(/[-_]/g, "x").slice(0, 8).toUpperCase()
  const store = new MemorySignInStore()
  const secure = secureContext(issuer)
  let wrong = 0

  const login: Login = {
    async session(request) {
      const token = readCookie(request, frameCookieName(COOKIE, secure))
      const id = token ? ((await store.get(`dev-session:${await sha256(token)}`)) as string | null) : null
      return (id ? people.find((p) => p.id === id) : undefined) ?? null
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
          frameAncestors: [],
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

  const signIn = buildSignIn(app, { issuer, resource, login, store, ...(options.clientMetadata ? { clientMetadata: options.clientMetadata } : {}) }, true)

  const moduleVerify = signIn.verify
  const moduleRevoke = signIn.revokeGrant
  const key = generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true }).then(async ({ privateKey, publicKey }) => ({ privateKey, publicKey, kid: (await exportJWK(publicKey)).x!.slice(0, 16) }))
  const offered = ALL_SCOPES.filter((s) => s !== "browser_session" || Boolean(app.config.sessionTransfer?.link))
  const revoked = new Set<string>()

  const dev: DevTools = {
    code,
    people,
    async token(input = {}) {
      const person = typeof input.person === "object" ? input.person : (people.find((p) => p.id === input.person) ?? (input.person ? { id: input.person, name: input.person } : people[0]!))
      const clientId = input.clientId ?? DEV_CLIENT
      const k = await key
      const now = Math.floor(Date.now() / 1000)
      return new SignJWT({ scope: (input.scopes ?? offered).join(" "), client_id: clientId, ...(input.clientName ? { client_name: input.clientName } : {}), person })
        .setProtectedHeader({ alg: "EdDSA", typ: "at+jwt", kid: k.kid })
        .setIssuer(DEV_ISSUER)
        .setAudience(resource)
        .setSubject(person.id)
        .setIssuedAt(now)
        .setExpirationTime(now + 3600)
        .setJti(crypto.randomUUID())
        .sign(k.privateKey as CryptoKey)
    },
  }

  const verify: SignIn["verify"] = async (token, request, info) => {
    let iss: unknown
    try {
      iss = decodeJwt(token).iss
      decodeProtectedHeader(token)
    } catch {
      return null
    }
    if (iss !== DEV_ISSUER) return moduleVerify(token, request, info)
    // Development tokens count only on a request to a loopback address.
    const host = new URL(request.url).hostname.replace(/^\[|\]$/g, "")
    if (!isLoopback(host) && !/^[a-z0-9-]+(\.[a-z0-9-]+)*\.localhost$/i.test(host)) throw new AuthError("development tokens are accepted on a loopback address only (localhost, *.localhost, 127.0.0.1, [::1])")
    let payload: JWTPayload
    try {
      ;({ payload } = await jwtVerify(token, (await key).publicKey, { issuer: DEV_ISSUER, typ: "at+jwt", audience: info.resource, clockTolerance: 30, requiredClaims: ["exp", "sub", "aud"] }))
    } catch (error) {
      const message = error instanceof Error ? error.message : "invalid token"
      throw new AuthError(/"aud"/.test(message) ? `the token is for another server (this one is ${info.resource})` : message)
    }
    const person = payload.person as Person
    const clientId = String(payload.client_id)
    const id = `dev:${person.id}:${clientId}`
    if (revoked.has(id)) throw new AuthError("this access was revoked")
    return { id, clientId, ...(typeof payload.client_name === "string" ? { clientName: payload.client_name } : {}), person, scopes: String(payload.scope ?? "").split(" ").filter(Boolean) }
  }

  const revokeGrant: SignIn["revokeGrant"] = async (grant) => {
    if (grant.startsWith("dev:")) revoked.add(grant)
    else await moduleRevoke(grant)
  }

  return Object.assign(signIn, { verify, revokeGrant, dev })
}
