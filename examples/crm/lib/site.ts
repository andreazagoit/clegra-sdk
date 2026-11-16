// The CRM's public address: ONE variable, CLEGRA_PUBLIC_URL (an origin, e.g. https://crm.example.com).
// better-auth runs under it (issuer <origin>/api/auth), the MCP server is <origin>/mcp, and the clegra
// route (clegra/next) reads the same variable. Read on use, never at import (a build has no secrets).

const LOCAL_ORIGIN = "http://localhost:3920"
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"])

export function publicOrigin(env: Record<string, string | undefined> = process.env): string {
  const raw = env.CLEGRA_PUBLIC_URL?.trim()
  if (!raw) {
    if (env.NODE_ENV === "production") throw new Error("CLEGRA_PUBLIC_URL is not set: the CRM's public origin (https://…) is needed in production.")
    return LOCAL_ORIGIN
  }
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`CLEGRA_PUBLIC_URL "${raw}" is not a URL`)
  }
  if (url.pathname !== "/" || url.search || url.hash || url.username || url.password) throw new Error(`CLEGRA_PUBLIC_URL must be an origin only (https://host[:port]), not "${raw}"`)
  // http only off production (localhost, or e.g. http://host.docker.internal:3920 for a host running in Docker).
  if (url.protocol !== "https:" && !(url.protocol === "http:" && (env.NODE_ENV !== "production" || LOOPBACK.has(url.hostname)))) throw new Error(`CLEGRA_PUBLIC_URL must be https in production: "${raw}"`)
  return url.origin
}

/** The MCP server's address: the audience of its access tokens (RFC 8707), and what hosts install. */
export const mcpResource = (env?: Record<string, string | undefined>) => `${publicOrigin(env)}/mcp`

/** better-auth's base URL: the OAuth issuer named in the MCP server's metadata. */
export const authIssuer = (env?: Record<string, string | undefined>) => `${publicOrigin(env)}/api/auth`
