import type { AuthOptions, Issuer } from "@clegra/sdk"

/**
 * WHO MAY CALL: the workspace hosts (Clegra nodes) of the companies that
 * installed the app, in Clegra apps' trusted-issuer mode (spec §7). The SDK
 * verifies their tokens itself: signed by the issuer's keys, `aud` exactly
 * this server's MCP address, one request each.
 *
 * SEVERAL COMPANIES PER SERVER: a courier hosts one server for all its
 * customers, so several issuers may be trusted (one per company's node). The
 * tenant is `<installation>@<issuer>`: two nodes never reach each other's
 * shipments, even with the same installation id.
 *
 *   SHIPMENTS_PUBLIC_URL  the address the nodes install the app from (its MCP address is <url>/mcp)
 *   CLEGRA_ISSUERS        the trusted nodes, separated by commas: `issuer` or `issuer|jwksUri`
 */
export function shipmentsAuth(env: Record<string, string | undefined> = process.env): AuthOptions & { resource: string; issuers: Issuer[] } {
  const base = env.SHIPMENTS_PUBLIC_URL?.trim().replace(/\/+$/, "")
  if (!base) throw new Error("SHIPMENTS_PUBLIC_URL is not set: the address the companies' nodes install Shipments from (its MCP address is <SHIPMENTS_PUBLIC_URL>/mcp)")
  let url: URL
  try {
    url = new URL(base)
  } catch {
    throw new Error(`SHIPMENTS_PUBLIC_URL: "${base}" is not an address`)
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error(`SHIPMENTS_PUBLIC_URL: "${base}" is not an http(s) address`)
  if (url.search || url.hash) throw new Error(`SHIPMENTS_PUBLIC_URL: "${base}" has a query or a fragment`)
  const entries = (env.CLEGRA_ISSUERS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
  if (!entries.length) throw new Error("CLEGRA_ISSUERS is not set: the companies' nodes this server trusts (`issuer` or `issuer|jwksUri`, separated by commas)")
  const issuers = entries.map((entry) => {
    const [issuer, jwksUri] = entry.split("|").map((s) => s.trim())
    if (!issuer) throw new Error(`CLEGRA_ISSUERS: "${entry}" has no issuer`)
    return { issuer, ...(jwksUri ? { jwksUri } : {}) }
  })
  const repeated = issuers.find((i, n) => issuers.findIndex((x) => x.issuer === i.issuer) !== n)
  if (repeated) throw new Error(`CLEGRA_ISSUERS: "${repeated.issuer}" is named twice`)
  return { resource: `${base}/mcp`, issuers }
}
