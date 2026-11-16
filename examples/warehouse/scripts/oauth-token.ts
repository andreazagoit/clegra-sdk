/**
 * npm run token -- <site URL> — an access token from a running warehouse, by the real OAuth flow over HTTP
 * (sign in → authorize with PKCE and `resource` → consent → token), for `clegra check`:
 *
 *   CLEGRA_TOKEN=$(npm run --silent token -- http://localhost:3930) npm run clegra:check -- http://localhost:3930
 *
 * Credentials only from the environment (or .env.local), never the command line: CLEGRA_OAUTH_EMAIL +
 * CLEGRA_OAUTH_PASSWORD; for a demo person CLEGRA_OAUTH_EMAIL alone, with DEMO_PASSWORD. Optional:
 * CLEGRA_OAUTH_CLIENT_ID + CLEGRA_OAUTH_REDIRECT_URI (an existing client; default a public client created
 * for the signed-in person). The authorization server is read from the site's protected-resource metadata.
 * Prints only the token (the rest goes to stderr).
 */
import { DEMO_USERS } from "../lib/demo"
import { oauthAccessToken } from "./oauth-flow"

const fail = (message: string): never => {
  console.error(`token: ${message}`)
  process.exit(1)
}
const args = process.argv.slice(2)
const site = args[0]
if (!site || args.length > 1) fail("usage: npm run token -- <site URL>   (credentials in CLEGRA_OAUTH_EMAIL + CLEGRA_OAUTH_PASSWORD)")
const origin = new URL(site!).origin
const resource = `${origin}/mcp`
const env = process.env
const email = env.CLEGRA_OAUTH_EMAIL ?? fail("set CLEGRA_OAUTH_EMAIL (and CLEGRA_OAUTH_PASSWORD, unless it is a demo person and DEMO_PASSWORD is set)")
const password = env.CLEGRA_OAUTH_PASSWORD || (DEMO_USERS.some((u) => u.email === email) ? env.DEMO_PASSWORD : undefined) || fail("set CLEGRA_OAUTH_PASSWORD")
if (Boolean(env.CLEGRA_OAUTH_CLIENT_ID) !== Boolean(env.CLEGRA_OAUTH_REDIRECT_URI)) fail("CLEGRA_OAUTH_CLIENT_ID and CLEGRA_OAUTH_REDIRECT_URI go together")

const metadataUrl = `${origin}/.well-known/oauth-protected-resource/mcp`
const metadata = await fetch(metadataUrl).then((r) => (r.ok ? (r.json() as Promise<{ resource?: string; authorization_servers?: string[] }>) : fail(`${metadataUrl}: ${r.status}`)))
const authBaseURL = metadata.authorization_servers?.[0] ?? fail(`${metadataUrl} names no authorization server`)
if (metadata.resource !== resource) fail(`the site says its MCP resource is ${metadata.resource}, not ${resource} (is CLEGRA_PUBLIC_URL the address you called?)`)

try {
  const client = env.CLEGRA_OAUTH_CLIENT_ID && env.CLEGRA_OAUTH_REDIRECT_URI ? { client: { clientId: env.CLEGRA_OAUTH_CLIENT_ID, redirectUri: env.CLEGRA_OAUTH_REDIRECT_URI } } : {}
  const result = await oauthAccessToken({ authBaseURL, resource, signIn: { email, password }, ...client })
  console.error(`token: for ${resource}, organization ${result.organizationId}, client ${result.clientId}, expires in ${result.expiresIn ?? "?"} s`)
  console.log(result.accessToken)
} catch (error) {
  fail(error instanceof Error ? error.message : String(error))
}
