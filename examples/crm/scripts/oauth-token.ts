/**
 * An access token from the running CRM (better-auth is its authorization server), by the real
 * OAuth flow over HTTP — sign in → organization → authorize (PKCE, resource) → consent → token — for
 * `clegra check` against real URLs:
 *
 *   CLEGRA_OAUTH_EMAIL=alice@orbit.example CLEGRA_OAUTH_PASSWORD=… npm run --silent token -- http://localhost:3920
 *   npm run clegra:check -- http://localhost:3920 --token <that token>     (from the repository root)
 *
 * Arguments: <site URL> [--resource <MCP URL, default <site>/mcp>] [--org <organization id>].
 * Secrets only from the environment, never argv: CLEGRA_OAUTH_EMAIL + CLEGRA_OAUTH_PASSWORD, or
 * CLEGRA_OAUTH_COOKIE (a session cookie, `name=value`). Optional: CLEGRA_OAUTH_CLIENT_ID +
 * CLEGRA_OAUTH_REDIRECT_URI (an existing client; default: a public client created for the signed-in person).
 * The authorization server is read from the app's protected-resource metadata. Prints only the access token.
 */
import { oauthAccessToken } from "./oauth-flow"

const args = process.argv.slice(2)
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args.splice(i, 2)[1] : undefined
}
const resourceArg = flag("resource")
const org = flag("org")
const site = args[0]
const fail = (message: string): never => {
  console.error(`oauth-token: ${message}`)
  process.exit(1)
}
if (!site || args.length > 1) fail("usage: oauth-token <site URL> [--resource <MCP URL>] [--org <organization id>] (credentials in CLEGRA_OAUTH_EMAIL + CLEGRA_OAUTH_PASSWORD, or CLEGRA_OAUTH_COOKIE)")
const origin = new URL(site!).origin
const resource = resourceArg ?? `${origin}/mcp`
const { CLEGRA_OAUTH_EMAIL: email, CLEGRA_OAUTH_PASSWORD: password, CLEGRA_OAUTH_COOKIE: cookie, CLEGRA_OAUTH_CLIENT_ID: clientId, CLEGRA_OAUTH_REDIRECT_URI: redirectUri } = process.env
const signIn = email && password ? { email, password } : cookie ? { cookie } : fail("set CLEGRA_OAUTH_EMAIL and CLEGRA_OAUTH_PASSWORD, or CLEGRA_OAUTH_COOKIE")
if (Boolean(clientId) !== Boolean(redirectUri)) fail("CLEGRA_OAUTH_CLIENT_ID and CLEGRA_OAUTH_REDIRECT_URI go together")

const resourceUrl = new URL(resource)
const metadataUrl = `${resourceUrl.origin}/.well-known/oauth-protected-resource${resourceUrl.pathname}`
const metadata = await fetch(metadataUrl).then((r) => (r.ok ? (r.json() as Promise<{ resource?: string; authorization_servers?: string[] }>) : fail(`${metadataUrl}: ${r.status}`)))
const authBaseURL = metadata.authorization_servers?.[0] ?? fail(`${metadataUrl} names no authorization server`)
if (metadata.resource !== resource) console.error(`oauth-token: note — the metadata says the resource is ${metadata.resource}, asking for ${resource}`)

try {
  const result = await oauthAccessToken({ authBaseURL, resource, signIn, ...(org ? { organizationId: org } : {}), ...(clientId && redirectUri ? { client: { clientId, redirectUri } } : {}) })
  console.error(`oauth-token: token for ${resource}, organization ${result.organizationId}, client ${result.clientId}, expires in ${result.expiresIn ?? "?"} s`)
  console.log(result.accessToken)
} catch (error) {
  fail(error instanceof Error ? error.message : String(error))
}
