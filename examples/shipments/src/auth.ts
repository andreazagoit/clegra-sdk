import { clegraFromEnv, type AuthOptions, type ClegraOptions } from "@clegra/sdk"

/**
 * WHO MAY CALL: the people of the Clegra companies that installed the app, through Clegra's core, in Clegra apps'
 * trusted-issuer mode (spec §7, «Clegra tokens»). The SDK verifies the core's tokens itself: signed by the core's
 * `app` keys, `aud` exactly this server's MCP address, bound to the caller's key (DPoP).
 *
 * SEVERAL COMPANIES PER SERVER: a courier hosts one server for all its customers. The tenant is
 * `<company>@<issuer>`: two companies never reach each other's shipments. Which companies may use it is the
 * courier's list (CLEGRA_ALLOWED_COMPANIES), or `any`.
 *
 *   SHIPMENTS_PUBLIC_URL          the address the companies connect the app from (its MCP address is <url>/mcp)
 *   CLEGRA_ISSUER                 Clegra's core (required)
 *   CLEGRA_REGISTRATION_ID        the id the core gave this server when it was registered (required)
 *   CLEGRA_REGISTRATION_CHALLENGE the registration challenge, while the core verifies the address
 *   CLEGRA_ALLOWED_COMPANIES      the companies that may use it, separated by commas, or `any` (required)
 *   CLEGRA_CLIENT_ORIGINS         the Clegra clients' origins (CORS), separated by commas
 */
export function shipmentsAuth(env: Record<string, string | undefined> = process.env): AuthOptions & { resource: string; clegra: ClegraOptions } {
  const base = env.SHIPMENTS_PUBLIC_URL?.trim().replace(/\/+$/, "")
  if (!base) throw new Error("SHIPMENTS_PUBLIC_URL is not set: the address the companies connect Shipments from (its MCP address is <SHIPMENTS_PUBLIC_URL>/mcp)")
  let url: URL
  try {
    url = new URL(base)
  } catch {
    throw new Error(`SHIPMENTS_PUBLIC_URL: "${base}" is not an address`)
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error(`SHIPMENTS_PUBLIC_URL: "${base}" is not an http(s) address`)
  if (url.search || url.hash) throw new Error(`SHIPMENTS_PUBLIC_URL: "${base}" has a query or a fragment`)
  const clegra = clegraFromEnv(env)
  if (!clegra) throw new Error("CLEGRA_ISSUER is not set: Clegra's core, whose tokens this server accepts")
  if (!clegra.registrationId) throw new Error("CLEGRA_REGISTRATION_ID is not set: the id Clegra's core gave this server when it was registered")
  if (!clegra.allowedCompanies) throw new Error("CLEGRA_ALLOWED_COMPANIES is not set: the companies that may use this server (ids separated by commas), or any")
  return { resource: `${base}/mcp`, clegra }
}
