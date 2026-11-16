/**
 * The site's public address, from one variable: CLEGRA_PUBLIC_URL (an origin, `https://warehouse.example.com`).
 * better-auth runs under it (`<origin>/api/auth`, its issuer) and MCP is at `<origin>/mcp` (the access tokens'
 * audience). Locally it defaults to http://localhost:3930; in production it is required.
 */
export const LOCAL_URL = "http://localhost:3930"

export function publicUrl(): string {
  const value = process.env.CLEGRA_PUBLIC_URL
  if (!value) {
    if (process.env.NODE_ENV === "production") throw new Error("CLEGRA_PUBLIC_URL is not set. In production give the site's public origin, e.g. https://warehouse.example.com.")
    return LOCAL_URL
  }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`CLEGRA_PUBLIC_URL "${value}" is not a URL`)
  }
  if (!/^https?:$/.test(url.protocol) || (url.pathname !== "/" && url.pathname !== "") || url.search || url.hash || url.username) throw new Error(`CLEGRA_PUBLIC_URL "${value}" must be an origin only, like https://warehouse.example.com`)
  return url.origin
}

/** The MCP server's address: the resource access tokens are issued for (RFC 8707). */
export const mcpResource = () => `${publicUrl()}/mcp`
