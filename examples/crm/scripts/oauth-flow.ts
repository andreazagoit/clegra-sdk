import { createHash, randomBytes } from "node:crypto"

/**
 * The OAuth 2.1 authorization-code flow with PKCE (S256) against a better-auth instance with the mcp plugin, as a
 * person signs in and agrees, step by step over HTTP: sign in → (organization) → authorize → consent → token.
 * `fetch` is the global one for a running site, or `auth.handler` in-process. For the tests and for
 * `npm run token` (scripts/oauth-token.ts): a token for `clegra check` against a running CRM.
 *
 * The consent is given by POST /oauth2/consent { accept: true, oauth_query } — what an app's consent page does —
 * for whichever page the authorize step redirects to (post-login or consent): the organization was made active
 * first, so `consentReferenceId` already knows it.
 */
export type OAuthFlowOptions = {
  /** The better-auth base URL, its issuer: `https://crm.example.com/api/auth`. */
  authBaseURL: string
  /** The MCP server's public address: the token's audience (RFC 8707). */
  resource: string
  /** Sign-in: email + password, or an existing session cookie (`name=value; …`). */
  signIn: { email: string; password: string } | { cookie: string }
  /** The organization to connect (default: the person's only one; an error when they have several). */
  organizationId?: string
  /** An existing client (e.g. a metadata-document client id). Default: a public native client (loopback redirect, never contacted) created for the signed-in person (`/oauth2/create-client`). */
  client?: { clientId: string; redirectUri: string }
  /** Default `clegra`. */
  scope?: string
  fetch?: (request: Request) => Promise<Response>
}

export type OAuthFlowResult = { accessToken: string; refreshToken?: string; expiresIn?: number; scope?: string; clientId: string; redirectUri: string; cookie: string; organizationId: string }

const b64url = (bytes: Buffer) => bytes.toString("base64url")

/** A tiny cookie jar: what set-cookie said, sent back as one cookie header. */
class Jar {
  readonly #cookies = new Map<string, string>()
  constructor(initial?: string) {
    for (const part of (initial ?? "").split(";")) {
      const [name, ...value] = part.trim().split("=")
      if (name) this.#cookies.set(name, value.join("="))
    }
  }
  take(response: Response) {
    for (const line of response.headers.getSetCookie()) {
      const [pair] = line.split(";")
      const [name, ...value] = pair!.trim().split("=")
      if (!name) continue
      const v = value.join("=")
      if (v === "" || /max-age=0/i.test(line)) this.#cookies.delete(name)
      else this.#cookies.set(name, v)
    }
  }
  get header() {
    return [...this.#cookies].map(([k, v]) => `${k}=${v}`).join("; ")
  }
}

export async function oauthAccessToken(options: OAuthFlowOptions): Promise<OAuthFlowResult> {
  const doFetch = options.fetch ?? ((r: Request) => fetch(r))
  const base = options.authBaseURL.replace(/\/+$/, "")
  const origin = new URL(base).origin
  const jar = new Jar("cookie" in options.signIn ? options.signIn.cookie : undefined)
  const call = async (path: string, init: { method?: string; json?: unknown; form?: Record<string, string>; query?: Record<string, string> } = {}) => {
    const url = new URL(base + path)
    for (const [k, v] of Object.entries(init.query ?? {})) url.searchParams.set(k, v)
    const headers: Record<string, string> = { origin, accept: "application/json" }
    if (jar.header) headers.cookie = jar.header
    let body: string | undefined
    if (init.json !== undefined) ((headers["content-type"] = "application/json"), (body = JSON.stringify(init.json)))
    if (init.form) ((headers["content-type"] = "application/x-www-form-urlencoded"), (body = new URLSearchParams(init.form).toString()))
    const response = await doFetch(new Request(url, { method: init.method ?? (body ? "POST" : "GET"), headers, ...(body ? { body } : {}), redirect: "manual" }))
    jar.take(response)
    return response
  }
  const json = async (response: Response, what: string) => {
    const text = await response.text()
    if (!response.ok) throw new Error(`${what}: ${response.status} ${text.slice(0, 500)}`)
    return (text ? JSON.parse(text) : null) as Record<string, unknown>
  }

  // 1. A session.
  if ("email" in options.signIn) await json(await call("/sign-in/email", { json: { email: options.signIn.email, password: options.signIn.password } }), "sign in")
  const session = await json(await call("/get-session"), "session")
  if (!session?.user) throw new Error("sign in: no session (wrong password, or the cookie has expired)")

  // 2. The organization the connection is for, made active (consentReferenceId reads it).
  const orgs = (await json(await call("/organization/list"), "organizations")) as unknown as { id: string; name: string }[]
  const organizationId = options.organizationId ?? (orgs.length === 1 ? orgs[0]!.id : null)
  if (!organizationId) throw new Error(`choose an organization (organizationId): the person belongs to ${orgs.map((o) => `${o.name} (${o.id})`).join(", ") || "none"}`)
  await json(await call("/organization/set-active", { json: { organizationId } }), "set active organization")

  // 3. The client.
  let client = options.client
  if (!client) {
    const redirectUri = "http://127.0.0.1:8976/callback"
    const created = await json(
      await call("/oauth2/create-client", { json: { client_name: "CRM token script", redirect_uris: [redirectUri], application_type: "native", token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] } }),
      "create client",
    )
    client = { clientId: String(created.client_id), redirectUri }
  }

  // 4. Authorize (PKCE S256, the resource), then agree on whatever page it sends the person to.
  const verifier = b64url(randomBytes(32))
  const challenge = b64url(createHash("sha256").update(verifier).digest())
  const state = b64url(randomBytes(16))
  const query = { response_type: "code", client_id: client.clientId, redirect_uri: client.redirectUri, scope: options.scope ?? "clegra", state, code_challenge: challenge, code_challenge_method: "S256", resource: options.resource }
  let next = await locationOf(await call("/oauth2/authorize", { query }))
  for (let step = 0; step < 4 && !next.startsWith(client.redirectUri); step++) {
    const page = new URL(next, origin)
    if (!page.searchParams.has("sig")) throw new Error(`authorize: unexpected redirect to ${page.href}`)
    const answer = await json(await call("/oauth2/consent", { json: { accept: true, oauth_query: page.searchParams.toString() } }), "consent")
    // better-auth answers { redirect: true, url } (the address with the code, or the next page).
    if (typeof answer.url !== "string") throw new Error(`consent: no url in ${JSON.stringify(answer)}`)
    next = answer.url
  }
  const back = new URL(next)
  if (back.searchParams.get("error")) throw new Error(`authorize: ${back.searchParams.get("error")} ${back.searchParams.get("error_description") ?? ""}`)
  if (back.searchParams.get("state") !== state) throw new Error("authorize: state mismatch")
  const code = back.searchParams.get("code")
  if (!code) throw new Error(`authorize: no code in ${back.href}`)

  // 5. The token, for the resource.
  const tokens = await json(await call("/oauth2/token", { form: { grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: client.redirectUri, client_id: client.clientId, resource: options.resource } }), "token")
  return {
    accessToken: String(tokens.access_token),
    ...(typeof tokens.refresh_token === "string" ? { refreshToken: tokens.refresh_token } : {}),
    ...(typeof tokens.expires_in === "number" ? { expiresIn: tokens.expires_in } : {}),
    ...(typeof tokens.scope === "string" ? { scope: tokens.scope } : {}),
    clientId: client.clientId,
    redirectUri: client.redirectUri,
    cookie: jar.header,
    organizationId,
  }
}

async function locationOf(response: Response): Promise<string> {
  const location = response.headers.get("location")
  if (location) return location
  // better-auth answers JSON { redirect: true, url } to a fetch that asks for JSON.
  const text = await response.text()
  try {
    const body = JSON.parse(text) as { url?: unknown }
    if (typeof body.url === "string") return body.url
  } catch {}
  throw new Error(`authorize: ${response.status} ${text.slice(0, 500)}`)
}
