/**
 * An access token from the running CRM (better-auth is its authorization server), by the real
 * OAuth flow over HTTP — sign in → organization → authorize (PKCE, resource) → consent → token — for
 * `modelapp check` against real URLs:
 *
 *   MODELAPP_OAUTH_EMAIL=alice@orbit.example MODELAPP_OAUTH_PASSWORD=… npm run --silent token -- http://localhost:3920
 *   npm run modelapp:check -- http://localhost:3920 --token <that token>     (from the repository root)
 *
 * Arguments: <site URL> [--resource <MCP URL, default <site>/mcp>] [--org <organization id>].
 * Secrets only from the environment, never argv: MODELAPP_OAUTH_EMAIL + MODELAPP_OAUTH_PASSWORD, or
 * MODELAPP_OAUTH_COOKIE (a session cookie, `name=value`). Optional: MODELAPP_OAUTH_CLIENT_ID +
 * MODELAPP_OAUTH_REDIRECT_URI (an existing client; default: a public client created for the signed-in person).
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
if (!site || args.length > 1) fail("usage: oauth-token <site URL> [--resource <MCP URL>] [--org <organization id>] (credentials in MODELAPP_OAUTH_EMAIL + MODELAPP_OAUTH_PASSWORD, or MODELAPP_OAUTH_COOKIE)")
const origin = new URL(site!).origin
const resource = resourceArg ?? `${origin}/mcp`
const { MODELAPP_OAUTH_EMAIL: email, MODELAPP_OAUTH_PASSWORD: password, MODELAPP_OAUTH_COOKIE: cookie, MODELAPP_OAUTH_CLIENT_ID: clientId, MODELAPP_OAUTH_REDIRECT_URI: redirectUri } = process.env
const signIn = email && password ? { email, password } : cookie ? { cookie } : fail("set MODELAPP_OAUTH_EMAIL and MODELAPP_OAUTH_PASSWORD, or MODELAPP_OAUTH_COOKIE")
if (Boolean(clientId) !== Boolean(redirectUri)) fail("MODELAPP_OAUTH_CLIENT_ID and MODELAPP_OAUTH_REDIRECT_URI go together")

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
